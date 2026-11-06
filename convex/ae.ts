import { v } from "convex/values"
import { query, mutation, internalMutation, internalAction, internalQuery } from "./_generated/server"
import type { QueryCtx, MutationCtx } from "./_generated/server"
import { internal } from "./_generated/api"
import { getAuthUserId } from "@convex-dev/auth/server"
import { PRODUCTS, findProduct, canonicalTerm, eventTermSuggestions } from "./pvReferenceData"
import { nextReferenceNumber } from "./counters"
import { checkIsTeamMember } from "./authz"
import { companyRecipients, getDefaultCompany, resolveProduct } from "./companyLib"

// ---------------------------------------------------------------------------
// Classification rules. These mirror real pharmacovigilance concepts
// (ICH E2A) at a level appropriate for a portfolio demonstration:
//
//  - SERIOUS:    at least one seriousness criterion is checked.
//  - EXPECTED:   the reported event term already appears in the product's
//                reference safety information ("label"). Anything not
//                listed there is UNEXPECTED.
//  - EXPEDITED:  serious AND unexpected AND causality is "related" or
//                "possible" (not "unrelated").
//  - DUE DATE:   7 calendar days for fatal/life-threatening unexpected
//                serious events, 15 calendar days for other expedited cases.
// ---------------------------------------------------------------------------

const SERIOUSNESS_CRITERIA = ["death", "life_threatening", "hospitalization", "disability", "congenital_anomaly", "other_medically_important"] as const
const CAUSALITY = ["related", "possible", "unrelated"] as const
const REPORTER_TYPES = ["healthcare_professional", "consumer", "other"] as const
const SEX = ["male", "female", "unknown"] as const

const seriousnessCriterion = v.union(...SERIOUSNESS_CRITERIA.map((c) => v.literal(c)))
const causalityValidator = v.union(...CAUSALITY.map((c) => v.literal(c)))

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const RATE_LIMIT_MAX_PER_HOUR = 5

function classify(seriousnessCriteria: string[], causality: string, eventTerm: string, product: { knownEvents: string[] }) {
  const isSerious = seriousnessCriteria.length > 0
  const canonical = canonicalTerm(eventTerm)
  const isExpected = product.knownEvents.some((k) => canonicalTerm(k) === canonical)
  const isExpedited = isSerious && !isExpected && causality !== "unrelated"
  const fatalOrLifeThreatening = seriousnessCriteria.includes("death") || seriousnessCriteria.includes("life_threatening")
  const expeditedDueAt = isExpedited ? Date.now() + (fatalOrLifeThreatening ? 7 : 15) * DAY_MS : undefined
  return { isSerious, isExpected, isExpedited, expeditedDueAt, fatalOrLifeThreatening }
}

export const listProducts = query({
  args: {},
  returns: v.array(v.object({ id: v.string(), name: v.string(), description: v.string() })),
  handler: async () => PRODUCTS.map(({ id, name, description }) => ({ id, name, description })),
})

// Typeahead list for the intake form: the product's already-listed events plus
// common terms. Static reference data only, nothing from submitted reports.
export const listEventTerms = query({
  args: { productId: v.string() },
  returns: v.array(v.string()),
  handler: async (_ctx, { productId }) => {
    const product = findProduct(productId)
    return product ? eventTermSuggestions(product) : []
  },
})

const DUPLICATE_WINDOW_DAYS = 3
const REPEAT_SUBMISSION_WINDOW_MS = 30 * DAY_MS

/**
 * Looks for an earlier report this one probably repeats. A match is either
 * (a) same product, same canonical event, same patient (sex and age) and an
 * onset date within a few days, or (b) the same reporter re-submitting the same
 * product and event within 30 days. It only FLAGS: a safety report is never
 * rejected for looking like another one, because two real patients can share
 * all of these details and a missed report is worse than a merged one.
 */
