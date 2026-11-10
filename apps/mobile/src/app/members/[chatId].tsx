import { type BotInfo, type ChatInfo, maxGroupMembers, maxGroupTitleLength, minGroupMembers } from '@openbot/api-contract'
import { chatName, deleteWarnings, groupCandidates, membersOf, useLive } from '@openbot/client'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Alert, StyleSheet, Text, View } from 'react-native'
import { ActionSheet, type SheetContent } from '../../components/action-sheet.tsx'
import { BotAvatar, GroupAvatar } from '../../components/avatar.tsx'
import { FieldRow, Group, GroupedScroll, Loading, Note, Row } from '../../components/grouped.tsx'
import { SwipeRow } from '../../components/swipe-row.tsx'
import { statusNote, useSaveQueue } from '../../lib/save-queue.ts'
import { errorMessage } from '../../lib/errors.ts'
import { useInstance } from '../../lib/instance-context.ts'
import { useColors } from '../../lib/theme.ts'
import { useSaveSoon } from '../../lib/use-save-soon.ts'

/**
 * A group chat's Members, pushed by tapping its header (spec: Phone screen map), as the web's pane: its name (saved as
 * typed; blank names it after its members), its members (a tap opens one's DM, a swipe left removes one), Add member,
 * and Delete.
 */
export default function Members() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>()
  const live = useLive()
  const chat = live.chats.get(chatId)
  if (!chat || chat.kind !== 'group') {
    return (
      <>
        <Stack.Screen options={{ title: 'Members' }} />
        <GroupedScroll>{live.bots ? <Note>{"This group chat doesn't exist any more."}</Note> : <Loading />}</GroupedScroll>
      </>
    )
  }
  return <GroupMembers chat={chat} />
}

function GroupMembers({ chat }: { chat: ChatInfo }) {
  const live = useLive()
  const { api } = useInstance()
  const colors = useColors()
  const { status, run } = useSaveQueue()
  const [sheet, setSheet] = useState<SheetContent>()
  const members = membersOf(chat, live.bots)
  const others = groupCandidates(live.bots ?? [], members, '')
  const name = chatName(live.bots, chat)

  const save = (changes: { title?: string | null; memberIds?: string[] }) =>
    void run(async () => live.setChat(await api.groups.update({ chatId: chat.id, ...changes })))

  // The name as typed; until then, the group's.
  const [typed, setTyped] = useState<string>()
  const editing = useRef(false)
  useEffect(() => {
    if (!editing.current) setTyped(undefined)
  }, [chat.title])
  const saveTitle = useSaveSoon((final) => {
    if (final) editing.current = false
    if (typed === undefined) return
    const next = typed.trim() || null
    if (next !== chat.title) save({ title: next })
  })

  const remove = (bot: BotInfo) => {
    if (chat.members.length <= minGroupMembers) {
      return Alert.alert(`${bot.name} can't leave`, `A group chat needs at least ${minGroupMembers} bots. Add another first, or delete the group.`)
    }
    Alert.alert(`Remove ${bot.name} from this group chat?`, `${bot.name} stops answering here, and remembers what it said.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => save({ memberIds: chat.members.filter((id) => id !== bot.id) }) },
    ])
  }

  const add = () =>
    setSheet({
      title: 'Add member',
      items: others.map((bot) => ({ label: bot.name, run: () => save({ memberIds: [...chat.members, bot.id] }) })),
    })

  const confirmDelete = () =>
    Alert.alert(`Delete ${name}?`, deleteWarnings.group, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          saveTitle.cancel()
          void api.groups
            .delete({ chatId: chat.id })
            .then(() => {
              router.dismissTo('/')
              live.removeChat(chat.id)
            })
            .catch((caught) => Alert.alert("Couldn't delete it", errorMessage(caught)))
        },
      },
    ])

  const full = chat.members.length >= maxGroupMembers
  return (
    <>
      <Stack.Screen options={{ title: 'Members' }} />
      <GroupedScroll>
        <View style={styles.hero}>
          <GroupAvatar members={members} size={84} />
          <Text style={[styles.name, { color: colors.foreground }]}>{name}</Text>
          <Text style={[styles.count, { color: colors.mutedForeground }]}>{`${members.length} members`}</Text>
        </View>
        <Group label="Name" note={statusNote(status, 'Leave it blank to name the group after its members.')}>
          <FieldRow
            accessibilityLabel="Group name"
            value={typed ?? chat.title ?? ''}
            placeholder={members.map((bot) => bot.name).join(', ')}
            onChangeText={(value) => {
              editing.current = true
              setTyped(value)
              saveTitle.soon()
            }}
            onEndEditing={saveTitle.now}
            maxLength={maxGroupTitleLength}
            returnKeyType="done"
          />
        </Group>
        <Group
          label="Members"
          note={`Swipe a member left to remove them. A group chat has ${minGroupMembers} to ${maxGroupMembers} bots.`}
        >
          {members.map((bot) => (
            <SwipeRow key={bot.id} label="Remove" onAction={() => remove(bot)}>
              <Row
                label={bot.name}
                detail={bot.working ? 'Working' : (bot.title ?? undefined)}
                value="Message"
                icon={<BotAvatar bot={bot} size={30} working={bot.working} />}
                onPress={() => router.push({ pathname: '/chat/[chatId]', params: { chatId: bot.chatId } })}
              />
            </SwipeRow>
          ))}
          <Row
            label={full ? `Groups can have up to ${maxGroupMembers} members` : others.length ? 'Add member' : 'Create more bots to add them here'}
            tone="link"
            disabled={full || !others.length}
            onPress={add}
          />
        </Group>
        <Group>
          <Row label="Delete group chat" tone="danger" onPress={confirmDelete} />
        </Group>
      </GroupedScroll>
      <ActionSheet sheet={sheet} onClose={() => setSheet(undefined)} />
    </>
  )
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: 4 },
  name: { fontSize: 22, fontWeight: '600', marginTop: 8, textAlign: 'center' },
  count: { fontSize: 15 },
})
