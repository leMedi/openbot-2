import type { ChatInfo, MessageHit, RoutineInfo } from '@openbot/api-contract'
import {
  membersOf,
  searchEmptyText,
  searchesServer,
  searchHits,
  searchSections,
  type SearchTab,
  searchTabLabels,
  searchTabs,
  useLive,
  useNow,
  useSearchSources,
} from '@openbot/client'
import type { ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useInstance } from '../lib/instance-context.ts'
import { useColors } from '../lib/theme.ts'
import { BotAvatar, GroupAvatar } from './avatar.tsx'
import { HitIcon, type HitIconKind } from './icons.tsx'

/** One result row: what it shows and what tapping it opens. */
type Entry = { key: string; icon: ReactNode; label: ReactNode; detail: string; open: () => void }

/**
 * Search in the Chats list, in place of the web's ⌘K palette (without its Actions): chips for All · Messages · Chats ·
 * Files · Routines, and the same hits as the web, from the same helpers. A chat opens, a message or file opens its
 * chat at the message, a routine opens the routine. Drawn under the list's search field, in the list's scroll view.
 */
export function SearchResults({
  query,
  tab,
  onTab,
  onOpenChat,
  onOpenRoutine,
}: {
  query: string
  tab: SearchTab
  onTab: (tab: SearchTab) => void
  onOpenChat: (chat: ChatInfo, messageId?: string) => void
  onOpenRoutine: (routine: RoutineInfo) => void
}) {
  const live = useLive()
  const { api } = useInstance()
  const colors = useColors()
  const now = useNow()
  const sources = useSearchSources(api, live.bots, query, searchesServer(tab))
  const hits = searchHits({ bots: live.bots, chats: live.chats, routines: sources.routines ?? [], found: sources.found, query, now })

  const chatIcon = (chat: ChatInfo) => {
    const bot = chat.kind === 'dm' ? live.bots?.find((entry) => entry.id === chat.botId) : undefined
    return bot ? <BotAvatar bot={bot} size={32} /> : <GroupAvatar members={membersOf(chat, live.bots)} size={32} />
  }
  const hitIcon = (kind: HitIconKind) => (
    <View style={[styles.hitIcon, { backgroundColor: colors.secondary }]}>
      <HitIcon kind={kind} color={colors.mutedForeground} />
    </View>
  )

  const sections = searchSections(
    {
      chats: hits.chats.map(({ chat, name, detail }): Entry => ({ key: `chat:${chat.id}`, icon: chatIcon(chat), label: name, detail, open: () => onOpenChat(chat) })),
      routines: hits.routines.map(
        ({ routine, detail }): Entry => ({ key: `routine:${routine.id}`, icon: hitIcon('routine'), label: routine.name, detail, open: () => onOpenRoutine(routine) }),
      ),
      messages: hits.messages.map(
        ({ hit, chat, detail }): Entry => ({
          key: `message:${hit.messageId}`,
          icon: hitIcon('message'),
          label: <Snippet parts={hit.snippet} />,
          detail,
          open: () => onOpenChat(chat, hit.messageId),
        }),
      ),
      files: hits.files.map(
        ({ hit, chat, detail }): Entry => ({
          key: `file:${hit.messageId}:${hit.attachment.id}`,
          icon: hitIcon('file'),
          label: hit.attachment.name,
          detail,
          open: () => onOpenChat(chat, hit.messageId),
        }),
      ),
    },
    tab,
    query,
  )
  const empty = sections.every((section) => !section.entries.length)

  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
        {searchTabs.map((entry) => {
          const on = entry === tab
          return (
            <Pressable
              key={entry}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              onPress={() => onTab(entry)}
              style={[styles.chip, { backgroundColor: on ? colors.primary : colors.secondary }]}
            >
              <Text style={[styles.chipLabel, { color: on ? colors.primaryForeground : colors.foreground }]}>{searchTabLabels[entry]}</Text>
            </Pressable>
          )
        })}
      </ScrollView>
      {empty ? (
        <Text style={[styles.empty, { color: colors.mutedForeground }]}>{searchEmptyText({ tab, query, sources, chats: live.chats.size })}</Text>
      ) : (
        sections.map(
          (section, index) =>
            section.entries.length > 0 && (
              <View key={section.heading ?? index}>
                {section.heading && <Text style={[styles.heading, { color: colors.mutedForeground }]}>{section.heading}</Text>}
                {section.entries.map((entry) => (
                  <Pressable
                    key={entry.key}
                    accessibilityRole="button"
                    onPress={entry.open}
                    style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.selected }]}
                  >
                    {entry.icon}
                    <View style={styles.text}>
                      <Text numberOfLines={1} style={[styles.label, { color: colors.foreground }]}>
                        {entry.label}
                      </Text>
                      <Text numberOfLines={1} style={[styles.detail, { color: colors.mutedForeground }]}>
                        {entry.detail}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            ),
        )
      )}
    </View>
  )
}

/** A message hit's text, its matched words marked. */
function Snippet({ parts }: { parts: MessageHit['snippet'] }) {
  const colors = useColors()
  return (
    <>
      {parts.map((part, index) => (
        <Text key={index} style={part.match ? { backgroundColor: colors.blueSubtle } : undefined}>
          {part.text}
        </Text>
      ))}
    </>
  )
}

const styles = StyleSheet.create({
  chips: { gap: 6, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 10 },
  chip: { paddingHorizontal: 12, height: 32, borderRadius: 16, justifyContent: 'center' },
  chipLabel: { fontSize: 14 },
  heading: { fontSize: 13, fontWeight: '600', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 9, minHeight: 56 },
  hitIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, minWidth: 0, gap: 1 },
  label: { fontSize: 15 },
  detail: { fontSize: 13 },
  empty: { textAlign: 'center', fontSize: 14, paddingVertical: 32 },
})
