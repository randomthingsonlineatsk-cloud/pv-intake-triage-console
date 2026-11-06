import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { useMemo, useState } from 'react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { SiteNav, FictionalBanner } from '@/components/site-nav'
import { TeamGate, SignOutButton } from '@/components/team-gate'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertTriangle, BellRing, Clock, Copy, Download, History, ListTodo, Mail, MailCheck, MailWarning, MessageSquare, RefreshCw, UserMinus, UserPlus } from 'lucide-react'
import siteMetadata from '@/metadata.json'

const meta = siteMetadata['/dashboard']

export const Route = createFileRoute('/dashboard')({
  head: () => ({ meta: [{ title: meta.title }, { name: 'description', content: meta.description }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: DashboardPage,
})

type Status = 'new' | 'in_review' | 'reported' | 'closed'

function relativeDue(dueAt: number | undefined): { text: string; overdue: boolean } | null {
  if (!dueAt) return null
  const days = Math.round((dueAt - Date.now()) / 86_400_000)
  if (days < 0) return { text: `Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`, overdue: true }
  if (days === 0) return { text: 'Due today', overdue: true }
  return { text: `Due in ${days} day${days === 1 ? '' : 's'}`, overdue: false }
}

function csvCell(value: unknown): string {
  const s = String(value ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const ALERT_LABEL = {
  reporter_confirmation: 'Reporter',
  expedited_team_alert: 'Team (urgent)',
  routine_team_notice: 'Team',
  escalation_reminder: 'Team (reminder)',
  followup_query: 'Reporter (follow-up)',
} as const

function DashboardPage() {
  return (
    <div className="min-h-screen bg-background">
      <SiteNav />
      <FictionalBanner />
      <TeamGate>
        <DashboardContent />
      </TeamGate>
    </div>
  )
}

function DashboardContent() {
  const reportsRes = useQuery(api.ae.listForTeam, {})
  const tasksRes = useQuery(api.ae.listTasksForTeam, {})
  const alertsRes = useQuery(api.ae.listAlertsForTeam, {})
  const completeTask = useMutation(api.ae.completeTask)
  const updateReportStatus = useMutation(api.ae.updateReportStatus)
  const retryAlert = useMutation(api.ae.retryAlert)
  const runReminders = useMutation(api.escalations.runNow)
  const [reminderNote, setReminderNote] = useState<string | null>(null)
  const [followUpFor, setFollowUpFor] = useState<{ id: Id<'aeReports'>; ref: string } | null>(null)
  const [auditFor, setAuditFor] = useState<{ id: Id<'aeReports'>; ref: string } | null>(null)

  const reports = reportsRes?.ok ? reportsRes.reports : []
  const tasks = tasksRes?.ok ? tasksRes.tasks : []
  const alerts = alertsRes?.ok ? alertsRes.alerts : []

  const refById = useMemo(() => new Map(reports.map((r) => [r._id as string, r.referenceNumber])), [reports])
  const tasksByReport = useMemo(() => {
    const m = new Map<string, typeof tasks>()
    for (const t of tasks) m.set(t.reportId, [...(m.get(t.reportId) ?? []), t])
    return m
  }, [tasks])
  const alertsByReport = useMemo(() => {
    const m = new Map<string, typeof alerts>()
    for (const a of alerts) m.set(a.reportId, [...(m.get(a.reportId) ?? []), a])
    return m
  }, [alerts])

  const byProduct = useMemo(() => {
    const m = new Map<string, { total: number; serious: number; expedited: number }>()
    for (const r of reports) {
      if (r.eventTerm.startsWith('(discarded')) continue
      const row = m.get(r.productName) ?? { total: 0, serious: 0, expedited: 0 }
      row.total++
      if (r.isSerious) row.serious++
      if (r.isExpedited) row.expedited++
      m.set(r.productName, row)
    }
    return [...m.entries()]
  }, [reports])

  if (reportsRes === undefined || tasksRes === undefined || alertsRes === undefined) {
    return <p className="mx-auto max-w-5xl px-6 py-10 text-sm text-ink-soft">Loading…</p>
  }
  if (!reportsRes.ok) {
    return <p className="mx-auto max-w-5xl px-6 py-10 text-sm text-destructive">{reportsRes.message}</p>
  }

  const real = reports.filter((r) => !r.eventTerm.startsWith('(discarded'))
  const expeditedReports = real.filter((r) => r.isExpedited)
  const routineReports = real.filter((r) => !r.isExpedited)
  const expeditedOpen = expeditedReports.filter((r) => r.status !== 'closed' && r.status !== 'reported').length
  const openTasks = tasks.filter((t) => !t.done).length
  const failedAlerts = alerts.filter((a) => a.status === 'failed').length

  function exportCsv() {
    const header = ['Reference', 'Received', 'Product', 'Event', 'Serious', 'Expected', 'Expedited', 'Causality', 'Due', 'Status']
    const lines = real.map((r) => [
      r.referenceNumber, new Date(r._creationTime).toISOString(), r.productName, r.eventTerm, r.isSerious, r.isExpected, r.isExpedited,
      r.causality, r.expeditedDueAt ? new Date(r.expeditedDueAt).toISOString() : '', r.status,
    ].map(csvCell).join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ae-report-log-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  function ReportTable({ rows }: { rows: typeof real }) {
    if (rows.length === 0) return <p className="py-8 text-center text-sm text-ink-soft">No reports in this view.</p>
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Reference</TableHead>
            <TableHead>Product / event</TableHead>
            <TableHead>Classification</TableHead>
            <TableHead>Task</TableHead>
            <TableHead>Emails</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r._id}>
              <TableCell className="align-top">
                <p className="font-mono text-xs font-medium text-ink">{r.referenceNumber}</p>
                <p className="text-[11px] text-ink-soft">{new Date(r._creationTime).toLocaleDateString()}</p>
                <Button variant="ghost" size="sm" className="mt-1 h-6 gap-1 px-1 text-[11px]" onClick={() => setAuditFor({ id: r._id, ref: r.referenceNumber })}>
                  <History className="size-3" /> History
                </Button>
                <Button variant="ghost" size="sm" className="h-6 gap-1 px-1 text-[11px]" onClick={() => setFollowUpFor({ id: r._id, ref: r.referenceNumber })}>
                  <MessageSquare className="size-3" /> Follow-up
                </Button>
              </TableCell>
              <TableCell className="align-top">
                <p className="font-medium text-ink">{r.eventTerm}</p>
                <p className="text-xs text-ink-soft">{r.productName}</p>
              </TableCell>
              <TableCell className="align-top">
                <div className="flex flex-wrap gap-1">
                  {r.isSerious && <Badge variant="outline" className="text-xs">Serious</Badge>}
                  {!r.isExpected && <Badge variant="outline" className="text-xs">Unexpected</Badge>}
                  {r.isExpedited && <Badge className="bg-urgent-soft text-urgent text-xs">Expedited</Badge>}
                  {r.possibleDuplicateOf && (
                    <Badge variant="outline" className="gap-1 text-xs"><Copy className="size-3" /> Possible duplicate of {refById.get(r.possibleDuplicateOf) ?? 'an earlier report'}</Badge>
                  )}
                  {r.lastEscalationStage && r.status !== 'reported' && r.status !== 'closed' && (
                    <Badge className="gap-1 bg-urgent-soft text-urgent text-xs"><BellRing className="size-3" /> {r.lastEscalationStage === 'overdue' ? 'Overdue reminder sent' : 'Due-soon reminder sent'}</Badge>
                  )}
                </div>
                <p className="mt-1 text-xs capitalize text-ink-soft">Causality: {r.causality}</p>
              </TableCell>
              <TableCell className="align-top">
                {(tasksByReport.get(r._id) ?? []).map((t) => {
                  const due = relativeDue(t.dueAt)
                  return (
                    <div key={t._id} className="flex items-start gap-2">
                      <Checkbox checked={t.done} onCheckedChange={(v) => void completeTask({ taskId: t._id, done: v === true })} className="mt-0.5" />
                      <div>
                        <p className={`text-xs ${t.done ? 'text-ink-soft line-through' : 'text-ink'}`}>{t.title}</p>
                        {due && !t.done && (
                          <p className={`flex items-center gap-1 text-[11px] ${due.overdue ? 'font-medium text-urgent' : 'text-ink-soft'}`}>
                            <Clock className="size-3" /> {due.text}
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </TableCell>
              <TableCell className="align-top">
                {(alertsByReport.get(r._id) ?? []).map((a) => (
                  <div key={a._id} className="mb-1 flex items-center gap-1.5 text-xs">
                    {a.status === 'sent' && <MailCheck className="size-3.5 shrink-0 text-routine" />}
                    {a.status === 'pending' && <Mail className="size-3.5 shrink-0 text-pending" />}
                    {a.status === 'failed' && <MailWarning className="size-3.5 shrink-0 text-urgent" />}
                    <span className={a.status === 'failed' ? 'text-urgent' : 'text-ink-soft'}>
                      {ALERT_LABEL[a.kind]}: {a.status}
                    </span>
                    {a.status === 'failed' && (
                      <Button variant="ghost" size="sm" className="h-5 gap-1 px-1 text-[11px]" onClick={() => void retryAlert({ alertId: a._id })}>
                        <RefreshCw className="size-3" /> Retry
                      </Button>
                    )}
                  </div>
                ))}
              </TableCell>
              <TableCell className="align-top">
                <Select value={r.status} onValueChange={(v) => void updateReportStatus({ reportId: r._id, status: v as Status })}>
                  <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new">New</SelectItem>
                    <SelectItem value="in_review">In review</SelectItem>
                    <SelectItem value="reported">Reported</SelectItem>
                    <SelectItem value="closed">Closed</SelectItem>
                  </SelectContent>
                </Select>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Triage dashboard</h1>
          <p className="mt-1.5 text-sm text-ink-soft">Every report, its computed classification, its task, and the delivery status of each email sent.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={async () => {
            const out = await runReminders({})
            setReminderNote(out.ok ? (out.escalated === 0 ? 'No new reminders needed.' : `Sent reminders for ${out.escalated} report${out.escalated === 1 ? '' : 's'}.`) : out.message)
          }}><BellRing className="size-4" /> Check deadlines</Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={exportCsv}><Download className="size-4" /> Export CSV</Button>
          <SignOutButton />
        </div>
      </div>

      {reminderNote && <p className="mt-3 text-right text-xs text-ink-soft" role="status">{reminderNote} Reminders also go out automatically every morning.</p>}

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Card><CardContent className="flex items-center gap-3 pt-6">
          <AlertTriangle className="size-8 text-urgent" />
          <div><p className="text-2xl font-semibold text-ink">{expeditedOpen}</p><p className="text-xs text-ink-soft">Open expedited reports</p></div>
        </CardContent></Card>
        <Card><CardContent className="flex items-center gap-3 pt-6">
          <ListTodo className="size-8 text-ink-soft" />
          <div><p className="text-2xl font-semibold text-ink">{openTasks}</p><p className="text-xs text-ink-soft">Open tasks</p></div>
        </CardContent></Card>
        <Card><CardContent className="flex items-center gap-3 pt-6">
          <MailWarning className={`size-8 ${failedAlerts > 0 ? 'text-urgent' : 'text-ink-soft'}`} />
          <div><p className="text-2xl font-semibold text-ink">{failedAlerts}</p><p className="text-xs text-ink-soft">Failed email deliveries</p></div>
        </CardContent></Card>
      </div>

      <Card className="mt-8">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Reports</CardTitle>
          <CardDescription>{real.length} report{real.length === 1 ? '' : 's'} logged</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="expedited">
            <TabsList>
              <TabsTrigger value="expedited">Expedited ({expeditedReports.length})</TabsTrigger>
              <TabsTrigger value="routine">Routine ({routineReports.length})</TabsTrigger>
              <TabsTrigger value="all">All ({real.length})</TabsTrigger>
            </TabsList>
            <TabsContent value="expedited"><ReportTable rows={expeditedReports} /></TabsContent>
            <TabsContent value="routine"><ReportTable rows={routineReports} /></TabsContent>
            <TabsContent value="all"><ReportTable rows={real} /></TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">By product</CardTitle>
            <CardDescription>Volume, seriousness and expedited cases</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {byProduct.length === 0 && <p className="text-sm text-ink-soft">No reports yet.</p>}
            {byProduct.map(([name, row]) => (
              <div key={name}>
                <div className="flex justify-between text-xs"><span className="font-medium text-ink">{name}</span><span className="text-ink-soft">{row.total} total · {row.serious} serious · {row.expedited} expedited</span></div>
                <div className="mt-1 h-2 overflow-hidden rounded bg-secondary">
                  <div className="h-full bg-routine" style={{ width: `${(row.total / Math.max(...byProduct.map(([, r]) => r.total))) * 100}%` }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
        <RecipientsCard />
      </div>

      <AuditDialog target={auditFor} onClose={() => setAuditFor(null)} />
      <FollowUpDialog target={followUpFor} onClose={() => setFollowUpFor(null)} />
    </main>
  )
}

function RecipientsCard() {
  const res = useQuery(api.recipients.list, {})
  const add = useMutation(api.recipients.add)
  const remove = useMutation(api.recipients.remove)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  async function onAdd(e: React.FormEvent) {
    e.preventDefault()
    setMessage(null)
    const r = await add({ email, name })
    if (r.ok) { setEmail(''); setName('') } else setMessage(r.message)
  }

  const recipients = res?.ok ? res.recipients.filter((r) => r.active) : []
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Safety team</CardTitle>
        <CardDescription>Everyone here is emailed about every new report and can sign in to this dashboard.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {recipients.map((r) => (
          <div key={r._id} className="flex items-center justify-between text-sm">
            <div><p className="font-medium text-ink">{r.name}</p><p className="text-xs text-ink-soft">{r.email}</p></div>
            <Button variant="ghost" size="icon" aria-label={`Remove ${r.email}`} onClick={async () => {
              const out = await remove({ id: r._id })
              if (!out.ok) setMessage(out.message)
            }}><UserMinus className="size-4" /></Button>
          </div>
        ))}
        <form onSubmit={onAdd} className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" required className="sm:w-32" />
          <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="Email" required />
          <Button type="submit" size="sm" className="gap-1.5"><UserPlus className="size-4" /> Add</Button>
        </form>
        {message && <p className="text-xs text-destructive">{message}</p>}
      </CardContent>
    </Card>
  )
}

function AuditDialog({ target, onClose }: { target: { id: Id<'aeReports'>; ref: string } | null; onClose: () => void }) {
  const res = useQuery(api.ae.listAuditLog, target ? { reportId: target.id } : 'skip')
  return (
    <Dialog open={target !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>History — {target?.ref}</DialogTitle>
          <DialogDescription>Status changes, reminders and follow-ups, who made them, and when.</DialogDescription>
        </DialogHeader>
        {res === undefined ? (
          <p className="text-sm text-ink-soft">Loading…</p>
        ) : !res.ok ? (
          <p className="text-sm text-destructive">{res.message}</p>
        ) : res.entries.length === 0 ? (
          <p className="text-sm text-ink-soft">Nothing recorded yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {res.entries.map((e) => (
              <li key={e._id} className="rounded border border-border p-2">
                <p className="text-ink">
                  {e.action === 'status_change' ? (
                    <><span className="capitalize">{(e.fromValue ?? '').replace('_', ' ')}</span> → <span className="capitalize">{(e.toValue ?? '').replace('_', ' ')}</span></>
                  ) : e.action === 'escalation_reminder' ? (
                    <>Deadline reminder sent ({(e.toValue ?? '').replace('_', ' ')})</>
                  ) : e.action === 'follow_up_sent' ? (
                    <>Follow-up emailed to reporter</>
                  ) : e.action === 'reporter_reply_logged' ? (
                    <>Reporter reply recorded</>
                  ) : (
                    <>{e.action.replace(/_/g, ' ')}</>
                  )}
                </p>
                <p className="text-xs text-ink-soft">{e.actorEmail} · {new Date(e._creationTime).toLocaleString()}</p>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}

function FollowUpDialog({ target, onClose }: { target: { id: Id<'aeReports'>; ref: string } | null; onClose: () => void }) {
  const res = useQuery(api.followups.listForReport, target ? { reportId: target.id } : 'skip')
  const send = useMutation(api.followups.sendToReporter)
  const logReply = useMutation(api.followups.logReply)
  const [text, setText] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(kind: 'send' | 'reply') {
    if (!target) return
    setBusy(true)
    setNote(null)
    const out = await (kind === 'send' ? send({ reportId: target.id, message: text }) : logReply({ reportId: target.id, message: text }))
    setBusy(false)
    if (out.ok) setText('')
    else setNote(out.message)
  }

  return (
    <Dialog open={target !== null} onOpenChange={(o) => { if (!o) { onClose(); setText(''); setNote(null) } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Follow-up — {target?.ref}</DialogTitle>
          <DialogDescription>Email the reporter a question, and record what they say back. Replies are not received automatically, so log them here.</DialogDescription>
        </DialogHeader>
        <div className="max-h-56 space-y-2 overflow-y-auto text-sm">
          {res === undefined ? <p className="text-ink-soft">Loading…</p> : !res.ok ? <p className="text-destructive">{res.message}</p> : res.items.length === 0 ? (
            <p className="text-ink-soft">No correspondence yet.</p>
          ) : res.items.map((i) => (
            <div key={i._id} className={`rounded border border-border p-2 ${i.direction === 'from_reporter' ? 'bg-secondary' : ''}`}>
              <p className="whitespace-pre-wrap text-ink">{i.message}</p>
              <p className="mt-1 text-xs text-ink-soft">{i.direction === 'to_reporter' ? 'Sent to reporter' : 'Reporter replied'} · {i.authorEmail} · {new Date(i._creationTime).toLocaleString()}</p>
            </div>
          ))}
        </div>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={2000} placeholder="Write a question for the reporter, or paste their reply…" aria-label="Message" />
        {note && <p className="text-xs text-destructive">{note}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" disabled={busy || !text.trim()} onClick={() => void run('reply')}>Log reporter reply</Button>
          <Button size="sm" className="gap-1.5" disabled={busy || !text.trim()} onClick={() => void run('send')}><Mail className="size-4" /> Email reporter</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
