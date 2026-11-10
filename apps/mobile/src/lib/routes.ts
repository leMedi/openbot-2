import { router } from 'expo-router'

/** The screens pushed from a bot's info screen. */
export type BotScreen = 'routines' | 'memory' | 'access' | 'activity' | 'instructions' | 'model'

/** Pushes a bot's info screen, or one of the screens it leads to. */
export const openBot = (botId: string, screen?: BotScreen) =>
  router.push({ pathname: screen ? `/bot/[botId]/${screen}` : '/bot/[botId]', params: { botId } })

/** Pushes a routine's editor; `new` for a new routine of the bot. */
export const openRoutine = (botId: string, routineId: string) => router.push({ pathname: '/routine/[routineId]', params: { routineId, botId } })

/** Pushes a group chat's Members screen. */
export const openMembers = (chatId: string) => router.push({ pathname: '/members/[chatId]', params: { chatId } })
