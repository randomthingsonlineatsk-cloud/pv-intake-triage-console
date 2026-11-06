import { v } from "convex/values"
import { getAuthUserId } from "@convex-dev/auth/server"
import { internalMutation, mutation, query } from "./_generated/server"
import type { Id } from "./_generated/dataModel"
import { eventTermSuggestions } from "./pvReferenceData"
import { getDefaultCompany, listCompanyProducts, memberAccess, resolveProduct } from "./companyLib"

const MAX_COMPANIES_PER_USER = 3
const MAX_COMPANIES_LISTED = 200

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "company"
}

function newToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

// One-time: creates the default company that owns all pre-existing Products A-C
// data. Run once per deployment (`npx convex run companies:bootstrapDefault`).
export const bootstrapDefault = internalMutation({
  args: {},
  returns: v.union(v.literal("created"), v.literal("exists")),
  handler: async (ctx) => {
    if (await getDefaultCompany(ctx)) return "exists"
    await ctx.db.insert("companies", { name: "Demo Pharma (original demo)", slug: "demo-pharma", accessToken: newToken(), isDefault: true, createdByEmail: "system" })
    return "created"
  },
})

// Public directory shown on the report form. Never includes the access token.
export const listPublic = query({
  args: {},
  returns: v.array(v.object({ id: v.id("companies"), name: v.string() })),
  handler: async (ctx) => {
    const rows = await ctx.db.query("companies").take(MAX_COMPANIES_LISTED)
    return rows.map((c) => ({ id: c._id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name))
  },
})

export const listProductsPublic = query({
  args: { companyId: v.id("companies") },
  returns: v.array(v.object({ id: v.string(), name: v.string(), description: v.string() })),
  handler: async (ctx, { companyId }) => {
    const company = await ctx.db.get(companyId)
    if (!company) return []
    return (await listCompanyProducts(ctx, company)).map(({ id, name, description }) => ({ id, name, description }))
  },
})

export const listEventTermsFor = query({
  args: { companyId: v.id("companies"), productId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, { companyId, productId }) => {
    const company = await ctx.db.get(companyId)
    if (!company) return []
    const product = await resolveProduct(ctx, company, productId)
    return product ? eventTermSuggestions(product) : []
  },
})

const createResult = v.union(
  v.object({ ok: v.literal(true), token: v.string(), companyId: v.id("companies") }),
  v.object({ ok: v.literal(false), message: v.string() }),
)

// Anyone can create a demo company, but only after proving they own an email
// address by signing in with a code. They become its first team member.
export const create = mutation({
  args: { name: v.string(), confirmFictional: v.boolean() },
  returns: createResult,
  handler: async (ctx, { name, confirmFictional }) => {
    const userId = await getAuthUserId(ctx)
    const user = userId ? await ctx.db.get(userId) : null
    const email = user?.email?.toLowerCase()
    if (!email) return { ok: false as const, message: "Sign in first." }
    if (!confirmFictional) return { ok: false as const, message: "Please confirm this is a fictional demo company." }
    const clean = name.trim().replace(/\s+/g, " ")
    if (clean.length < 2 || clean.length > 60) return { ok: false as const, message: "Use a company name between 2 and 60 characters." }

    const mine = await ctx.db.query("companies").withIndex("by_createdByEmail", (q) => q.eq("createdByEmail", email)).collect()
    if (mine.length >= MAX_COMPANIES_PER_USER) return { ok: false as const, message: `Each account can create up to ${MAX_COMPANIES_PER_USER} demo companies.` }
    const lower = clean.toLowerCase()
    const all = await ctx.db.query("companies").take(MAX_COMPANIES_LISTED)
    if (all.some((c) => c.name.toLowerCase() === lower)) return { ok: false as const, message: "A company with that name already exists." }

    const token = newToken()
    const companyId = await ctx.db.insert("companies", { name: clean, slug: slugify(clean), accessToken: token, isDefault: false, createdByEmail: email })
    await ctx.db.insert("safetyTeamRecipients", { email, name: user?.name || email.split("@")[0], active: true, companyId })
    await ctx.db.insert("companyProducts", {
      companyId,
      name: "Sample product (rename me)",
      description: "A placeholder product. Edit or replace it in your dashboard.",
      knownEvents: ["nausea", "headache"],
    })
    return { ok: true as const, token, companyId }
  },
})

const companySummary = v.object({ id: v.id("companies"), name: v.string(), token: v.string(), isDefault: v.boolean() })

// The companies the signed-in user belongs to, with their private links.
export const listMine = query({
  args: {},
  returns: v.union(v.object({ ok: v.literal(true), companies: v.array(companySummary) }), v.object({ ok: v.literal(false) })),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx)
    const user = userId ? await ctx.db.get(userId) : null
    const email = user?.email?.toLowerCase()
    if (!email) return { ok: false as const }
    const mine = (await ctx.db.query("safetyTeamRecipients").withIndex("by_email", (q) => q.eq("email", email)).collect()).filter((r) => r.active)
    const def = await getDefaultCompany(ctx)
    const out: { id: Id<"companies">; name: string; token: string; isDefault: boolean }[] = []
    const seen = new Set<string>()
    for (const r of mine) {
      const company = r.companyId ? await ctx.db.get(r.companyId) : def
      if (!company || seen.has(company._id)) continue
      seen.add(company._id)
      out.push({ id: company._id, name: company.name, token: company.accessToken, isDefault: company.isDefault })
    }
    return { ok: true as const, companies: out.sort((a, b) => a.name.localeCompare(b.name)) }
  },
})

// Opens a company dashboard from its private link. The same answer is given for
// a wrong token and for a non-member, so the link cannot be probed.
export const getAccess = query({
  args: { token: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), company: v.object({ id: v.id("companies"), name: v.string(), isDefault: v.boolean() }) }),
    v.object({ ok: v.literal(false), code: v.literal("FORBIDDEN"), message: v.string() }),
  ),
  handler: async (ctx, { token }) => {
    const denied = { ok: false as const, code: "FORBIDDEN" as const, message: "This link is not valid for your account." }
    if (token.length < 16) return denied
    const company = await ctx.db.query("companies").withIndex("by_accessToken", (q) => q.eq("accessToken", token)).unique()
    if (!company) return denied
    const access = await memberAccess(ctx, company._id)
    if (!access.ok) return denied
    return { ok: true as const, company: { id: company._id, name: company.name, isDefault: company.isDefault } }
  },
})