export async function findPossibleDuplicate(
  ctx: Pick<MutationCtx, "db">,
  c: { productId: string; canonical: string; patientSex: string; patientAgeYears?: number; eventOnsetDate: string; reporterEmail: string },
) {
  const candidates = await ctx.db.query("aeReports").withIndex("by_productId", (q) => q.eq("productId", c.productId)).order("desc").take(200)
  const onset = Date.parse(c.eventOnsetDate)
  for (const r of candidates) {
    if (r.status === "closed" && r.eventTerm.startsWith("(discarded")) continue
    if ((r.eventTermCanonical ?? canonicalTerm(r.eventTerm)) !== c.canonical) continue
    const samePatient = r.patientSex === c.patientSex && r.patientAgeYears === c.patientAgeYears
    const otherOnset = Date.parse(r.eventOnsetDate)
    const closeOnset = Number.isFinite(onset) && Number.isFinite(otherOnset) && Math.abs(onset - otherOnset) <= DUPLICATE_WINDOW_DAYS * DAY_MS
    if (samePatient && closeOnset && c.patientSex !== "unknown") return r
    if (r.reporterEmail === c.reporterEmail && Date.now() - r._creationTime < REPEAT_SUBMISSION_WINDOW_MS) return r
  }
  return null
}

// =============================================================================
// DEPRECATED — release-1 public contract, preserved byte-for-byte in its args
// and returns so nothing calling these six functions by their original names
// breaks. See convex-contract-migration: the frontend has moved to the `V2`
// exports below; these remain only until a Release B formally retires them.
//
// They are now inert: reads return an empty list and writes refuse. The
// platform could not prove the published release stopped calling them, so
// they stay for compatibility, but they must never expose patient-level data
// or accept unauthenticated writes.
// =============================================================================

/** @deprecated Use `api.ae.create`. Remove after a release no longer calls `api.ae.submitReport`. */
export const submitReport = mutation({
  args: {
    productId: v.string(),
    patientAgeYears: v.optional(v.number()),
    patientSex: v.union(...SEX.map((s) => v.literal(s))),
    eventTerm: v.string(),
    eventDescription: v.string(),
    eventOnsetDate: v.string(),
    reporterName: v.string(),
    reporterEmail: v.string(),
    reporterType: v.union(...REPORTER_TYPES.map((t) => v.literal(t))),
    causality: causalityValidator,
    seriousnessCriteria: v.array(seriousnessCriterion),
  },
  returns: v.object({ reportId: v.id("aeReports"), isExpedited: v.boolean() }),
  handler: async () => {
    throw new Error("This endpoint has been retired. Please use the current report form or sign in to the dashboard.")
  },
})

const reportValidatorV1 = v.object({
  _id: v.id("aeReports"),
  _creationTime: v.number(),
  productId: v.string(),
  productName: v.string(),
  patientAgeYears: v.optional(v.number()),
  patientSex: v.union(...SEX.map((s) => v.literal(s))),
  eventTerm: v.string(),
  eventDescription: v.string(),
  eventOnsetDate: v.string(),
  reporterName: v.string(),
  reporterEmail: v.string(),
  reporterType: v.union(...REPORTER_TYPES.map((t) => v.literal(t))),
  causality: causalityValidator,
  seriousnessCriteria: v.array(seriousnessCriterion),
  isSerious: v.boolean(),
  isExpected: v.boolean(),
  isExpedited: v.boolean(),
  expeditedDueAt: v.optional(v.number()),
  status: v.union(v.literal("new"), v.literal("in_review"), v.literal("reported"), v.literal("closed")),
})

const FEED_SIZE = 200

/** @deprecated Use `api.ae.listForTeam` (auth-gated). Remove after a release no longer calls `api.ae.listReports`. */
export const listReports = query({
  args: {},
  returns: v.array(reportValidatorV1),
  handler: async () => [],
})

const taskValidatorV1 = v.object({
  _id: v.id("tasks"),
  _creationTime: v.number(),
  reportId: v.id("aeReports"),
  title: v.string(),
  dueAt: v.optional(v.number()),
  priority: v.union(v.literal("urgent"), v.literal("routine")),
  done: v.boolean(),
})

