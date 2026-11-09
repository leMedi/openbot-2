import { Outlet, createFileRoute, useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { CommandPalette } from '../components/command-palette.tsx'
import { Sidebar } from '../components/sidebar.tsx'
import { api, errorMessage } from '../lib/api.ts'
import { WebLiveProvider } from '../lib/live.tsx'
import { usePhone } from '../lib/sidebar-prefs.ts'

export const Route = createFileRoute('/_app')({
  component: AppShell,
})

/**
 * Sidebar and chat, once onboarding is done; a fresh instance is sent to onboarding first. On a phone they are pages of
 * their own: / is the chat list, and a chat (or New group) fills the screen, its header leading back.
 */
function AppShell() {
  const navigate = useNavigate()
  const phone = usePhone()
  const onList = useRouterState({ select: (state) => state.location.pathname === '/' })
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
    <WebLiveProvider>
      <div className="safe-area flex h-dvh bg-background text-foreground">
        {(!phone || onList) && <Sidebar />}
        {(!phone || !onList) && (
          <main className="flex min-w-0 flex-1 flex-col">
            <Outlet />
          </main>
        )}
      </div>
      <CommandPalette />
    </WebLiveProvider>
  )
}
