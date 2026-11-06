import { v } from "convex/values"
import { mutation, query } from "./_generated/server"
import type { QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { internal } from "./_generated/api"
import { reportValidator, taskValidator, alertValidator } from "./ae"
import { FORBIDDEN, companyRecipients, companyReports, listCompanyProducts, memberAccess, reportInCompany } from "./companyLib"
import { followUpValidator, forbiddenResult, invalidResult, recordReply, sendFollowUp } from "./followups"
import { processEscalations } from "./escalations"

// Every endpoint here takes a companyId and checks the caller is a signed-in,
// active member of THAT company before touching anything. Records are only
// ever reached through that company's own reports, so one company can never
// read or change another's data.

const FEED_SIZE = 200
const STATUS = v.union(v.literal("new"), v.literal("in_review"), v.literal("reported"), v.literal("closed"))
const ok = v.object({ ok: v.literal(true) })
const forbidden = forbiddenResult

async function ownReport(ctx: Pick<QueryCtx, "db">, company: Doc<"companies">, reportId: Id<"aeReports">) {
  const report = await ctx.db.get(reportId)
  return report && reportInCompany(report, company) ? report : null
}

export const dashboard = query({
  args: { companyId: v.id("companies") },
  returns: v.union(
    v.object({ ok: v.literal(true), reports: v.array(reportValidator), tasks: v.array(taskValidator), alerts: v.array(alertValidator) }),
    forbidden,
  ),
  handler: async (ctx, { companyId }) => {
    const access = await memberAccess(ctx, companyId)
    if (!access.ok) return FORBIDDEN
    const reports = await companyReports(ctx, access.company, FEED_SIZE)
    const tasks: Doc<"tasks">[] = []
    const alerts: Doc<"alerts">[] = []
    for (const r of reports) {
      tasks.push(...(await ctx.db.query("tasks").withIndex("by_reportId", (q) => q.eq("reportId", r._id)).collect()))
      alerts.push(...(await ctx.db.query("alerts").withIndex("by_reportId", (q) => q.eq("reportId", r._id)).collect()))
    }
    return { ok: true as const, reports, tasks, alerts }
  },
})

export const completeTask = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("tasks"), done: v.boolean() },
  returns: v.union(ok, forbidden),
  handler: async (ctx, { companyId, taskId, done }) => {
    const access = await memberAccess(ctx, companyId)
    if (!access.ok) return FORBIDDEN
    const task = await ctx.db.get(taskId)
    if (!task || !(await ownReport(ctx, access.company, task.reportId))) return FORBIDDEN
    await ctx.db.patch(taskId, { done })
    return { ok: true as const }
  },
})

export const updateReportStatus = mutation({
  args: { companyId: v.id("companies"), reportId: v.id("aeReports"), status: STATUS },
  returns: v.union(ok, forbidden),
  handler: async (ctx, { companyId, reportId, status }) => {
    const access = await memberAccess(ctx, companyId)
    if (!access.ok) return FORBIDDEN
    const report = await ownReport(ctx, access.company, reportId)
    if (!report) return FORBIDDEN
    if (report.status !== status) {
      await ctx.db.patch(reportId, { status })
      await ctx.db.insert("auditLog", { reportId, actorEmail: access.email, action: "status_change", fromValue: report.status, toValue: status })
    }
    return { ok: true as const }
  },
})

export const retryAlert = mutation({
  args: { companyId: v.id("companies"), alertId: v.id("alerts") },
  returns: v.union(ok, forbidden),
  handler: async (ctx, { companyId, alertId }) => {
    const access = await memberAccess(ctx, companyId)
    if (!access.ok) return FORBIDDEN
    const alert = await ctx.db.get(alertId)
    if (!alert || !(await ownReport(ctx, access.company, alert.reportId))) return FORBIDDEN
    await ctx.db.patch(alertId, { status: "pending", error: undefined })
    await ctx.scheduler.runAfter(0, internal.ae.dispatchAlert, { alertId })
    return { ok: true as const }
  },
})

