import { Outlet, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { CommandPalette } from '../components/command-palette.tsx'
import { Sidebar } from '../components/sidebar.tsx'
import { api, errorMessage } from '../lib/api.ts'
import { LiveProvider } from '../lib/live.tsx'

export const Route = createFileRoute('/_app')({
  component: AppShell,
})

/** Sidebar and chat, once onboarding is done; a fresh instance is sent to onboarding first. */
function AppShell() {
  const navigate = useNavigate()
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    api()
      .onboarding.status()
      .then(
        (status) => (status.done ? setReady(true) : navigate({ to: '/onboarding', replace: true })),
        (caught) => setError(errorMessage(caught)),
      )
  }, [navigate])

  if (error) return <p className="p-6 text-destructive-foreground">{error}</p>
  if (!ready) return null
  return (
    <LiveProvider>
      <div className="flex h-screen bg-background text-foreground">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <Outlet />
        </main>
      </div>
      <CommandPalette />
    </LiveProvider>
  )
}
