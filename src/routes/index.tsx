import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { useState } from 'react'
import { api } from '@/convex/_generated/api'
import { SiteNav, FictionalBanner } from '@/components/site-nav'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { CheckCircle2, CircleAlert, Send } from 'lucide-react'
import siteMetadata from '@/metadata.json'

const meta = siteMetadata['/']

export const Route = createFileRoute('/')({
  head: () => ({ meta: [{ title: meta.title }, { name: 'description', content: meta.description }] }),
  component: IntakePage,
})

type SeriousnessCriterion = 'death' | 'life_threatening' | 'hospitalization' | 'disability' | 'congenital_anomaly' | 'other_medically_important'

const SERIOUSNESS_OPTIONS: { value: SeriousnessCriterion; label: string }[] = [
  { value: 'death', label: 'Resulted in death' },
  { value: 'life_threatening', label: 'Life-threatening' },
  { value: 'hospitalization', label: 'Caused or prolonged hospitalization' },
  { value: 'disability', label: 'Persistent or significant disability' },
  { value: 'congenital_anomaly', label: 'Congenital anomaly / birth defect' },
  { value: 'other_medically_important', label: 'Other medically important event' },
]

type Result = { reportId: string; referenceNumber: string; isExpedited: boolean; reporterEmail: string }

