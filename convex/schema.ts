import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"
import { authTables } from "@convex-dev/auth/server"

const seriousnessCriterion = v.union(
  v.literal("death"),
  v.literal("life_threatening"),
  v.literal("hospitalization"),
  v.literal("disability"),
  v.literal("congenital_anomaly"),
  v.literal("other_medically_important"),
)

export default defineSchema({
  ...authTables,

  // Overrides the base authTables.users shape to add the fields the
  // email-OTP sign-in flow needs (see convex/authz.ts for who's allowed in).
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
  }).index("email", ["email"]),

  // The safety team. Membership here is what grants both dashboard access
  // AND receipt of report notifications — one list serves both purposes,
  // matching how a real team inbox works. Managed from inside the
  // dashboard once at least one member exists (see convex/seed for how the
  // first one is added).
  safetyTeamRecipients: defineTable({
    email: v.string(),
    name: v.string(),
    active: v.boolean(),
    // Which company's team this person is on. Rows created before multi-company
    // support have no value and belong to the default company (see companyLib.ts).
    companyId: v.optional(v.id("companies")),
  }).index("by_email", ["email"]).index("by_companyId", ["companyId"]),

  // A safety-relevant adverse event report submitted through the intake
  // form. The four `is*`/`expedited*` fields are computed once, at
  // submission time, from the fields the reporter actually entered — see
  // convex/ae.ts's classify() for the rules and why they're frozen rather
  // than recomputed live (an audit trail of a safety decision must not
  // silently change after the fact, e.g. if reference safety data is later
  // updated for a different product).
  aeReports: defineTable({
    referenceNumber: v.string(), // e.g. "AE-2026-0001" — see convex/counters.ts
    productId: v.string(),
    productName: v.string(),
    patientAgeYears: v.optional(v.number()),
    patientSex: v.union(v.literal("male"), v.literal("female"), v.literal("unknown")),
    eventTerm: v.string(),
    eventDescription: v.string(),
    eventOnsetDate: v.string(),
    reporterName: v.string(),
    reporterEmail: v.string(),
    reporterType: v.union(v.literal("healthcare_professional"), v.literal("consumer"), v.literal("other")),
    causality: v.union(v.literal("related"), v.literal("possible"), v.literal("unrelated")),
    seriousnessCriteria: v.array(seriousnessCriterion),
    isSerious: v.boolean(),
    isExpected: v.boolean(),
    isExpedited: v.boolean(),
    expeditedDueAt: v.optional(v.number()),
    status: v.union(v.literal("new"), v.literal("in_review"), v.literal("reported"), v.literal("closed")),
    // Added after release 1, all optional so existing rows stay valid:
    // the canonical (synonym-normalised) event term used for classification
    // and duplicate matching; the earlier report this one probably repeats;
    // and the furthest deadline reminder already sent for this report.
    eventTermCanonical: v.optional(v.string()),
    possibleDuplicateOf: v.optional(v.id("aeReports")),
    lastEscalationStage: v.optional(v.union(v.literal("due_soon"), v.literal("overdue"))),
    // Owning company. Missing on reports created before multi-company support (= default company).
    companyId: v.optional(v.id("companies")),
  })
    .index("by_companyId", ["companyId"])
    .index("by_status", ["status"])
    .index("by_productId", ["productId"])
    .index("by_isExpedited_status", ["isExpedited", "status"])
    .index("by_referenceNumber", ["referenceNumber"])
    .index("by_reporterEmail", ["reporterEmail"]),

  // A per-report change log for status transitions — who (which signed-in
  // team email) changed what, and when. Append-only; nothing here is ever
  // edited or deleted, so it stays a genuine audit trail rather than just
  // the current state.
  auditLog: defineTable({
    reportId: v.id("aeReports"),
    actorEmail: v.string(),
    action: v.string(),
    fromValue: v.optional(v.string()),
    toValue: v.optional(v.string()),
  }).index("by_reportId", ["reportId"]),

  // Simple year-scoped counters backing human-readable reference numbers.
  // One document per year; incremented inside the same mutation that
  // creates the report, so two concurrent submissions can never collide
  // (Convex mutations are serialized transactions).
  counters: defineTable({
    key: v.string(), // e.g. "aeReports-2026"
    value: v.number(),
  }).index("by_key", ["key"]),

  // One task per report, created automatically at submission. Expedited
  // reports get an urgent task with the regulatory due date; everything
  // else gets a routine task for the next periodic report.
  tasks: defineTable({
    reportId: v.id("aeReports"),
    title: v.string(),
    dueAt: v.optional(v.number()),
    priority: v.union(v.literal("urgent"), v.literal("routine")),
    done: v.boolean(),
  })
    .index("by_reportId", ["reportId"])
    .index("by_done_dueAt", ["done", "dueAt"]),

  // One row per email actually attempted — a real outbound message, not a
  // simulated log line. `kind` distinguishes the three notification types
  // so the dashboard can show them separately; `status` records what
  // genuinely happened when convex/ae.ts's dispatchAlert called the
  // platform's transactional-email endpoint.
  alerts: defineTable({
    reportId: v.id("aeReports"),
    kind: v.union(
      v.literal("expedited_team_alert"),
      v.literal("routine_team_notice"),
      v.literal("reporter_confirmation"),
      v.literal("escalation_reminder"),
      v.literal("followup_query"),
    ),
    recipientEmail: v.string(),
    subject: v.string(),
    body: v.string(),
    status: v.union(v.literal("pending"), v.literal("sent"), v.literal("failed")),
    sentAt: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index("by_reportId", ["reportId"])
    .index("by_status", ["status"]),

  // Correspondence with the reporter about one report. Outbound messages go
  // out as real emails (see alertId); replies are not received automatically
  // (the platform email service is send-only), so the team logs them here.
  followUps: defineTable({
    reportId: v.id("aeReports"),
    direction: v.union(v.literal("to_reporter"), v.literal("from_reporter")),
    authorEmail: v.string(), // the signed-in team member who sent or logged it
    message: v.string(),
    alertId: v.optional(v.id("alerts")),
  }).index("by_reportId", ["reportId"]),

  // A demo company. Companies are fictional and self-service: a signed-in user
  // creates one and becomes its first team member. `accessToken` is the secret
  // in the team's private dashboard link; it is never returned by any public
  // query, and opening the link still requires being a member (defence in depth).
  companies: defineTable({
    name: v.string(),
    slug: v.string(),
    accessToken: v.string(),
    isDefault: v.boolean(), // the original demo company that owns the legacy Products A-C data
    createdByEmail: v.string(),
  })
    .index("by_slug", ["slug"])
    .index("by_accessToken", ["accessToken"])
    .index("by_isDefault", ["isDefault"])
    .index("by_createdByEmail", ["createdByEmail"]),

  // Products a company collects reports for (the default company uses the
  // built-in Products A-C from pvReferenceData.ts instead).
  companyProducts: defineTable({
    companyId: v.id("companies"),
    name: v.string(),
    description: v.string(),
    knownEvents: v.array(v.string()), // the product's reference safety information
  }).index("by_companyId", ["companyId"]),
})
