import { Link } from '@tanstack/react-router'
import { ClipboardList, LayoutDashboard, ShieldAlert } from 'lucide-react'

export function SiteNav() {
  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2.5">
          <ShieldAlert className="size-6 text-routine" />
          <div>
            <p className="text-sm font-semibold leading-tight text-ink">PV Intake & Triage Console</p>
            <p className="text-[11px] leading-tight text-ink-soft">Fictional portfolio demonstration</p>
          </div>
        </div>
        <nav className="flex items-center gap-1">
          <Link
            to="/"
            activeOptions={{ exact: true }}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-ink-soft transition-colors hover:bg-secondary hover:text-ink"
            activeProps={{ className: '!bg-secondary !text-ink' }}
          >
            <ClipboardList className="size-4" /> Report an event
          </Link>
          <Link
            to="/dashboard"
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-ink-soft transition-colors hover:bg-secondary hover:text-ink"
            activeProps={{ className: '!bg-secondary !text-ink' }}
          >
            <LayoutDashboard className="size-4" /> Dashboard
          </Link>
        </nav>
      </div>
    </header>
  )
}

export function FictionalBanner() {
  return (
    <p className="mx-auto max-w-5xl px-6 pt-3 text-center text-[11px] uppercase tracking-widest text-ink-soft/60">
      All products, reports, and people on this page are fictional — a workflow demonstration, not a real safety system
    </p>
  )
}