/** @deprecated Use `api.ae.listTasksForTeam` (auth-gated). Remove after a release no longer calls `api.ae.listTasks`. */
export const listTasks = query({
  args: {},
  returns: v.array(taskValidatorV1),
  handler: async () => [],
})

/** @deprecated Use `api.ae.completeTask` (auth-gated). Remove after a release no longer calls `api.ae.setTaskDone`. */
export const setTaskDone = mutation({
  args: { taskId: v.id("tasks"), done: v.boolean() },
  returns: v.null(),
  handler: async () => {
    throw new Error("This endpoint has been retired. Please use the current report form or sign in to the dashboard.")
  },
})

/** @deprecated Use `api.ae.updateReportStatus` (auth-gated, audited). Remove after a release no longer calls `api.ae.setReportStatus`. */
export const setReportStatus = mutation({
  args: { reportId: v.id("aeReports"), status: v.union(v.literal("new"), v.literal("in_review"), v.literal("reported"), v.literal("closed")) },
  returns: v.null(),
  handler: async () => {
    throw new Error("This endpoint has been retired. Please use the current report form or sign in to the dashboard.")
  },
})

const alertValidatorV1 = v.object({
  _id: v.id("alerts"),
  _creationTime: v.number(),
  reportId: v.id("aeReports"),
  recipientEmail: v.string(),
  subject: v.string(),
  body: v.string(),
  status: v.union(v.literal("pending"), v.literal("sent"), v.literal("failed")),
  sentAt: v.optional(v.number()),
  error: v.optional(v.string()),
})

/** @deprecated Use `api.ae.listAlertsForTeam` (auth-gated). Remove after a release no longer calls `api.ae.listAlerts`. */
export const listAlerts = query({
  args: {},
  returns: v.array(alertValidatorV1),
  handler: async () => [],
})

// =============================================================================
// CURRENT — the real feature set: reference numbers, reporter confirmation,
// whole-team notification, auth-gated dashboard reads/writes, audit log,
// honeypot + rate limiting, and retryable alert delivery.
// =============================================================================

