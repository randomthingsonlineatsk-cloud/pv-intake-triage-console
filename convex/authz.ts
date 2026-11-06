import { v } from "convex/values"
import { query } from "./_generated/server"
import type { QueryCtx } from "./_generated/server"
import { getAuthUserId } from "@convex-dev/auth/server"

// Dashboard access AND the notification list are governed by the same
// table (safetyTeamRecipients) — anyone signed in whose email matches an
// active row is a team member: they can see the dashboard and they receive
// report notifications. This mirrors how a real shared team inbox works,
// and means adding someone to receive alerts also gives them the access
// they'd need to act on those alerts.
//
// Never throws for an authorization failure — returns a plain boolean, per
// the Gate & Return Union pattern. Callers gate rendering on this value;
// data-returning queries and mutations re-check it themselves (see
// convex/recipients.ts and convex/ae.ts) rather than trusting the client.
export const isTeamMember = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx)
    if (!userId) return false
    const user = await ctx.db.get(userId)
    if (!user?.email) return false
    const recipient = await ctx.db
      .query("safetyTeamRecipients")
      .withIndex("by_email", (q) => q.eq("email", user.email!.toLowerCase()))
      .unique()
    return recipient?.active ?? false
  },
})

// Internal helper other Convex functions call directly (not a query the
// client can call) — same check, reusable from mutations.
export async function checkIsTeamMember(ctx: Pick<QueryCtx, "db">, email?: string | null): Promise<boolean> {
  if (!email) return false
  const recipient = await ctx.db
    .query("safetyTeamRecipients")
    .withIndex("by_email", (q) => q.eq("email", email.toLowerCase()))
    .unique()
  return recipient?.active ?? false
}
