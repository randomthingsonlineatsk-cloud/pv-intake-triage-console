import { Authenticated, AuthLoading, Unauthenticated, useQuery } from 'convex/react'
import { useAuthActions } from '@convex-dev/auth/react'
import { useState } from 'react'
import { api } from '@/convex/_generated/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Lock } from 'lucide-react'

function SignInForm() {
  const { signIn } = useAuthActions()
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function sendCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const formData = new FormData(e.currentTarget)
      setEmail(String(formData.get('email') ?? ''))
      await signIn('resend-otp', formData)
      setStep('code')
    } catch {
      setError('Could not send a verification code. Check the address and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function verify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await signIn('resend-otp', new FormData(e.currentTarget))
    } catch {
      setError('That code is not valid or has expired. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md items-center px-6">
      <Card className="w-full">
        <CardHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-routine-soft">
            <Lock className="size-5 text-routine" />
          </div>
          <CardTitle>Safety team sign-in</CardTitle>
          <CardDescription>
            The dashboard contains patient-level report details, so it is limited to safety team members. We will email you a 6-digit code.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {step === 'email' ? (
            <form onSubmit={sendCode} className="space-y-4">
              <div>
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" required disabled={busy} placeholder="you@example.com" className="mt-1.5" />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={busy} className="w-full">{busy ? 'Sending…' : 'Send code'}</Button>
            </form>
          ) : (
            <form onSubmit={verify} className="space-y-4">
              <p className="text-sm text-ink-soft">We sent a code to {email}.</p>
              <input type="hidden" name="email" value={email} />
              <div>
                <Label htmlFor="code">Verification code</Label>
                <Input id="code" name="code" type="text" inputMode="numeric" pattern="\d{6}" required disabled={busy} placeholder="6-digit code" className="mt-1.5" />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={busy} className="w-full">{busy ? 'Verifying…' : 'Verify and sign in'}</Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => { setStep('email'); setError(null) }} className="w-full">Use a different email</Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function MembershipCheck({ children }: { children: React.ReactNode }) {
  const isMember = useQuery(api.authz.isTeamMember, {})
  const { signOut } = useAuthActions()
  if (isMember === undefined) return <p className="mx-auto max-w-5xl px-6 py-10 text-sm text-ink-soft">Checking access…</p>
  if (!isMember) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-md items-center px-6">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>No access</CardTitle>
            <CardDescription>
              You are signed in, but this email is not on the safety team. Ask an existing team member to add you, then sign in again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => void signOut()}>Sign out</Button>
          </CardContent>
        </Card>
      </div>
    )
  }
  return <>{children}</>
}

export function TeamGate({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AuthLoading>
        <p className="mx-auto max-w-5xl px-6 py-10 text-sm text-ink-soft">Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        <SignInForm />
      </Unauthenticated>
      <Authenticated>
        <MembershipCheck>{children}</MembershipCheck>
      </Authenticated>
    </>
  )
}

export function SignOutButton() {
  const { signOut } = useAuthActions()
  return <Button variant="outline" size="sm" onClick={() => void signOut()}>Sign out</Button>
}