export const create = mutation({
  args: {
    productId: v.string(),
    patientAgeYears: v.optional(v.number()),
    patientSex: v.union(...SEX.map((s) => v.literal(s))),
    eventTerm: v.string(),
    eventDescription: v.string(),
    eventOnsetDate: v.string(),
    reporterName: v.string(),
    reporterEmail: v.string(),
    reporterType: v.union(...REPORTER_TYPES.map((t) => v.literal(t))),
    causality: causalityValidator,
    seriousnessCriteria: v.array(seriousnessCriterion),
    // Honeypot: a field real users never see or fill (hidden via CSS in the
    // form, not just visually — see src/routes/index.tsx). Any non-empty
    // value means an automated submitter filled every field it found, which
    // a human never would. We don't tell the caller it was rejected — that
    // would teach a bot to leave the field empty next time — we just
    // quietly do nothing.
    website: v.optional(v.string()),
    // Which company the report is for. Omitted = the default company (older clients).
    companyId: v.optional(v.id("companies")),
  },
  returns: v.object({ reportId: v.id("aeReports"), referenceNumber: v.string(), isExpedited: v.boolean() }),
  handler: async (ctx, args) => {
    const company = args.companyId ? await ctx.db.get(args.companyId) : await getDefaultCompany(ctx)
    if (args.companyId && !company) throw new Error("Unknown company")
    if (args.website && args.website.trim() !== "") {
      // Can't fabricate a real Id — return a harmless real row instead of
      // faking success. The honeypot's job is to skip the alert/notification
      // side effects, not to lie about what was created.
      const referenceNumber = await nextReferenceNumber(ctx)
      const reportId = await ctx.db.insert("aeReports", {
        referenceNumber,
        productId: args.productId,
        productName: (await resolveProduct(ctx, company, args.productId))?.name ?? "Unknown",
        companyId: company?._id,
        patientSex: args.patientSex,
        eventTerm: "(discarded — honeypot triggered)",
        eventDescription: "(discarded — honeypot triggered)",
        eventOnsetDate: args.eventOnsetDate,
        reporterName: args.reporterName.trim() || "(unknown)",
        reporterEmail: args.reporterEmail.trim().toLowerCase() || "unknown@example.com",
        reporterType: args.reporterType,
        causality: args.causality,
        seriousnessCriteria: [],
        isSerious: false,
        isExpected: true,
        isExpedited: false,
        status: "closed",
      })
      return { reportId, referenceNumber, isExpedited: false }
    }

    const product = await resolveProduct(ctx, company, args.productId)
    if (!product) throw new Error("Unknown product")
    const reporterName = args.reporterName.trim()
    const reporterEmail = args.reporterEmail.trim().toLowerCase()
    const eventTerm = args.eventTerm.trim()
    if (!reporterName) throw new Error("Reporter name is required")
    if (!eventTerm) throw new Error("Event term is required")
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reporterEmail)) throw new Error("Enter a valid reporter email address")

    // Rate limit: at most a handful of submissions per reporter email per
    // hour. This does not stop someone cycling through different email
    // addresses — a real deployment would add IP-based or CAPTCHA-based
    // protection on top — but it stops the simplest repeat-submission spam.
    const recent = await ctx.db.query("aeReports").withIndex("by_reporterEmail", (q) => q.eq("reporterEmail", reporterEmail)).order("desc").take(20)
    const recentCount = recent.filter((r) => Date.now() - r._creationTime < HOUR_MS).length
    if (recentCount >= RATE_LIMIT_MAX_PER_HOUR) throw new Error("Too many reports submitted from this email recently. Please try again later.")

    const { isSerious, isExpected, isExpedited, expeditedDueAt, fatalOrLifeThreatening } = classify(args.seriousnessCriteria, args.causality, eventTerm, product)
    const referenceNumber = await nextReferenceNumber(ctx)
    const canonical = canonicalTerm(eventTerm)
    const duplicate = await findPossibleDuplicate(ctx, {
      productId: args.productId, canonical, patientSex: args.patientSex, patientAgeYears: args.patientAgeYears,
      eventOnsetDate: args.eventOnsetDate, reporterEmail,
    })

    const reportId = await ctx.db.insert("aeReports", {
      referenceNumber,
      eventTermCanonical: canonical,
      possibleDuplicateOf: duplicate?._id,
      companyId: company?._id,
      productId: args.productId,
      productName: product.name,
      patientAgeYears: args.patientAgeYears,
      patientSex: args.patientSex,
      eventTerm,
      eventDescription: args.eventDescription.trim(),
      eventOnsetDate: args.eventOnsetDate,
      reporterName,
      reporterEmail,
      reporterType: args.reporterType,
      causality: args.causality,
      seriousnessCriteria: args.seriousnessCriteria,
      isSerious,
      isExpected,
      isExpedited,
      expeditedDueAt,
      status: "new",
    })

    await ctx.db.insert("tasks", {
      reportId,
      title: isExpedited
        ? `Submit expedited regulatory report (${fatalOrLifeThreatening ? "7-day" : "15-day"} timeline) — ${product.name}`
        : `Include in next periodic safety report — ${product.name}`,
      dueAt: expeditedDueAt,
      priority: isExpedited ? "urgent" : "routine",
      done: false,
    })

    // Reporter confirmation — sent for every report, regardless of
    // classification. Standard practice (this is what FDA MedWatch does).
    const reporterAlertId = await ctx.db.insert("alerts", {
      reportId,
      kind: "reporter_confirmation",
      recipientEmail: reporterEmail,
      subject: `Your adverse event report has been received — ${referenceNumber}`,
      body: [
        `Thank you, ${reporterName}. Your adverse event report has been received and assigned reference number ${referenceNumber}.`,
        "",
        ...(company ? [`Company: ${company.name}`] : []),
        `Product: ${product.name}`,
        `Reported event: ${eventTerm}`,
        `Date reported: ${new Date().toLocaleDateString()}`,
        "",
        "Please keep this reference number for any follow-up correspondence. Our safety team may contact you if additional information is needed.",
        "",
        "This is an automated confirmation from the PV Intake & Triage Console. All data is part of a fictional portfolio demonstration.",
      ].join("\n"),
      status: "pending",
    })
    await ctx.scheduler.runAfter(0, internal.ae.dispatchAlert, { alertId: reporterAlertId })

    // Team notification — every active recipient gets one, urgent-styled
    // for expedited reports and routine-styled otherwise.
    const recipients = company ? await companyRecipients(ctx, company) : await ctx.db.query("safetyTeamRecipients").collect()
    const activeRecipients = recipients.filter((r) => r.active)
    const prefix = company ? `[${company.name}] ` : ""
    const subject = isExpedited
      ? `${prefix}URGENT: Expedited AE report due within ${fatalOrLifeThreatening ? "7 days" : "15 days"} — ${referenceNumber}`
      : `${prefix}New adverse event report (routine) — ${referenceNumber}`
    const body = [
      isExpedited
        ? "A new adverse event report was classified as SERIOUS, UNEXPECTED, and reporter-assessed as related or possibly related to the product. This triggers expedited regulatory reporting."
        : "A new adverse event report has been logged for the next periodic safety report. No expedited action is required.",
      "",
      `Reference: ${referenceNumber}`,
      ...(company ? [`Company: ${company.name}`] : []),
      `Product: ${product.name}`,
      `Reported event: ${eventTerm}`,
      ...(canonical !== eventTerm.toLowerCase() ? [`Matched to label term: ${canonical}`] : []),
      ...(duplicate ? [`POSSIBLE DUPLICATE of ${duplicate.referenceNumber} (same product and event, similar patient or same reporter). Review before reporting twice.`] : []),
      `Seriousness criteria: ${args.seriousnessCriteria.join(", ") || "none"}`,
      `Causality (reporter-assessed): ${args.causality}`,
      ...(isExpedited ? [`Regulatory due date: ${new Date(expeditedDueAt!).toLocaleString()}`] : []),
      "",
      `Reported by: ${reporterName} (${args.reporterType.replace("_", " ")}, ${reporterEmail})`,
      "",
      "This is an automated notification from the PV Intake & Triage Console. All data is part of a fictional portfolio demonstration.",
    ].join("\n")
    for (const recipient of activeRecipients) {
      const alertId = await ctx.db.insert("alerts", {
        reportId,
        kind: isExpedited ? "expedited_team_alert" : "routine_team_notice",
        recipientEmail: recipient.email,
        subject,
        body,
        status: "pending",
      })
      await ctx.scheduler.runAfter(0, internal.ae.dispatchAlert, { alertId })
    }

    return { reportId, referenceNumber, isExpedited }
  },
})

