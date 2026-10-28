import { Link, Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/settings')({
  component: Settings,
})

const sections = [
  { to: '/settings/general', label: 'General' },
  { to: '/settings/providers', label: 'Providers' },
  { to: '/settings/models', label: 'Models' },
  { to: '/settings/plugins', label: 'Plugins' },
  { to: '/settings/shared-memory', label: 'Shared memory' },
] as const

function Settings() {
  return (
    <div className="flex h-screen bg-background text-foreground">
      <nav className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-border-subtle bg-sidebar p-3">
        <Link
          to="/"
          className="mb-2 self-start rounded-md px-2 py-1 text-muted-foreground transition-colors duration-100 hover:bg-secondary-hover hover:text-foreground active:bg-selected"
        >
          ← Chats
        </Link>
        <h1 className="px-2 pt-1 pb-3 text-lg font-semibold">Settings</h1>
        {sections.map((section) => (
          <Link
            key={section.to}
            to={section.to}
            className="rounded-md px-2 py-1.5 text-base text-muted-foreground transition-colors duration-100 hover:bg-secondary-hover active:bg-selected"
            activeProps={{ className: 'bg-selected text-foreground' }}
          >
            {section.label}
          </Link>
        ))}
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
