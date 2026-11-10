import type { BotChanges, BotInfo } from '@openbot/api-contract'
import { useLive } from '@openbot/client'
import { useEffect, useRef, useState } from 'react'
import { useInstance } from './instance-context.ts'
import { useSaveQueue } from './save-queue.ts'
import { useSaveSoon } from './use-save-soon.ts'

export { type SaveStatus, statusNote } from './save-queue.ts'

/**
 * Saves changes to `botId`'s profile one after another, so they land in the order the owner made them, each putting
 * the saved bot in the live store.
 */
export function useBotSave(botId: string) {
  const live = useLive()
  const { api } = useInstance()
  const { status, run } = useSaveQueue()
  const save = (changes: BotChanges) => void run(async () => live.updateBot(await api.bots.update({ botId, ...changes })))
  return { status, save }
}

type TextField = 'name' | 'title' | 'instructions'

const savedText = (bot: BotInfo, field: TextField) => (field === 'title' ? (bot.title ?? '') : bot[field])

/**
 * One of a bot's text fields, saved as the owner types, as the sketch's "Changes save as you type": `text` is what the
 * field shows (what was typed, else the bot's), `change` takes each keystroke, `leave` is for the field's end of
 * editing. A blank name isn't saved, and comes back once left; a blank title clears it.
 */
export function useBotText(bot: BotInfo, field: TextField, save: (changes: BotChanges) => void) {
  const [typed, setTyped] = useState<string>()
  const editing = useRef(false)
  const saved = savedText(bot, field)
  // Changed elsewhere (the web, a rename from the list): shown as it is, unless the owner is typing.
  useEffect(() => {
    if (!editing.current) setTyped(undefined)
  }, [saved])
  const text = typed ?? saved
  const saver = useSaveSoon((final) => {
    if (final) editing.current = false
    if (typed === undefined) return
    const trimmed = typed.trim()
    if (field === 'name') {
      if (!trimmed) return final && setTyped(undefined)
      if (trimmed !== bot.name) save({ name: trimmed })
    } else if (field === 'title') {
      if ((trimmed || null) !== bot.title) save({ title: trimmed || null })
    } else if (typed !== bot.instructions) save({ instructions: typed })
  })
  return {
    text,
    change: (value: string) => {
      editing.current = true
      setTyped(value)
      saver.soon()
    },
    leave: saver.now,
  }
}
