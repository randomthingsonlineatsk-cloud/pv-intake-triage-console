import { v } from "convex/values"
import { internalMutation } from "./_generated/server"
import { nextReferenceNumber } from "./counters"

// One-time bootstrap: seed the first safety-team member. Every other way to
// add someone (convex/recipients.ts:add) requires the caller to already BE
// a team member, which is correct for ongoing use but leaves no path to
// create the very first member — this is that path. Not client-callable.
// Safe to run again: it's a no-op once at least one active member exists.
export const bootstrapFirstTeamMember = internalMutation({
  args: { email: v.string(), name: v.string() },
  returns: v.union(v.literal("created"), v.literal("already_has_members")),
  handler: async (ctx, args) => {
    const existingActive = (await ctx.db.query("safetyTeamRecipients").collect()).filter((r) => r.active)
    if (existingActive.length > 0) return "already_has_members"
    const email = args.email.trim().toLowerCase()
    const existing = await ctx.db.query("safetyTeamRecipients").withIndex("by_email", (q) => q.eq("email", email)).unique()
    if (existing) await ctx.db.patch(existing._id, { active: true, name: args.name })
    else await ctx.db.insert("safetyTeamRecipients", { email, name: args.name, active: true })
    return "created"
  },
})

// One-time backfill: reports created before reference numbers existed get
// one now, oldest first, using the same counter as new reports so numbers
// never collide. No-op for rows that already have one.
export const backfillReferenceNumbers = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const rows = await ctx.db.query("aeReports").order("asc").collect()
    let n = 0
    for (const r of rows) {
      if (r.referenceNumber) continue
      await ctx.db.patch(r._id, { referenceNumber: await nextReferenceNumber(ctx) })
      n++
    }
    const alerts = await ctx.db.query("alerts").collect()
    for (const a of alerts) {
      if (a.kind) continue
      await ctx.db.patch(a._id, { kind: a.subject.startsWith("URGENT") ? "expedited_team_alert" : "routine_team_notice" })
      n++
    }
    return n
  },
})
