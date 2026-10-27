import { Navigate, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { NewBotDialog } from '../../components/new-bot-dialog.tsx'
import { useLive } from '../../lib/live.tsx'

export const Route = createFileRoute('/_app/')({
  component: Home,
})

/** Opens the first bot's DM, or offers to create one. */
function Home() {
  const { bots } = useLive()
  const [creating, setCreating] = useState(false)
  const first = bots?.[0]
  if (first) return <Navigate to="/bots/$botId" params={{ botId: first.id }} replace />
  if (!bots) return null
  return (
    <div className="m-auto flex flex-col items-center gap-3 text-center">
      <p className="text-muted-foreground">No bots yet</p>
      <button
        type="button"
        onClick={() => setCreating(true)}
        className="pressable rounded-md bg-primary px-3 py-1.5 text-primary-foreground hover:bg-primary-hover"
      >
        Create a bot
      </button>
      {creating && <NewBotDialog onClose={() => setCreating(false)} />}
    </div>
  )
}
