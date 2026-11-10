import type { ChatInfo } from '@openbot/api-contract'
import { muteChoices, muteState, nextMuteEnd, useLive, useNow } from '@openbot/client'
import { useState } from 'react'
import { Alert } from 'react-native'
import { ActionSheet, type SheetContent } from './action-sheet.tsx'
import { Group, Row } from './grouped.tsx'
import { errorMessage } from '../lib/errors.ts'

/**
 * A chat's mute on its bot's info screen or its group's Members (spec: Notifications): Mute for 1 hour, 8 hours,
 * 1 day or until unmuted, or Unmute, as the chat's long-press menu has it. A hidden chat is muted while hidden.
 */
export function MuteGroup({ chat }: { chat: ChatInfo }) {
  const live = useLive()
  const now = useNow(nextMuteEnd([chat]))
  const [sheet, setSheet] = useState<SheetContent>()
  const state = muteState(chat, now)

  const attempt = (work: Promise<unknown>) =>
    void work.catch((caught) =>
      Alert.alert("Couldn't do that", live.connected ? errorMessage(caught) : "OpenBot can't be reached right now. Try again once it can."),
    )
  const choose = () =>
    setSheet(
      state.muted
        ? { title: `Muted · ${state.label}`, items: [{ label: 'Unmute', run: () => attempt(live.unmuteChats([chat.id])) }] }
        : { title: 'Mute notifications', items: muteChoices.map(([duration, label]) => ({ label, run: () => attempt(live.muteChats([chat.id], duration)) })) },
    )

  return (
    <>
      <Group
        label="Notifications"
        note={chat.hidden ? 'Hidden chats are muted. Show the chat to unmute it.' : "A muted chat's messages don't notify you. Its cards still do."}
      >
        <Row label="Mute" value={state.label} disabled={chat.hidden} onPress={chat.hidden ? undefined : choose} />
      </Group>
      <ActionSheet sheet={sheet} onClose={() => setSheet(undefined)} />
    </>
  )
}
