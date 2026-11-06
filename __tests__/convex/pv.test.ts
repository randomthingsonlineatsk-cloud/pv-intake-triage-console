/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import { processEscalations } from "../../convex/escalations"
import { canonicalTerm } from "../../convex/pvReferenceData"

const modules = import.meta.glob("../../convex/**/*.*s")

const base = {
  productId: "product-a",
  patientAgeYears: 40,
  patientSex: "female" as const,
  eventDescription: "details",
  eventOnsetDate: "2026-10-01",
  reporterName: "Rita",
  reporterEmail: "rita@example.com",
  reporterType: "healthcare_professional" as const,
  causality: "related" as const,
  seriousnessCriteria: [] as ("hospitalization" | "death")[],
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe("synonyms and expectedness", () => {
  it("maps everyday wording to the label term", () => {
    expect(canonicalTerm("Throwing  up")).toBe("vomiting")
    expect(canonicalTerm("Tired")).toBe("fatigue")
    expect(canonicalTerm("something new")).toBe("something new")
  })

  it("treats 'feeling sick' as the listed event nausea, so a serious case is not expedited", async () => {
    const t = convexTest(schema, modules)
    const r = await t.mutation(api.ae.create, { ...base, eventTerm: "feeling sick", seriousnessCriteria: ["hospitalization"] })
    expect(r.isExpedited).toBe(false)
  })

  it("an unlisted serious related event is expedited", async () => {
    const t = convexTest(schema, modules)
    const r = await t.mutation(api.ae.create, { ...base, eventTerm: "seizure", seriousnessCriteria: ["hospitalization"] })
    expect(r.isExpedited).toBe(true)
  })
})

describe("duplicate detection", () => {
  it("flags a same-patient, same-event report and still accepts it", async () => {
    const t = convexTest(schema, modules)
    const first = await t.mutation(api.ae.create, { ...base, eventTerm: "headache" })
    const second = await t.mutation(api.ae.create, { ...base, reporterEmail: "other@example.com", eventTerm: "Head ache", eventOnsetDate: "2026-10-03" })
    const row = await t.run((ctx) => ctx.db.get(second.reportId))
    expect(row?.possibleDuplicateOf).toBe(first.reportId)
  })

  it("does not flag a different event or a distant onset", async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.ae.create, { ...base, eventTerm: "headache" })
    const diffEvent = await t.mutation(api.ae.create, { ...base, reporterEmail: "b@example.com", eventTerm: "fatigue" })
    const farOnset = await t.mutation(api.ae.create, { ...base, reporterEmail: "c@example.com", eventTerm: "headache", eventOnsetDate: "2026-10-20" })
    expect((await t.run((ctx) => ctx.db.get(diffEvent.reportId)))?.possibleDuplicateOf).toBeUndefined()
    expect((await t.run((ctx) => ctx.db.get(farOnset.reportId)))?.possibleDuplicateOf).toBeUndefined()
  })

  it("flags the same reporter re-submitting the same product and event", async () => {
    const t = convexTest(schema, modules)
    const first = await t.mutation(api.ae.create, { ...base, eventTerm: "fatigue", patientAgeYears: 30 })
    const again = await t.mutation(api.ae.create, { ...base, eventTerm: "fatigue", patientAgeYears: 55, eventOnsetDate: "2026-12-01" })
    expect((await t.run((ctx) => ctx.db.get(again.reportId)))?.possibleDuplicateOf).toBe(first.reportId)
  })
})

describe("deadline reminders", () => {
  async function setup() {
    const t = convexTest(schema, modules)
    await t.run((ctx) => ctx.db.insert("safetyTeamRecipients", { email: "a@team.test", name: "A", active: true }))
    await t.run((ctx) => ctx.db.insert("safetyTeamRecipients", { email: "b@team.test", name: "B", active: true }))
    await t.run((ctx) => ctx.db.insert("safetyTeamRecipients", { email: "gone@team.test", name: "Gone", active: false }))
    const r = await t.mutation(api.ae.create, { ...base, eventTerm: "seizure", seriousnessCriteria: ["hospitalization"] })
    const row = await t.run((ctx) => ctx.db.get(r.reportId))
    return { t, id: r.reportId, due: row!.expeditedDueAt! }
  }
  const remindersFor = (t: ReturnType<typeof convexTest>) =>
    t.run((ctx) => ctx.db.query("alerts").collect().then((a) => a.filter((x) => x.kind === "escalation_reminder")))

  it("sends nothing while the deadline is far away", async () => {
    const { t, due } = await setup()
    expect(await t.run((ctx) => processEscalations(ctx, due - 10 * 86_400_000))).toBe(0)
    expect(await remindersFor(t)).toHaveLength(0)
  })

  it("sends one due-soon reminder per active member, once", async () => {
    const { t, due } = await setup()
    expect(await t.run((ctx) => processEscalations(ctx, due - 2 * 86_400_000))).toBe(1)
    expect(await t.run((ctx) => processEscalations(ctx, due - 1 * 86_400_000))).toBe(0)
    const sent = await remindersFor(t)
    expect(sent.map((a) => a.recipientEmail).sort()).toEqual(["a@team.test", "b@team.test"])
  })

  it("escalates again when overdue, and stops once the report is reported", async () => {
    const { t, id, due } = await setup()
    await t.run((ctx) => processEscalations(ctx, due - 2 * 86_400_000))
    expect(await t.run((ctx) => processEscalations(ctx, due + 86_400_000))).toBe(1)
    expect(await remindersFor(t)).toHaveLength(4)
    await t.run((ctx) => ctx.db.patch(id, { status: "reported", lastEscalationStage: undefined }))
    expect(await t.run((ctx) => processEscalations(ctx, due + 5 * 86_400_000))).toBe(0)
  })
})

describe("access control on new endpoints", () => {
  it("refuses follow-ups, reminder runs and correspondence reads when not signed in", async () => {
    const t = convexTest(schema, modules)
    const r = await t.mutation(api.ae.create, { ...base, eventTerm: "headache" })
    expect((await t.mutation(api.followups.sendToReporter, { reportId: r.reportId, message: "hi" })).ok).toBe(false)
    expect((await t.mutation(api.followups.logReply, { reportId: r.reportId, message: "hi" })).ok).toBe(false)
    expect((await t.query(api.followups.listForReport, { reportId: r.reportId })).ok).toBe(false)
    expect((await t.mutation(api.escalations.runNow, {})).ok).toBe(false)
  })

  it("lets a team member email the reporter and log a reply", async () => {
    const t = convexTest(schema, modules)
    await t.run((ctx) => ctx.db.insert("safetyTeamRecipients", { email: "a@team.test", name: "A", active: true }))
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "a@team.test" }))
    const as = t.withIdentity({ subject: `${userId}|session1` })
    const r = await t.mutation(api.ae.create, { ...base, eventTerm: "headache" })
    expect((await as.mutation(api.followups.sendToReporter, { reportId: r.reportId, message: "What dose?" })).ok).toBe(true)
    expect((await as.mutation(api.followups.logReply, { reportId: r.reportId, message: "10 mg" })).ok).toBe(true)
    const list = await as.query(api.followups.listForReport, { reportId: r.reportId })
    expect(list.ok && list.items.map((i) => i.direction)).toEqual(["to_reporter", "from_reporter"])
    const out = await t.run((ctx) => ctx.db.query("alerts").collect().then((a) => a.filter((x) => x.kind === "followup_query")))
    expect(out).toHaveLength(1)
    expect(out[0].recipientEmail).toBe("rita@example.com")
  })
})
