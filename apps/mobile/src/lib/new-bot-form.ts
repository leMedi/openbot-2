import type { BotInfo } from '@openbot/api-contract'
import { createContext, useContext } from 'react'

/** What the owner filled in on the New bot sheet, shared by its screens (the model is picked on a pushed one). */
export type NewBotDraft = {
  name: string
  title: string
  instructions: string
  avatarStyle: BotInfo['avatarStyle']
  avatarShape: BotInfo['avatarShape']
  avatarColor: BotInfo['avatarColor']
  /** Null follows the default model. */
  model: string | null
}

/** The New bot sheet's draft and how its screens change it, given by the sheet's layout. */
export const NewBotContext = createContext<{ draft: NewBotDraft; change: (changes: Partial<NewBotDraft>) => void } | undefined>(undefined)

/** The New bot sheet's draft, from any of its screens. */
export function useNewBot() {
  const form = useContext(NewBotContext)
  if (!form) throw new Error('useNewBot needs the New bot sheet')
  return form
}
