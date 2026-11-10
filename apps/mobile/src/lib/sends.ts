import type { Outgoing } from '@openbot/client'
import { useSyncExternalStore } from 'react'
import type { PickedFile } from './upload.ts'

/** A message the owner sent from the phone that the instance hasn't returned yet, or that failed, with its upload's progress. */
export type Sending = Outgoing<PickedFile> & { progress?: number }

const byChat = new Map<string, Sending[]>()
const listeners = new Set<() => void>()
const none: Sending[] = []

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/**
 * Changes a chat's sends. They're kept outside the chat screen, for as long as the app runs, so leaving the chat while
 * a photo uploads doesn't lose its progress or, if it fails, its Resend.
 */
export function updateSends(chatId: string, change: (sends: Sending[]) => Sending[]) {
  const next = change(byChat.get(chatId) ?? none)
  if (next.length) byChat.set(chatId, next)
  else byChat.delete(chatId)
  for (const listener of listeners) listener()
}

/** A chat's sends, re-rendering as they change. */
export function useSends(chatId: string): Sending[] {
  return useSyncExternalStore(subscribe, () => byChat.get(chatId) ?? none)
}