export const auditLog = query({
  args: { companyId: v.id("companies"), reportId: v.id("aeReports") },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      entries: v.array(v.object({ _id: v.id("auditLog"), _creationTime: v.number(), actorEmail: v.string(), action: v.string(), fromValue: v.optional(v.string()), toValue: v.optional(v.string()) })),
    }),
    forbidden,
  ),
  handler: async (ctx, { companyId, reportId }) => {
    const access = await memberAccess(ctx, companyId)
    if (!access.ok || !(await ownReport(ctx, access.company, reportId))) return FORBIDDEN
    const entries = await ctx.db.query("auditLog").withIndex("by_reportId", (q) => q.eq("reportId", reportId)).order("desc").take(50)
    return { ok: true as const, entries }
  },
})

// ---- follow-ups ------------------------------------------------------------

export const followUps = query({
  args: { companyId: v.id("companies"), reportId: v.id("aeReports") },
  returns: v.union(v.object({ ok: v.literal(true), items: v.array(followUpValidator) }), forbidden),
  handler: async (ctx, { companyId, reportId }) => {
    const access = await memberAccess(ctx, companyId)
    if (!access.ok || !(await ownReport(ctx, access.company, reportId))) return FORBIDDEN
    const items = await ctx.db.query("followUps").withIndex("by_reportId", (q) => q.eq("reportId", reportId)).order("asc").take(100)
    return { ok: true as const, items }
  },
})

export const sendFollowUpToReporter = mutation({
  args: { companyId: v.id("companies"), reportId: v.id("aeReports"), message: v.string() },
  returns: v.union(ok, forbidden, invalidResult),
  handler: async (ctx, { companyId, reportId, message }) => {
    const access = await memberAccess(ctx, companyId)
    if (!access.ok) return FORBIDDEN
    const report = await ownReport(ctx, access.company, reportId)
    if (!report) return FORBIDDEN
    return await sendFollowUp(ctx, access.email, report, message)
  },
})

export const logReporterReply = mutation({
  args: { companyId: v.id("companies"), reportId: v.id("aeReports"), message: v.string() },
  returns: v.union(ok, forbidden, invalidResult),
  handler: async (ctx, { companyId, reportId, message }) => {
    const access = await memberAccess(ctx, companyId)
    if (!access.ok) return FORBIDDEN
    if (!(await ownReport(ctx, access.company, reportId))) return FORBIDDEN
    return await recordReply(ctx, access.email, reportId, message)
  },
})

export const runReminders = mutation({
  args: { companyId: v.id("companies") },
  returns: v.union(v.object({ ok: v.literal(true), escalated: v.number() }), forbidden),
  handler: async (ctx, { companyId }) => {
    const access = await memberAccess(ctx, companyId)
    if (!access.ok) return FORBIDDEN
    return { ok: true as const, escalated: await processEscalations(ctx, Date.now(), access.company) }
  },
})

// ---- team ------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const recipientValidator = v.object({ _id: v.id("safetyTeamRecipients"), _creationTime: v.number(), email: v.string(), name: v.string(), active: v.boolean() })
const teamResult = v.union(ok, v.object({ ok: v.literal(false), code: v.union(v.literal("FORBIDDEN"), v.literal("INVALID"), v.literal("DUPLICATE"), v.literal("LAST_MEMBER")), message: v.string() }))

export const team = query({
  args: { companyId: v.id("companies") },
  returns: v.union(v.object({ ok: v.literal(true), members: v.array(recipientValidator) }), forbidden),
  handler: async (ctx, { companyId }) => {
    const access = await memberAccess(ctx, companyId)
    if (!access.ok) return FORBIDDEN
    const members = (await companyRecipients(ctx, access.company)).filter((r) => r.active)
    return { ok: true as const, members: members.map(({ _id, _creationTime, email, name, active }) => ({ _id, _creationTime, email, name, active })) }
  },
})