function IntakePage() {
  const products = useQuery(api.ae.listProducts, {})
  const createReport = useMutation(api.ae.create)

  const [productId, setProductId] = useState('')
  const [patientAgeYears, setPatientAgeYears] = useState('')
  const [patientSex, setPatientSex] = useState<'male' | 'female' | 'unknown'>('unknown')
  const [eventTerm, setEventTerm] = useState('')
  const eventTermOptions = useQuery(api.ae.listEventTerms, productId ? { productId } : 'skip')
  const [eventDescription, setEventDescription] = useState('')
  const [eventOnsetDate, setEventOnsetDate] = useState('')
  const [reporterName, setReporterName] = useState('')
  const [reporterEmail, setReporterEmail] = useState('')
  const [reporterType, setReporterType] = useState<'healthcare_professional' | 'consumer' | 'other'>('healthcare_professional')
  const [causality, setCausality] = useState<'related' | 'possible' | 'unrelated'>('possible')
  // Honeypot — real people never see this field (it is positioned off-screen and skipped by keyboard and screen readers).
  const [website, setWebsite] = useState('')
  const [seriousness, setSeriousness] = useState<Set<SeriousnessCriterion>>(new Set())

  const [state, setState] = useState<'idle' | 'submitting' | 'error'>('idle')
  const [error, setError] = useState('')
  const [result, setResult] = useState<Result | null>(null)

  function toggleSeriousness(value: SeriousnessCriterion) {
    setSeriousness((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  function resetForm() {
    setProductId(''); setPatientAgeYears(''); setPatientSex('unknown'); setEventTerm(''); setEventDescription('')
    setEventOnsetDate(''); setReporterName(''); setReporterEmail(''); setReporterType('healthcare_professional')
    setCausality('possible'); setSeriousness(new Set()); setWebsite('')
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setState('submitting')
    setError('')
    try {
      const submittedEmail = reporterEmail.trim().toLowerCase()
      const res = await createReport({
        productId,
        patientAgeYears: patientAgeYears ? Number(patientAgeYears) : undefined,
        patientSex,
        eventTerm,
        eventDescription,
        eventOnsetDate,
        reporterName,
        reporterEmail,
        reporterType,
        causality,
        seriousnessCriteria: [...seriousness],
        website,
      })
      setResult({ ...res, reporterEmail: submittedEmail })
      setState('idle')
      resetForm()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setState('error')
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <SiteNav />
      <FictionalBanner />

      <main className="mx-auto max-w-2xl px-6 py-10">
        <h1 className="text-2xl font-semibold text-ink">Report an adverse event</h1>
        <p className="mt-1.5 text-sm text-ink-soft">
          Submitting this form classifies the report automatically — seriousness, expectedness (checked against the product's reference safety
          information), and whether it triggers expedited regulatory reporting. You get an emailed confirmation with a reference number, and the
          safety team is notified of every report, with urgent handling for expedited cases.
        </p>

        {result && (
          <Alert className={`mt-6 ${result.isExpedited ? 'border-urgent/40 bg-urgent-soft' : 'border-routine/40 bg-routine-soft'}`}>
            {result.isExpedited ? <CircleAlert className="size-4 text-urgent" /> : <CheckCircle2 className="size-4 text-routine" />}
            <AlertTitle className={result.isExpedited ? 'text-urgent' : 'text-routine'}>
              Report received — reference {result.referenceNumber}
            </AlertTitle>
            <AlertDescription className="text-ink-soft">
              A confirmation with this reference number is being emailed to {result.reporterEmail}. Keep the number for any follow-up.{' '}
              {result.isExpedited
                ? 'This report was classified serious, unexpected, and causally related or possible, so it was escalated to the safety team as an expedited case.'
                : 'This report did not meet the criteria for expedited reporting; the safety team has been notified and it will go into the next periodic safety report.'}
            </AlertDescription>
          </Alert>
        )}

        <form onSubmit={onSubmit} className="mt-6 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Product and event</CardTitle>
              <CardDescription>What happened, and to which product.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="product">Product</Label>
                <Select value={productId} onValueChange={setProductId} required>
                  <SelectTrigger id="product" className="mt-1.5 w-full"><SelectValue placeholder="Select a product…" /></SelectTrigger>
                  <SelectContent>
                    {(products ?? []).map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="eventTerm">Adverse event term</Label>
                  <Input id="eventTerm" required value={eventTerm} onChange={(e) => setEventTerm(e.target.value)} placeholder="e.g. nausea, rash, syncope" className="mt-1.5" list="eventTermOptions" autoComplete="off" />
                  <datalist id="eventTermOptions">
                    {(eventTermOptions ?? []).map((t) => <option key={t} value={t} />)}
                  </datalist>
                  <p className="mt-1 text-xs text-ink-soft">Pick a suggestion or type your own. Everyday wording such as “throwing up” is matched to the clinical term.</p>
                </div>
                <div>
                  <Label htmlFor="onsetDate">Onset date</Label>
                  <Input id="onsetDate" required type="date" value={eventOnsetDate} onChange={(e) => setEventOnsetDate(e.target.value)} className="mt-1.5" />
                </div>
              </div>
              <div>
                <Label htmlFor="description">Event description</Label>
                <Textarea id="description" required rows={4} value={eventDescription} onChange={(e) => setEventDescription(e.target.value)} placeholder="Describe what happened, timing relative to dosing, and any relevant history." className="mt-1.5" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Patient</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="age">Age (years, optional)</Label>
                <Input id="age" type="number" min={0} max={120} value={patientAgeYears} onChange={(e) => setPatientAgeYears(e.target.value)} className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="sex">Sex</Label>
                <Select value={patientSex} onValueChange={(v) => setPatientSex(v as typeof patientSex)}>
                  <SelectTrigger id="sex" className="mt-1.5 w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="female">Female</SelectItem>
                    <SelectItem value="male">Male</SelectItem>
                    <SelectItem value="unknown">Unknown</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Seriousness</CardTitle>
              <CardDescription>Check every criterion that applies. Leave all unchecked if none apply — this is what "non-serious" means here, not a severity rating.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2.5">
              {SERIOUSNESS_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-center gap-2.5 text-sm text-ink">
                  <Checkbox checked={seriousness.has(opt.value)} onCheckedChange={() => toggleSeriousness(opt.value)} />
                  {opt.label}
                </label>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Causality</CardTitle>
              <CardDescription>Your assessment of whether the product could have caused this event.</CardDescription>
            </CardHeader>
            <CardContent>
              <RadioGroup value={causality} onValueChange={(v) => setCausality(v as typeof causality)} className="gap-2.5">
                {(['related', 'possible', 'unrelated'] as const).map((c) => (
                  <label key={c} className="flex items-center gap-2.5 text-sm text-ink capitalize">
                    <RadioGroupItem value={c} /> {c}
                  </label>
                ))}
              </RadioGroup>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Reporter</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="reporterName">Name</Label>
                <Input id="reporterName" required value={reporterName} onChange={(e) => setReporterName(e.target.value)} className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="reporterEmail">Email</Label>
                <Input id="reporterEmail" required type="email" value={reporterEmail} onChange={(e) => setReporterEmail(e.target.value)} className="mt-1.5" />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="reporterType">Reporter type</Label>
                <Select value={reporterType} onValueChange={(v) => setReporterType(v as typeof reporterType)}>
                  <SelectTrigger id="reporterType" className="mt-1.5 w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="healthcare_professional">Healthcare professional</SelectItem>
                    <SelectItem value="consumer">Consumer / patient</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
            <label htmlFor="website">Leave this field empty</label>
            <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
          </div>

          {state === 'error' && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={state === 'submitting' || !productId} className="w-full gap-2">
            <Send className="size-4" /> {state === 'submitting' ? 'Submitting…' : 'Submit report'}
          </Button>
        </form>
      </main>
    </div>
  )
}
