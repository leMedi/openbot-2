import { type ChatInfo, isMuted, maxSectionNameLength, type RoutineInfo, type SectionInfo, unassignedSectionId } from '@openbot/api-contract'
import { hiddenFoldKey, muteChoices, nextMuteEnd, type SearchTab, type SidebarBlock, sidebarLayout, type SidebarRow, useLive, useNow } from '@openbot/client'
import * as Haptics from 'expo-haptics'
import { router, Stack } from 'expo-router'
import { type ReactNode, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ActionSheet, type SheetContent, type SheetItem } from '../components/action-sheet.tsx'
import { ChatRow, rowName } from '../components/chat-row.tsx'
import { ConnectionBanner } from '../components/connection-banner.tsx'
import { ChevronIcon, GearIcon, PlusIcon } from '../components/icons.tsx'
import { PinnedReorder } from '../components/pinned-reorder.tsx'
import { Prompt, type PromptRequest } from '../components/prompt.tsx'
import { SearchField } from '../components/search-field.tsx'
import { SearchResults } from '../components/search-results.tsx'
import { setFolded, useFolds } from '../lib/folds.ts'
import { openOnWeb } from '../lib/open-on-web.ts'
import { errorMessage } from '../lib/errors.ts'
import { useInstance } from '../lib/instance-context.ts'
import { useColors } from '../lib/theme.ts'

/** A section's name as its header shows it. */
const sectionLabel = (section: SectionInfo) => section.name ?? 'Unassigned'

/**
 * The app's home (spec: Phone screen map): a large-title Chats list laid out as the web's sidebar, from the same
 * helper (pinned chats, the owner's sections and Unassigned, then Hidden folded), live from the instance. The gear
 * opens Settings, + an action sheet (New bot, New group chat, New section). A long press opens a chat's menu, and
 * Edit selects several to move or delete and reorders the pinned chats. The search field searches as the web's ⌘K,
 * hiding the list (and Edit) meanwhile.
 */