export const addMember = mutation({
  args: { companyId: v.id("companies"), email: v.string(), name: v.string() },
  returns: teamResult,
  handler: async (ctx, { companyId, email: rawEmail, name }) => {
    const access = await memberAccess(ctx, companyId)
    if (!access.ok) return FORBIDDEN
    const email = rawEmail.trim().toLowerCase()
    if (!EMAIL_RE.test(email)) return { ok: false as const, code: "INVALID" as const, message: "Enter a valid email address." }
    const members = await companyRecipients(ctx, access.company)
    const existing = members.find((m) => m.email === email)
    if (existing?.active) return { ok: false as const, code: "DUPLICATE" as const, message: "That person is already on the team." }
    if (existing) {
      await ctx.db.patch(existing._id, { active: true, name: name.trim() || existing.name })
      return { ok: true as const }
    }
    if (members.filter((m) => m.active).length >= 25) return { ok: false as const, code: "INVALID" as const, message: "A demo team can have up to 25 members." }
    await ctx.db.insert("safetyTeamRecipients", { email, name: name.trim() || email, active: true, companyId: access.company._id })
    return { ok: true as const }
  },
})

export const removeMember = mutation({
  args: { companyId: v.id("companies"), id: v.id("safetyTeamRecipients") },
  returns: teamResult,
  handler: async (ctx, { companyId, id }) => {
    const access = await memberAccess(ctx, companyId)
    if (!access.ok) return FORBIDDEN
    const members = (await companyRecipients(ctx, access.company)).filter((m) => m.active)
    if (!members.some((m) => m._id === id)) return FORBIDDEN
    if (members.length <= 1) return { ok: false as const, code: "LAST_MEMBER" as const, message: "At least one team member must remain, or nobody could sign back in." }
    await ctx.db.patch(id, { active: false })
    return { ok: true as const }
  },
})

// ---- products --------------------------------------------------------------

const MAX_PRODUCTS = 20
const productValidator = v.object({ id: v.string(), name: v.string(), description: v.string(), knownEvents: v.array(v.string()), editable: v.boolean() })

export const products = query({
  args: { companyId: v.id("companies") },
  returns: v.union(v.object({ ok: v.literal(true), products: v.array(productValidator) }), forbidden),
  handler: async (ctx, { companyId }) => {
    const access = await memberAccess(ctx, companyId)
    if (!access.ok) return FORBIDDEN
    const list = await listCompanyProducts(ctx, access.company)
    return { ok: true as const, products: list.map((p) => ({ ...p, editable: !access.company.isDefault })) }
  },
})

export const addProduct = mutation({
  args: { companyId: v.id("companies"), name: v.string(), description: v.string(), knownEvents: v.string() },
  returns: teamResult,
  handler: async (ctx, { companyId, name, description, knownEvents }) => {
    const access = await memberAccess(ctx, companyId)
    if (!access.ok) return FORBIDDEN
    if (access.company.isDefault) return { ok: false as const, code: "INVALID" as const, message: "The original demo company's products are fixed." }
    const cleanName = name.trim()
    if (cleanName.length < 2 || cleanName.length > 80) return { ok: false as const, code: "INVALID" as const, message: "Use a product name between 2 and 80 characters." }
    const events = [...new Set(knownEvents.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean))]
    if (events.length > 40 || events.some((e) => e.length > 80)) return { ok: false as const, code: "INVALID" as const, message: "List up to 40 events, each under 80 characters." }
    const existing = await ctx.db.query("companyProducts").withIndex("by_companyId", (q) => q.eq("companyId", companyId)).collect()
    if (existing.length >= MAX_PRODUCTS) return { ok: false as const, code: "INVALID" as const, message: `A demo company can have up to ${MAX_PRODUCTS} products.` }
    await ctx.db.insert("companyProducts", { companyId, name: cleanName, description: description.trim().slice(0, 300), knownEvents: events })
    return { ok: true as const }
  },
})

export const removeProduct = mutation({
  args: { companyId: v.id("companies"), productId: v.id("companyProducts") },
  returns: teamResult,
  handler: async (ctx, { companyId, productId }) => {
    const access = await memberAccess(ctx, companyId)
    if (!access.ok) return FORBIDDEN
    const product = await ctx.db.get(productId)
    if (!product || product.companyId !== companyId) return FORBIDDEN
    await ctx.db.delete(productId)
    return { ok: true as const }
  },
})
