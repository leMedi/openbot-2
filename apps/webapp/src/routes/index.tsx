import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  return (
    <main className="flex h-screen items-center justify-center bg-background text-foreground">
      <h1 className="text-lg font-medium">OpenBot</h1>
    </main>
  )
}
