import { Link, Outlet, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { BotAvatar } from '../components/bot-avatar.tsx'
import { NewBotDialog } from '../components/new-bot-dialog.tsx'
import { api, errorMessage } from '../lib/api.ts'
import { LiveProvider, useLive } from '../lib/live.tsx'

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
    </LiveProvider>
  )
}

function Sidebar() {
  const live = useLive()
  const [creating, setCreating] = useState(false)

  return (
    <nav className="flex w-[280px] shrink-0 flex-col border-r border-border-subtle bg-sidebar">
      <header className="flex h-[50px] shrink-0 items-center justify-between border-b border-border-subtle pr-3 pl-4">
        <span className="font-semibold">OpenBot</span>
        <button type="button" onClick={() => setCreating(true)} className="pressable rounded-md px-2 py-1 hover:bg-secondary-hover">
          + New bot
        </button>
      </header>

      <ul className="flex flex-1 flex-col gap-[3px] overflow-y-auto px-3 pt-1 pb-6">
        {live.bots?.map((bot) => (
          <li key={bot.id}>
            <Link
              to="/bots/$botId"
              params={{ botId: bot.id }}
              className="grid min-h-[58px] grid-cols-[34px_1fr] items-center gap-[9px] rounded-[10px] p-2 transition-colors duration-100 hover:bg-secondary active:bg-selected"
              activeProps={{ className: 'bg-secondary', 'aria-current': 'page' }}
            >
              <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} working={bot.working} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{bot.name}</span>
                {bot.working ? (
                  <span className="truncate text-xs text-green-foreground">Working…</span>
                ) : bot.error ? (
                  <span className="truncate text-xs text-red-foreground">Couldn't reach its model</span>
                ) : (
                  <span className="truncate text-xs text-muted-foreground">{bot.title}</span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <footer className="px-3 pb-3">
        <Link
          to="/settings/providers"
          className="block rounded-md px-2 py-1.5 text-muted-foreground transition-colors duration-100 hover:bg-secondary active:bg-selected"
        >
          Settings
        </Link>
      </footer>

      {creating && <NewBotDialog onClose={() => setCreating(false)} />}
    </nav>
  )
}
