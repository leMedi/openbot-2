import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  return (
    <main className="flex h-screen flex-col items-center justify-center gap-2 bg-background text-foreground">
      <h1 className="text-lg font-medium">OpenBot</h1>
      <Link to="/settings/providers" className="text-base text-link underline">
        Settings
      </Link>
    </main>
  )
}
