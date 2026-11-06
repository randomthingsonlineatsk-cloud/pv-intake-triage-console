import { v } from "convex/values"
import { internalMutation, mutation } from "./_generated/server"
import type { MutationCtx } from "./_generated/server"
import type { Doc } from "./_generated/dataModel"
import { internal } from "./_generated/api"
import { companyRecipients, getDefaultCompany, reportInCompany } from "./companyLib"

const DAY_MS = 86_400_000
/** Remind the team when an expedited report is this close to its regulatory deadline. */
const DUE_SOON_MS = 3 * DAY_MS

type Stage = "due_soon" | "overdue"
const RANK: Record<Stage, number> = { due_soon: 1, overdue: 2 }

/**
 * Finds open expedited reports that have reached a new reminder stage and
 * emails the active members of THAT report's company once per stage per report
 * (so a report produces at most one "due soon" and one "overdue" email, however
 * often this runs). Each reminder is written to the audit log as the system actor.
 * Pass `onlyCompany` to limit the check to one company. Returns how many
 * reports were escalated.
 */
export async function processEscalations(ctx: MutationCtx, now = Date.now(), onlyCompany?: Doc<"companies">): Promise<number> {
  const defaultCompany = await getDefaultCompany(ctx)
  const companyCache = new Map<string, Doc<"companies"> | null>()
  const recipientCache = new Map<string, Doc<"safetyTeamRecipients">[]>()
  let escalated = 0

  for (const status of ["new", "in_review"] as const) {
    const open = await ctx.db.query("aeReports").withIndex("by_isExpedited_status", (q) => q.eq("isExpedited", true).eq("status", status)).collect()
    for (const report of open) {
      if (!report.expeditedDueAt) continue
      if (onlyCompany && !reportInCompany(report, onlyCompany)) continue
      const msLeft = report.expeditedDueAt - now
      const stage: Stage | null = msLeft < 0 ? "overdue" : msLeft <= DUE_SOON_MS ? "due_soon" : null
      if (!stage) continue
      if (report.lastEscalationStage && RANK[report.lastEscalationStage] >= RANK[stage]) continue

      const key = report.companyId ?? "default"
      if (!companyCache.has(key)) companyCache.set(key, report.companyId ? await ctx.db.get(report.companyId) : defaultCompany)
      const company = companyCache.get(key) ?? null
      if (!recipientCache.has(key)) {
        recipientCache.set(key, company ? (await companyRecipients(ctx, company)).filter((r) => r.active) : (await ctx.db.query("safetyTeamRecipients").collect()).filter((r) => r.active))
      }
      const recipients = recipientCache.get(key)!
      const prefix = company ? `[${company.name}] ` : ""

      const daysLeft = Math.ceil(msLeft / DAY_MS)
      const headline =
        stage === "overdue"
          ? `${prefix}OVERDUE: expedited report ${report.referenceNumber} passed its regulatory deadline`
          : `${prefix}Reminder: expedited report ${report.referenceNumber} is due in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`
      const body = [
        stage === "overdue"
          ? "This expedited adverse event report is still open and its regulatory due date has passed. Submit it, or record why it cannot be submitted."
          : "This expedited adverse event report is still open and its regulatory due date is approaching.",
        "",
        `Reference: ${report.referenceNumber}`,
        ...(company ? [`Company: ${company.name}`] : []),
        `Product: ${report.productName}`,
        `Reported event: ${report.eventTerm}`,
        `Current status: ${report.status.replace("_", " ")}`,
        `Regulatory due date: ${new Date(report.expeditedDueAt).toLocaleString()}`,
        "",
        "Mark the report Reported or Closed in the dashboard to stop further reminders.",
        "",
        "Automated reminder from the PV Intake & Triage Console. All data is part of a fictional portfolio demonstration.",
      ].join("\n")

      for (const recipient of recipients) {
        const alertId = await ctx.db.insert("alerts", {
          reportId: report._id,
          kind: "escalation_reminder",
          recipientEmail: recipient.email,
          subject: headline,
          body,
          status: "pending",
        })
        await ctx.scheduler.runAfter(0, internal.ae.dispatchAlert, { alertId })
      }
      await ctx.db.patch(report._id, { lastEscalationStage: stage })
      await ctx.db.insert("auditLog", { reportId: report._id, actorEmail: "system", action: "escalation_reminder", toValue: stage })
      escalated++
    }
  }
  return escalated
}

// Run by the daily cron (see convex/crons.ts).
export const runScheduled = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => processEscalations(ctx),
})

/** @deprecated Retired when the dashboard became company-scoped. Use `api.co.runReminders`. */
export const runNow = mutation({
  args: {},
  returns: v.union(
    v.object({ ok: v.literal(true), escalated: v.number() }),
    v.object({ ok: v.literal(false), code: v.literal("FORBIDDEN"), message: v.string() }),
  ),
  handler: async () => ({ ok: false as const, code: "FORBIDDEN" as const, message: "This endpoint has been retired. Open your company dashboard from the Companies page." }),
})
