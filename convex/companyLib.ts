import { getAuthUserId } from "@convex-dev/auth/server"
import type { QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { PRODUCTS, findProduct, type ProductRef } from "./pvReferenceData"

// Shared multi-company helpers (plain functions, not Convex endpoints).
//
// Legacy rule: rows created before multi-company support have no companyId.
// They belong to the single "default" company, so every scoped lookup for the
// default company also matches rows whose companyId is undefined.

type Db = Pick<QueryCtx, "db">

export function companyKeys(c: Doc<"companies">): (Id<"companies"> | undefined)[] {
  return c.isDefault ? [undefined, c._id] : [c._id]
}

export function reportInCompany(report: { companyId?: Id<"companies"> }, c: Doc<"companies">): boolean {
  return c.isDefault ? report.companyId === undefined || report.companyId === c._id : report.companyId === c._id
}

export async function getDefaultCompany(ctx: Db): Promise<Doc<"companies"> | null> {
  return await ctx.db.query("companies").withIndex("by_isDefault", (q) => q.eq("isDefault", true)).first()
}

export async function companyRecipients(ctx: Db, c: Doc<"companies">) {
  const out: Doc<"safetyTeamRecipients">[] = []
  for (const key of companyKeys(c)) {
    out.push(...(await ctx.db.query("safetyTeamRecipients").withIndex("by_companyId", (q) => q.eq("companyId", key)).collect()))
  }
  return out
}

export async function companyReports(ctx: Db, c: Doc<"companies">, limit: number) {
  const out: Doc<"aeReports">[] = []
  for (const key of companyKeys(c)) {
    out.push(...(await ctx.db.query("aeReports").withIndex("by_companyId", (q) => q.eq("companyId", key)).order("desc").take(limit)))
  }
  return out.sort((a, b) => b._creationTime - a._creationTime).slice(0, limit)
}

export type Access = { ok: true; email: string; company: Doc<"companies"> } | { ok: false }

/** Signed in AND an active member of this company's team. */
export async function memberAccess(ctx: Pick<QueryCtx, "db" | "auth">, companyId: Id<"companies">): Promise<Access> {
  const userId = await getAuthUserId(ctx)
  const user = userId ? await ctx.db.get(userId) : null
  const email = user?.email?.toLowerCase()
  if (!email) return { ok: false }
  const company = await ctx.db.get(companyId)
  if (!company) return { ok: false }
  const isMember = (await companyRecipients(ctx, company)).some((r) => r.active && r.email === email)
  return isMember ? { ok: true, email, company } : { ok: false }
}

export const FORBIDDEN = { ok: false as const, code: "FORBIDDEN" as const, message: "You must be a signed-in member of this company's safety team." }

/** Resolves a product for a company: built-in Products A-C for the default company, its own products otherwise. */
export async function resolveProduct(ctx: Db, company: Doc<"companies"> | null, productId: string): Promise<(ProductRef & { id: string }) | null> {
  if (!company || company.isDefault) {
    const p = findProduct(productId)
    return p ?? null
  }
  const id = ctx.db.normalizeId("companyProducts", productId)
  if (!id) return null
  const doc = await ctx.db.get(id)
  if (!doc || doc.companyId !== company._id) return null
  return { id: doc._id, name: doc.name, description: doc.description, knownEvents: doc.knownEvents }
}

export async function listCompanyProducts(ctx: Db, c: Doc<"companies">): Promise<ProductRef[]> {
  if (c.isDefault) return PRODUCTS
  const docs = await ctx.db.query("companyProducts").withIndex("by_companyId", (q) => q.eq("companyId", c._id)).collect()
  return docs.map((d) => ({ id: d._id, name: d.name, description: d.description, knownEvents: d.knownEvents }))
}
