import { v } from "convex/values"
import { mutation, query } from "./_generated/server"
import type { MutationCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { internal } from "./_generated/api"

export const MAX_MESSAGE = 2000

export const forbiddenResult = v.object({ ok: v.literal(false), code: v.literal("FORBIDDEN"), message: v.string() })
export const invalidResult = v.object({ ok: v.literal(false), code: v.literal("INVALID"), message: v.string() })

export const followUpValidator = v.object({
  _id: v.id("followUps"),
  _creationTime: v.number(),
  reportId: v.id("aeReports"),
  direction: v.union(v.literal("to_reporter"), v.literal("from_reporter")),
  authorEmail: v.string(),
  message: v.string(),
  alertId: v.optional(v.id("alerts")),
})

type Outcome = { ok: true } | { ok: false; code: "INVALID"; message: string }
const invalid = (message: string) => ({ ok: false as const, code: "INVALID" as const, message })

/** Emails the reporter a question and records it on the report. Caller must already have checked company membership. */
export async function sendFollowUp(ctx: MutationCtx, actorEmail: string, report: Doc<"aeReports">, message: string): Promise<Outcome> {
  const text = message.trim()
  if (!text) return invalid("Write a message first.")
  if (text.length > MAX_MESSAGE) return invalid(`Keep the message under ${MAX_MESSAGE} characters.`)
  if (report.eventTerm.startsWith("(discarded")) return invalid("Report not found.")
  const alertId = await ctx.db.insert("alerts", {
    reportId: report._id,
    kind: "followup_query",
    recipientEmail: report.reporterEmail,
    subject: `Follow-up on your adverse event report — ${report.referenceNumber}`,
    body: [
      `Dear ${report.reporterName},`,
      "",
      `The safety team has a question about your report ${report.referenceNumber} (${report.productName}, ${report.eventTerm}):`,
      "",
      text,
      "",
      `Please reply to the safety team and quote reference ${report.referenceNumber}.`,
      "",
      "Automated message from the PV Intake & Triage Console. All data is part of a fictional portfolio demonstration.",
    ].join("\n"),
    status: "pending",
  })
  await ctx.scheduler.runAfter(0, internal.ae.dispatchAlert, { alertId })
  await ctx.db.insert("followUps", { reportId: report._id, direction: "to_reporter", authorEmail: actorEmail, message: text, alertId })
  await ctx.db.insert("auditLog", { reportId: report._id, actorEmail, action: "follow_up_sent" })
  return { ok: true }
}

/** Records a reply the reporter gave outside the app (the email service is send-only). */
export async function recordReply(ctx: MutationCtx, actorEmail: string, reportId: Id<"aeReports">, message: string): Promise<Outcome> {
  const text = message.trim()
  if (!text) return invalid("Write the reply first.")
  if (text.length > MAX_MESSAGE) return invalid(`Keep the reply under ${MAX_MESSAGE} characters.`)
  await ctx.db.insert("followUps", { reportId, direction: "from_reporter", authorEmail: actorEmail, message: text })
  await ctx.db.insert("auditLog", { reportId, actorEmail, action: "reporter_reply_logged" })
  return { ok: true }
}

const retired = { ok: false as const, code: "FORBIDDEN" as const, message: "This endpoint has been retired. Open your company dashboard from the Companies page." }

/** @deprecated Retired when the dashboard became company-scoped. Use `api.co.followUps`. */
export const listForReport = query({
  args: { reportId: v.id("aeReports") },
  returns: v.union(v.object({ ok: v.literal(true), items: v.array(followUpValidator) }), forbiddenResult),
  handler: async () => retired,
})

/** @deprecated Retired. Use `api.co.sendFollowUp`. */
export const sendToReporter = mutation({
  args: { reportId: v.id("aeReports"), message: v.string() },
  returns: v.union(v.object({ ok: v.literal(true) }), forbiddenResult, invalidResult),
  handler: async () => retired,
})

/** @deprecated Retired. Use `api.co.logReply`. */
export const logReply = mutation({
  args: { reportId: v.id("aeReports"), message: v.string() },
  returns: v.union(v.object({ ok: v.literal(true) }), forbiddenResult, invalidResult),
  handler: async () => retired,
})