export const getAlertInternal = internalQuery({
  args: { alertId: v.id("alerts") },
  returns: v.union(v.null(), v.object({ recipientEmail: v.string(), subject: v.string(), body: v.string() })),
  handler: async (ctx, { alertId }) => {
    const alert = await ctx.db.get(alertId)
    return alert ? { recipientEmail: alert.recipientEmail, subject: alert.subject, body: alert.body } : null
  },
})

export const markAlertSent = internalMutation({
  args: { alertId: v.id("alerts") },
  returns: v.null(),
  handler: async (ctx, { alertId }) => {
    await ctx.db.patch(alertId, { status: "sent", sentAt: Date.now(), error: undefined })
    return null
  },
})

export const markAlertFailed = internalMutation({
  args: { alertId: v.id("alerts"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { alertId, error }) => {
    await ctx.db.patch(alertId, { status: "failed", error })
    return null
  },
})

// Real outbound call to the platform's built-in transactional-email
// endpoint — not a simulated log line.
export const dispatchAlert = internalAction({
  args: { alertId: v.id("alerts") },
  returns: v.null(),
  handler: async (ctx, { alertId }) => {
    const alert = await ctx.runQuery(internal.ae.getAlertInternal, { alertId })
    if (!alert) return null
    const endpoint = process.env.EMAIL_NOTIFICATION_ENDPOINT
    if (!endpoint) {
      await ctx.runMutation(internal.ae.markAlertFailed, { alertId, error: "EMAIL_NOTIFICATION_ENDPOINT is not configured" })
      return null
    }
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toEmail: alert.recipientEmail,
          subject: alert.subject,
          message: alert.body,
          chatId: process.env.CHAT_ID,
          appName: process.env.APP_NAME,
          secretKey: process.env.SECRET_KEY,
        }),
      })
      if (res.ok) {
        await ctx.runMutation(internal.ae.markAlertSent, { alertId })
      } else {
        const text = await res.text().catch(() => "")
        await ctx.runMutation(internal.ae.markAlertFailed, { alertId, error: `HTTP ${res.status}: ${text.slice(0, 300)}` })
      }
    } catch (err) {
      await ctx.runMutation(internal.ae.markAlertFailed, { alertId, error: err instanceof Error ? err.message : String(err) })
    }
    return null
  },
})

