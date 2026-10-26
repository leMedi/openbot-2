import { Link, Outlet, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { BotAvatar } from '../components/bot-avatar.tsx'
import { NewBotForm } from '../components/new-bot-form.tsx'
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
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [creating, setCreating] = useState(false)

  return (
    <nav className="flex w-[280px] shrink-0 flex-col border-r border-border-subtle bg-sidebar">
      <header className="relative flex h-[50px] shrink-0 items-center justify-between border-b border-border-subtle pr-3 pl-4">
        <span className="font-semibold">OpenBot</span>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          className="rounded-md px-2 py-1 text-base hover:bg-secondary-hover"
        >
          + New
        </button>
        {menuOpen && (
          <div role="menu" className="absolute top-11 right-3 z-20 min-w-36 rounded-lg border border-border bg-popover p-1 shadow-md">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false)
                setCreating(true)
              }}
              className="w-full rounded-md px-2 py-1.5 text-left hover:bg-secondary"
            >
              New bot
            </button>
          </div>
        )}
      </header>

      <ul className="flex flex-1 flex-col gap-[3px] overflow-y-auto px-3 pt-1 pb-6">
        {live.bots?.map((bot) => (
          <li key={bot.id}>
            <Link
              to="/bots/$botId"
              params={{ botId: bot.id }}
              className="grid min-h-[58px] grid-cols-[34px_1fr] items-center gap-[9px] rounded-[10px] p-2 hover:bg-secondary"
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
        <Link to="/settings/providers" className="block rounded-md px-2 py-1.5 text-muted-foreground hover:bg-secondary">
          Settings
        </Link>
      </footer>

      {creating && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4">
          <div role="dialog" aria-label="New bot" className="flex max-h-full w-full max-w-md flex-col gap-4 overflow-y-auto rounded-xl bg-popover p-5 text-popover-foreground shadow-lg">
            <h2 className="text-lg font-semibold">New bot</h2>
            <NewBotForm
              onCancel={() => setCreating(false)}
              onCreated={(bot) => {
                live.addBot(bot)
                setCreating(false)
                navigate({ to: '/bots/$botId', params: { botId: bot.id } })
              }}
            />
          </div>
        </div>
      )}
    </nav>
  )
}