export default function Chats() {
  const live = useLive()
  const { url, api } = useInstance()
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const folds = useFolds()
  const now = useNow(nextMuteEnd(live.chats.values()))
  const [editing, setEditing] = useState(false)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [dragging, setDragging] = useState(false)
  const [sheet, setSheet] = useState<SheetContent>()
  const [prompt, setPrompt] = useState<PromptRequest>()
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<SearchTab>('all')

  const layout = sidebarLayout(live.bots ?? [], live.chats, live.sections, folds)
  const rows = layout.blocks.flatMap((block) => block.rows)
  const rowOf = (chatId: string) => rows.find((row) => row.chatId === chatId)
  // A chat deleted elsewhere leaves the selection.
  const selection = rows.filter((row) => picked.has(row.chatId))
  const pinnedIds = live.pinnedChatIds

  const fail = (caught: unknown) => Alert.alert("Couldn't do that", errorMessage(caught))
  const attempt = (work: Promise<unknown>) => void work.catch(fail)

  const openChat = (chat: Pick<ChatInfo, 'id'>, message?: string) =>
    router.push({ pathname: '/chat/[chatId]', params: { chatId: chat.id, ...(message && { message }) } })
  const openRoutine = (routine: RoutineInfo) =>
    router.push({ pathname: '/routine/[routineId]', params: { routineId: routine.id, botId: routine.botId } })
  /** The new-bot and new-group sheets come with their own work; until then they open on the web. */
  const onWeb = (path: string) => openOnWeb(url, path)

  function stopEditing() {
    setEditing(false)
    setPicked(new Set())
  }

  /** Asks for a section's name, then adds it at the top and moves `chatIds` there. */
  function newSection(chatIds: string[] = []) {
    setPrompt({
      title: 'New section',
      placeholder: 'Name',
      maxLength: maxSectionNameLength,
      confirm: 'Add',
      save: async (name) => {
        const section = await live.createSection(name)
        if (chatIds.length) await live.moveChats(chatIds, section.id)
        stopEditing()
      },
    })
  }

  /** Where chats can move: every section but the one they're all in, then a new one. */
  function moveItems(chatIds: string[]): SheetItem[] {
    const current = new Set(chatIds.map((id) => rowOf(id)?.chat?.sectionId))
    const here = current.size === 1 && !chatIds.some((id) => rowOf(id)?.chat?.hidden) ? [...current][0] : undefined
    return [
      ...live.sections
        .filter((section) => section.id !== here)
        .map((section) => ({
          label: sectionLabel(section),
          run: () => {
            stopEditing()
            attempt(live.moveChats(chatIds, section.id))
          },
        })),
      { label: 'New section…', run: () => newSection(chatIds) },
    ]
  }

  function rename(row: SidebarRow) {
    const { bot, chat } = row
    setPrompt({
      title: bot ? `Rename ${bot.name}` : 'Rename group chat',
      initial: bot?.name ?? chat?.title ?? '',
      placeholder: bot ? 'Name' : (chat?.name ?? 'Name'),
      maxLength: bot ? 80 : 120,
      // A group without a title is named after its members; a bot needs a name.
      allowBlank: !bot,
      confirm: 'Save',
      save: async (name) => {
        if (bot) {
          if (name !== bot.name) live.updateBot(await api.bots.update({ botId: bot.id, name }))
        } else if (name !== (chat?.title ?? '')) live.setChat(await api.groups.update({ chatId: row.chatId, title: name || null }))
      },
    })
  }

  /** Asks before deleting chats for good, as the web does (a DM goes with its bot), then deletes them in turn. */
  function confirmDelete(chosen: SidebarRow[]) {
    if (!chosen.length) return
    const single = chosen.length === 1 ? chosen[0]! : undefined
    const bots = chosen.filter((row) => row.bot).length
    const title = single ? `Delete ${rowName(single)}?` : `Delete ${chosen.length} chats?`
    const message = single?.bot
      ? `This permanently deletes ${single.bot.name}, its DM and history, and removes it from group chats. Its messages in other chats stay, marked as deleted. This can't be undone.`
      : single
        ? "This permanently deletes the group chat, its messages and the files sent in it, and stops its members answering. The members stay, and remember what they said in it. This can't be undone."
        : [
            bots > 0 && `This permanently deletes ${bots === 1 ? 'a bot' : `${bots} bots`} with ${bots === 1 ? 'its DM' : 'their DMs'} and history.`,
            bots < chosen.length && 'Group chats lose their messages and files; their members stay.',
            "This can't be undone.",
          ]
            .filter(Boolean)
            .join(' ')
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          attempt(
            (async () => {
              // Those deleted before a failure leave the list at once. Group chats go first, as deleting their
              // members may delete them too.
              for (const row of [...chosen].sort((a, b) => Number(!!a.bot) - Number(!!b.bot))) {
                if (row.bot) {
                  await api.bots.delete({ botId: row.bot.id })
                  live.removeBot(row.bot.id, row.chatId)
                } else {
                  await api.groups.delete({ chatId: row.chatId })
                  live.removeChat(row.chatId)
                }
              }
              stopEditing()
            })(),
          ),
      },
    ])
  }

  /** A chat's long-press menu: Pin, Move to section, Rename, Mute, Hide, Mark as unread, Delete. */
  function rowMenu(row: SidebarRow): SheetItem[] {
    const { chat, pinned, chatId } = row
    const hidden = !!chat?.hidden
    return [
      ...(hidden
        ? []
        : [pinned ? { label: 'Unpin', run: () => attempt(live.setPinned(pinnedIds.filter((id) => id !== chatId))) } : { label: 'Pin', run: () => attempt(live.setPinned([...pinnedIds, chatId])) }]),
      // Not on pinned rows, as on the web: a pinned chat sits above every section.
      ...(pinned || hidden ? [] : [{ label: 'Move to section', items: moveItems([chatId]) }]),
      { label: 'Rename', run: () => rename(row) },
      // A hidden chat is always muted, so its own mute isn't offered until it's shown again.
      ...(!chat || hidden
        ? []
        : isMuted(chat, now)
          ? [{ label: 'Unmute', run: () => attempt(live.unmuteChats([chatId])) }]
          : [{ label: 'Mute', items: muteChoices.map(([duration, label]) => ({ label, run: () => attempt(live.muteChats([chatId], duration)) })) }]),
      hidden ? { label: 'Show', run: () => attempt(live.showChats([chatId])) } : { label: 'Hide', run: () => attempt(live.hideChats([chatId])) },
      // Only a chat with messages can turn unread.
      ...(!chat?.lastMessage ? [] : chat.unread ? [{ label: 'Mark as read', run: () => attempt(live.markRead(chatId, undefined)) }] : [{ label: 'Mark as unread', run: () => attempt(live.markUnread(chatId)) }]),
      { label: 'Delete', danger: true, run: () => confirmDelete([row]) },
    ]
  }

  /** A section header's long-press menu: Rename, Move up, Move down, Delete; Unassigned only moves. */
  function sectionMenu(section: SectionInfo): SheetItem[] {
    const order = live.sections.map((entry) => entry.id)
    const place = order.indexOf(section.id)
    const move = (offset: number) => {
      order.splice(place, 1)
      order.splice(place + offset, 0, section.id)
      attempt(live.reorderSections(order))
    }
    const own = section.id !== unassignedSectionId
    return [
      ...(own
        ? [
            {
              label: 'Rename',
              run: () =>
                setPrompt({
                  title: 'Rename section',
                  initial: section.name ?? '',
                  maxLength: maxSectionNameLength,
                  confirm: 'Save',
                  save: (name) => (name === section.name ? Promise.resolve() : live.renameSection(section.id, name)),
                }),
            },
          ]
        : []),
      ...(place > 0 ? [{ label: 'Move up', run: () => move(-1) }] : []),
      ...(place < order.length - 1 ? [{ label: 'Move down', run: () => move(1) }] : []),
      ...(own
        ? [
            {
              label: 'Delete',
              danger: true,
              run: () =>
                Alert.alert(`Delete “${sectionLabel(section)}”?`, 'Its chats move to Unassigned. No chat is deleted.', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Delete', style: 'destructive', onPress: () => attempt(live.deleteSection(section.id)) },
                ]),
            },
          ]
        : []),
    ]
  }

  const openMenu = (title: string, items: SheetItem[]) => {
    if (!items.length) return
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    setSheet({ title, items })
  }

  const newMenu: SheetItem[] = [
    { label: 'New bot', run: () => onWeb('/') },
    { label: 'New group chat', run: () => onWeb('/groups/new') },
    { label: 'New section', run: () => newSection() },
  ]

  function toggle(chatId: string) {
    const next = new Set(picked)
    if (next.has(chatId)) next.delete(chatId)
    else next.add(chatId)
    setPicked(next)
  }

  function rowElement(row: SidebarRow, handle?: ReactNode) {
    return (
      <ChatRow
        key={row.chatId}
        row={row}
        now={now}
        editing={editing}
        selected={picked.has(row.chatId)}
        handle={handle}
        onPress={() => (editing ? toggle(row.chatId) : row.chat && openChat(row.chat))}
        onLongPress={() => openMenu(rowName(row), rowMenu(row))}
      />
    )
  }

  function blockElement(block: SidebarBlock) {
    if (block.kind === 'pinned') {
      return (
        <View key="pinned" style={[styles.pinned, { borderBottomColor: colors.borderSubtle }]}>
          {editing ? (
            <PinnedReorder
              ids={block.rows.map((row) => row.chatId)}
              renderRow={(id, handle) => rowElement(block.rows.find((row) => row.chatId === id)!, handle)}
              onReorder={(order) => attempt(live.setPinned(order))}
              onDragging={setDragging}
            />
          ) : (
            block.rows.map((row) => rowElement(row))
          )}
        </View>
      )
    }
    const key = block.kind === 'section' ? block.section.id : hiddenFoldKey
    const label = block.kind === 'section' ? sectionLabel(block.section) : 'Hidden'
    const section = block.kind === 'section' ? block.section : undefined
    return (
      <View key={key}>
        {(layout.headers || block.kind === 'hidden') && (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: !block.folded }}
            accessibilityHint={section ? 'Long press for its actions' : undefined}
            onPress={() => setFolded(key, !block.folded)}
            onLongPress={section && !editing ? () => openMenu(label, sectionMenu(section)) : undefined}
            delayLongPress={350}
            style={({ pressed }) => [styles.sectionHeader, pressed && { backgroundColor: colors.selected }]}
          >
            <Text numberOfLines={1} style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              {label}
              {block.folded ? ` · ${block.rows.length}` : ''}
            </Text>
            <ChevronIcon folded={block.folded} color={colors.mutedForeground} />
          </Pressable>
        )}
        {!block.folded &&
          (block.rows.length ? (
            block.rows.map((row) => rowElement(row))
          ) : (
            <Text style={[styles.emptySection, { color: colors.faint }]}>No chats</Text>
          ))}
      </View>
    )
  }

  const headerButton = (label: string, onPress: () => void, icon?: ReactNode, strong = false) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} hitSlop={8} onPress={onPress} style={styles.headerButton}>
      {icon ?? <Text style={[styles.headerText, { color: colors.foreground, fontWeight: strong ? '600' : '400' }]}>{label}</Text>}
    </Pressable>
  )

  const searchShown = searching || !!query
  const movable = selection.filter((row) => !row.pinned).map((row) => row.chatId)

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Chats',
          headerLargeTitle: true,
          headerLargeTitleShadowVisible: false,
          headerShadowVisible: false,
          headerLeft: () => (editing ? null : headerButton('Settings', () => router.push('/settings'), <GearIcon color={colors.foreground} />)),
          headerRight: () =>
            editing ? (
              headerButton('Done', stopEditing, undefined, true)
            ) : (
              <View style={styles.headerRight}>
                {!searchShown && headerButton('Edit', () => setEditing(true))}
                {headerButton('New', () => setSheet({ items: newMenu }), <PlusIcon color={colors.foreground} />)}
              </View>
            ),
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        scrollEnabled={!dragging}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={{ paddingBottom: editing ? 80 + insets.bottom : 24 }}
      >
        {!editing && <SearchField query={query} searching={searchShown} onQuery={setQuery} onSearching={setSearching} />}
        {searchShown ? (
          <SearchResults query={query} tab={tab} onTab={setTab} onOpenChat={openChat} onOpenRoutine={openRoutine} />
        ) : (
          <>
            <ConnectionBanner />
            {!live.bots ? (
              <ActivityIndicator style={styles.loading} color={colors.mutedForeground} />
            ) : layout.blocks.length ? (
              layout.blocks.map(blockElement)
            ) : (
              <Text style={[styles.empty, { color: colors.mutedForeground }]}>No chats yet. Make a bot with +.</Text>
            )}
          </>
        )}
      </ScrollView>
      {editing && (
        <View style={[styles.toolbar, { paddingBottom: Math.max(insets.bottom, 10), backgroundColor: colors.background, borderTopColor: colors.border }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !movable.length }}
            disabled={!movable.length}
            onPress={() => setSheet({ title: 'Move to', items: moveItems(movable) })}
            style={styles.toolbarButton}
          >
            <Text style={[styles.toolbarText, { color: colors.foreground, opacity: movable.length ? 1 : 0.4 }]}>Move ▾</Text>
          </Pressable>
          <Text style={[styles.toolbarCount, { color: colors.mutedForeground }]}>{selection.length ? `${selection.length} selected` : 'Select chats'}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !selection.length }}
            disabled={!selection.length}
            onPress={() => confirmDelete(selection)}
            style={styles.toolbarButton}
          >
            <Text style={[styles.toolbarText, { color: colors.destructiveForeground, opacity: selection.length ? 1 : 0.4 }]}>Delete</Text>
          </Pressable>
        </View>
      )}
      <ActionSheet sheet={sheet} onClose={() => setSheet(undefined)} />
      <Prompt request={prompt} onClose={() => setPrompt(undefined)} />
    </>
  )
}

const styles = StyleSheet.create({
  headerButton: { minWidth: 36, height: 36, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  headerText: { fontSize: 17 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pinned: { borderBottomWidth: StyleSheet.hairlineWidth, marginBottom: 4 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
  sectionLabel: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  emptySection: { fontSize: 13, paddingHorizontal: 16, paddingBottom: 8 },
  loading: { marginTop: 48 },
  empty: { textAlign: 'center', fontSize: 15, marginTop: 48, paddingHorizontal: 32 },
  toolbar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  toolbarButton: { paddingHorizontal: 10, paddingVertical: 8 },
  toolbarText: { fontSize: 17, fontWeight: '500' },
  toolbarCount: { fontSize: 13 },
})