// Team-only: retry a failed delivery. Re-uses the same alert row rather
// than creating a new one, so the history stays one row per notification
// actually intended, with its delivery attempts reflected in-place.
export const retryAlert = mutation({
  args: { alertId: v.id("alerts") },
  returns: v.union(v.object({ ok: v.literal(true) }), v.object({ ok: v.literal(false), code: v.literal("FORBIDDEN"), message: v.string() })),
  handler: async (ctx, { alertId }) => {
    const userId = await getAuthUserId(ctx)
    const user = userId ? await ctx.db.get(userId) : null
    if (!(await checkIsTeamMember(ctx, user?.email))) return { ok: false as const, code: "FORBIDDEN" as const, message: "You must be a signed-in team member." }
    await ctx.db.patch(alertId, { status: "pending", error: undefined })
    await ctx.scheduler.runAfter(0, internal.ae.dispatchAlert, { alertId })
    return { ok: true as const }
  },
})

export const reportValidator = v.object({
  _id: v.id("aeReports"),
  _creationTime: v.number(),
  referenceNumber: v.string(),
  productId: v.string(),
  productName: v.string(),
  patientAgeYears: v.optional(v.number()),
  patientSex: v.union(...SEX.map((s) => v.literal(s))),
  eventTerm: v.string(),
  eventDescription: v.string(),
  eventOnsetDate: v.string(),
  reporterName: v.string(),
  reporterEmail: v.string(),
  reporterType: v.union(...REPORTER_TYPES.map((t) => v.literal(t))),
  causality: causalityValidator,
  seriousnessCriteria: v.array(seriousnessCriterion),
  isSerious: v.boolean(),
  isExpected: v.boolean(),
  isExpedited: v.boolean(),
  expeditedDueAt: v.optional(v.number()),
  status: v.union(v.literal("new"), v.literal("in_review"), v.literal("reported"), v.literal("closed")),
  eventTermCanonical: v.optional(v.string()),
  possibleDuplicateOf: v.optional(v.id("aeReports")),
  lastEscalationStage: v.optional(v.union(v.literal("due_soon"), v.literal("overdue"))),
  companyId: v.optional(v.id("companies")),
})

export async function requireTeamMember(ctx: Pick<QueryCtx, "db" | "auth">): Promise<{ ok: true; email: string } | { ok: false }> {
  const userId = await getAuthUserId(ctx)
  const user = userId ? await ctx.db.get(userId) : null
  const isMember = await checkIsTeamMember(ctx, user?.email)
  return isMember ? { ok: true, email: user!.email! } : { ok: false }
}

const forbidden = { code: "FORBIDDEN" as const, message: "You must be a signed-in team member." }

