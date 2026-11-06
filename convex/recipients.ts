import { v } from "convex/values"
import { mutation, query } from "./_generated/server"
import type { QueryCtx } from "./_generated/server"
import { getAuthUserId } from "@convex-dev/auth/server"
import { checkIsTeamMember } from "./authz"

const recipientValidator = v.object({ _id: v.id("safetyTeamRecipients"), _creationTime: v.number(), email: v.string(), name: v.string(), active: v.boolean() })

async function currentEmail(ctx: Pick<QueryCtx, "db" | "auth">): Promise<string | null> {
  const userId = await getAuthUserId(ctx)
  if (!userId) return null
  const user = await ctx.db.get(userId)
  return user?.email ?? null
}

// Team-only. Any signed-in team member can see and manage the roster —
// there is no separate "owner" role, matching a small real safety team
// where membership itself is the permission.
export const list = query({
  args: {},
  returns: v.union(v.object({ ok: v.literal(true), recipients: v.array(recipientValidator) }), v.object({ ok: v.literal(false), code: v.literal("FORBIDDEN"), message: v.string() })),
  handler: async (ctx) => {
    const email = await currentEmail(ctx)
    if (!(await checkIsTeamMember(ctx, email))) return { ok: false as const, code: "FORBIDDEN" as const, message: "You must be a signed-in team member." }
    const recipients = await ctx.db.query("safetyTeamRecipients").order("desc").take(200)
    return { ok: true as const, recipients }
  },
})

const mutateResult = v.union(v.object({ ok: v.literal(true) }), v.object({ ok: v.literal(false), code: v.union(v.literal("FORBIDDEN"), v.literal("DUPLICATE"), v.literal("LAST_MEMBER")), message: v.string() }))

export const add = mutation({
  args: { email: v.string(), name: v.string() },
  returns: mutateResult,
  handler: async (ctx, args) => {
    const requesterEmail = await currentEmail(ctx)
    if (!(await checkIsTeamMember(ctx, requesterEmail))) return { ok: false as const, code: "FORBIDDEN" as const, message: "You must be a signed-in team member to add recipients." }
    const email = args.email.trim().toLowerCase()
    const name = args.name.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false as const, code: "FORBIDDEN" as const, message: "Enter a valid email address." }
    const existing = await ctx.db.query("safetyTeamRecipients").withIndex("by_email", (q) => q.eq("email", email)).unique()
    if (existing) {
      if (existing.active) return { ok: false as const, code: "DUPLICATE" as const, message: "That person is already on the team." }
      await ctx.db.patch(existing._id, { active: true, name: name || existing.name })
      return { ok: true as const }
    }
    await ctx.db.insert("safetyTeamRecipients", { email, name: name || email, active: true })
    return { ok: true as const }
  },
})

export const remove = mutation({
  args: { id: v.id("safetyTeamRecipients") },
  returns: mutateResult,
  handler: async (ctx, args) => {
    const requesterEmail = await currentEmail(ctx)
    if (!(await checkIsTeamMember(ctx, requesterEmail))) return { ok: false as const, code: "FORBIDDEN" as const, message: "You must be a signed-in team member to remove recipients." }
    const activeCount = (await ctx.db.query("safetyTeamRecipients").collect()).filter((r) => r.active).length
    if (activeCount <= 1) return { ok: false as const, code: "LAST_MEMBER" as const, message: "At least one team member must remain, or nobody could sign back in." }
    await ctx.db.patch(args.id, { active: false })
    return { ok: true as const }
  },
})
