import { useNavigate } from '@tanstack/react-router'
import { useLive } from '../lib/live.tsx'
import { Dialog } from './dialog.tsx'
import { NewBotForm } from './new-bot-form.tsx'

/** Creates a bot, then opens its DM behind the closing dialog. */
export function NewBotDialog({ onClose }: { onClose: () => void }) {
  const live = useLive()
  const navigate = useNavigate()
  return (
    <Dialog label="New bot" onClose={onClose}>
      {(close) => (
        <>
          <h2 className="text-lg font-semibold">New bot</h2>
          <NewBotForm
            onCancel={close}
            onCreated={(bot) => {
              live.addBot(bot)
              close()
              navigate({ to: '/bots/$botId', params: { botId: bot.id } })
            }}
          />
        </>
      )}
    </Dialog>
  )
}