export const listForTeam = query({
  args: {},
  returns: v.union(v.object({ ok: v.literal(true), reports: v.array(reportValidator) }), v.object({ ok: v.literal(false), code: v.literal("FORBIDDEN"), message: v.string() })),
  handler: async (ctx) => {
    const auth = await requireTeamMember(ctx)
    if (!auth.ok) return { ok: false as const, ...forbidden }
    const reports = await ctx.db.query("aeReports").order("desc").take(FEED_SIZE)
    return { ok: true as const, reports }
  },
})

export const taskValidator = v.object({
  _id: v.id("tasks"),
  _creationTime: v.number(),
  reportId: v.id("aeReports"),
  title: v.string(),
  dueAt: v.optional(v.number()),
  priority: v.union(v.literal("urgent"), v.literal("routine")),
  done: v.boolean(),
})

export const listTasksForTeam = query({
  args: {},
  returns: v.union(v.object({ ok: v.literal(true), tasks: v.array(taskValidator) }), v.object({ ok: v.literal(false), code: v.literal("FORBIDDEN"), message: v.string() })),
  handler: async (ctx) => {
    const auth = await requireTeamMember(ctx)
    if (!auth.ok) return { ok: false as const, ...forbidden }
    const tasks = await ctx.db.query("tasks").order("desc").take(FEED_SIZE)
    return { ok: true as const, tasks }
  },
})

export const completeTask = mutation({
  args: { taskId: v.id("tasks"), done: v.boolean() },
  returns: v.union(v.object({ ok: v.literal(true) }), v.object({ ok: v.literal(false), code: v.literal("FORBIDDEN"), message: v.string() })),
  handler: async (ctx, { taskId, done }) => {
    const auth = await requireTeamMember(ctx)
    if (!auth.ok) return { ok: false as const, ...forbidden }
    await ctx.db.patch(taskId, { done })
    return { ok: true as const }
  },
})

export const updateReportStatus = mutation({
  args: { reportId: v.id("aeReports"), status: v.union(v.literal("new"), v.literal("in_review"), v.literal("reported"), v.literal("closed")) },
  returns: v.union(v.object({ ok: v.literal(true) }), v.object({ ok: v.literal(false), code: v.literal("FORBIDDEN"), message: v.string() })),
  handler: async (ctx, { reportId, status }) => {
    const auth = await requireTeamMember(ctx)
    if (!auth.ok) return { ok: false as const, ...forbidden }
    const report = await ctx.db.get(reportId)
    if (report && report.status !== status) {
      await ctx.db.patch(reportId, { status })
      await ctx.db.insert("auditLog", { reportId, actorEmail: auth.email, action: "status_change", fromValue: report.status, toValue: status })
    }
    return { ok: true as const }
  },
})

export const listAuditLog = query({
  args: { reportId: v.id("aeReports") },
  returns: v.union(
    v.object({ ok: v.literal(true), entries: v.array(v.object({ _id: v.id("auditLog"), _creationTime: v.number(), actorEmail: v.string(), action: v.string(), fromValue: v.optional(v.string()), toValue: v.optional(v.string()) })) }),
    v.object({ ok: v.literal(false), code: v.literal("FORBIDDEN"), message: v.string() }),
  ),
  handler: async (ctx, { reportId }) => {
    const auth = await requireTeamMember(ctx)
    if (!auth.ok) return { ok: false as const, ...forbidden }
    const entries = await ctx.db.query("auditLog").withIndex("by_reportId", (q) => q.eq("reportId", reportId)).order("desc").take(50)
    return { ok: true as const, entries }
  },
})

export const alertValidator = v.object({
  _id: v.id("alerts"),
  _creationTime: v.number(),
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

export const listAlertsForTeam = query({
  args: {},
  returns: v.union(v.object({ ok: v.literal(true), alerts: v.array(alertValidator) }), v.object({ ok: v.literal(false), code: v.literal("FORBIDDEN"), message: v.string() })),
  handler: async (ctx) => {
    const auth = await requireTeamMember(ctx)
    if (!auth.ok) return { ok: false as const, ...forbidden }
    const alerts = await ctx.db.query("alerts").order("desc").take(FEED_SIZE)
    return { ok: true as const, alerts }
  },
})
