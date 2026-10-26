import { Navigate, createFileRoute } from '@tanstack/react-router'
import { useLive } from '../../lib/live.tsx'

export const Route = createFileRoute('/_app/')({
  component: Home,
})

/** Opens the first bot's DM. */
function Home() {
  const { bots } = useLive()
  const first = bots?.[0]
  if (first) return <Navigate to="/bots/$botId" params={{ botId: first.id }} replace />
  if (!bots) return null
  return <p className="m-auto text-muted-foreground">No chats yet</p>
}
