import type { MutationCtx } from "./_generated/server"

// Human-readable, year-scoped sequential reference numbers ("AE-2026-0001").
// Called from inside convex/ae.ts's submitReport mutation — Convex mutations
// run as serialized transactions, so two concurrent submissions reading and
// incrementing the same counter document can never produce the same number.
export async function nextReferenceNumber(ctx: MutationCtx): Promise<string> {
  const year = new Date().getFullYear()
  const key = `aeReports-${year}`
  const existing = await ctx.db.query("counters").withIndex("by_key", (q) => q.eq("key", key)).unique()
  const next = (existing?.value ?? 0) + 1
  if (existing) await ctx.db.patch(existing._id, { value: next })
  else await ctx.db.insert("counters", { key, value: next })
  return `AE-${year}-${String(next).padStart(4, "0")}`
}
