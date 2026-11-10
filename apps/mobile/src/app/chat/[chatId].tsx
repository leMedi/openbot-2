import type { BotInfo, BotMessageInfo } from '@openbot/api-contract'
import { addFiles, chatName, membersOf, type Outgoing, transcript, type TranscriptRow, useLive, useViewingHeartbeat } from '@openbot/client'
import { router, Stack, useIsFocused, useLocalSearchParams } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, FlatList, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Attachments } from '../../components/attachments.tsx'
import { BotAvatar, GroupAvatar } from '../../components/avatar.tsx'
import { PluginReconnectCard, PluginRequestCard, QuestionCard, RoutineChangeRow, TakeOverCard } from '../../components/cards.tsx'
import { Composer, PickedFiles } from '../../components/composer.tsx'
import { ConnectionBanner, useUnreachable } from '../../components/connection-banner.tsx'
import { ScreenIcon } from '../../components/icons.tsx'
import { Markdown } from '../../components/markdown.tsx'
import { useAppActive } from '../../lib/app-state.ts'
import { hasBlocks, parseMarkdown } from '../../lib/markdown.ts'
import { errorMessage } from '../../lib/errors.ts'
import { useInstance } from '../../lib/instance-context.ts'
import { openOnWeb } from '../../lib/open-on-web.ts'
import { useColors } from '../../lib/theme.ts'
import { type Sending, updateSends, useSends } from '../../lib/sends.ts'
import { type PickedFile, sendWithFiles } from '../../lib/upload.ts'

/** How close to the end (the bottom) still counts as reading the latest messages. */
const followThreshold = 80

/** How long a message a search hit opened stays highlighted. */
const highlightMs = 2000

type Row = TranscriptRow<PickedFile>

let sends = 0
/** A send's key, unique while the app runs: its outgoing row's until the instance's copy arrives. */
const newSendKey = () => `send-${++sends}`

/** Files the owner added to each chat's composer and hasn't sent yet, kept while they leave the chat (not across restarts). */
const pendingFiles = new Map<string, PickedFile[]>()

/**
 * A chat, DM or group, pushed from the Chats list or a search hit (at `message`), as the web's (spec: Phone screen map):
 * the header with the avatar, name and what the bot is doing, and the Screen button in a DM; the transcript, live, with
 * cards answered inline and older pages loading as the owner scrolls up; the composer, with files from the photo
 * library, the camera or Files, uploaded with progress. While the chat is in front, it's marked read as messages arrive
 * and the instance is told the owner is viewing it, so it doesn't push for it.
 */
export default function Chat() {
  const { chatId, message: focusMessage } = useLocalSearchParams<{ chatId: string; message?: string }>()
  const live = useLive()
  const { api, url } = useInstance()
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const headerHeight = useHeaderHeight()
  const active = useAppActive()
  const focused = useIsFocused()
  const chat = live.chats.get(chatId)
  const bot = chat?.kind === 'dm' ? live.bots?.find((entry) => entry.id === chat.botId) : undefined
  const group = chat?.kind === 'group' ? chat : undefined
  const members = group ? membersOf(group, live.bots) : []
  const typing: BotInfo | undefined = bot?.working ? bot : group ? live.bots?.find((entry) => entry.id === group.speaking) : undefined

  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string>()
  const outgoing = useSends(chatId)
  const [files, setFilesState] = useState<PickedFile[]>(() => pendingFiles.get(chatId) ?? [])
  const [notice, setNotice] = useState<string>()
  const [keyboard, setKeyboard] = useState(false)
  const list = useRef<FlatList<Row>>(null)
  /** Going to a hit beyond what's laid out tries once more, once the list has measured further. */
  const retry = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(retry.current), [])
  /** Whether the view is at the end, following new messages; false once the owner scrolls up to read. */
  const following = useRef(true)
  const [unseen, setUnseen] = useState(false)

  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboard(true))
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboard(false))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])

  function setFiles(next: PickedFile[]) {
    setFilesState(next)
    if (next.length) pendingFiles.set(chatId, next)
    else pendingFiles.delete(chatId)
  }

  useEffect(() => {
    let current = true
    live.openChat(chatId).then(
      () => current && setLoaded(true),
      (caught) => {
        if (!current) return
        // Not while the instance can't be reached, which the banner says; the store loads it once it can be.
        if (live.connected) setError(errorMessage(caught))
        // What the store already has (opened before, or arrived live) still shows.
        setLoaded(true)
      },
    )
    return () => void (current = false)
  }, [chatId, live])

  // A load that failed as the connection went, before the stream noticed, is reloaded by the store once reconnected:
  // its error goes then.
  const [wasConnected, setWasConnected] = useState(live.connected)
  if (wasConnected !== live.connected) {
    setWasConnected(live.connected)
    if (live.connected) setError(undefined)
  }

  const messages = live.messages.get(chatId) ?? []
  const hasOlder = live.hasOlder(chatId)
  const loadingOlder = live.loadingOlder(chatId)
  const unreachable = useUnreachable()
  /** The owner reached the oldest loaded message offline, which the list doesn't tell again: loaded once reconnected. */
  const olderWanted = useRef(false)
  const loadOlder = () => {
    if (!hasOlder || loadingOlder) return
    // Offline, what the phone kept is all there is until the instance can be reached.
    if (!live.connected) olderWanted.current = true
    else live.loadOlder(chatId).catch((caught) => setError(errorMessage(caught)))
  }
  useEffect(() => {
    if (!live.connected || !olderWanted.current) return
    olderWanted.current = false
    live.loadOlder(chatId).catch((caught) => setError(errorMessage(caught)))
  }, [live, live.connected, chatId])

  // In front of the owner: what arrives is read, and the instance doesn't push for this chat meanwhile.
  const inFront = loaded && active && focused
  // What the phone kept shows at once, the latest page merging in once loaded; offline, it's all there is.
  const shown = loaded || messages.length > 0
  const newest = messages.at(-1)?.id
  const unread = chat?.unread ?? false
  /** The newest message a read was tried for; a failed one isn't retried until another message arrives. */
  const triedRead = useRef<string>(undefined)
  useEffect(() => {
    // Once the instance is reached again, as a read marked offline would be undone by its state then.
    if (!inFront || !unread || !live.connected || triedRead.current === newest) return
    triedRead.current = newest
    live.markRead(chatId, newest).catch(() => {})
  }, [inFront, unread, newest, chatId, live, live.connected])
  // Not while the instance can't be reached: it would only fail.
  useViewingHeartbeat(chatId, inFront && live.connected)

  async function send(text: string, sending: PickedFile[], key = newSendKey()) {
    following.current = true
    list.current?.scrollToOffset({ offset: 0, animated: true })
    const after = messages.at(-1)?.id
    const change = (entry: Partial<Sending>) => updateSends(chatId, (entries) => entries.map((other) => (other.key === key ? { ...other, ...entry } : other)))
    updateSends(chatId, (entries) => [...entries.filter((entry) => entry.key !== key), { key, text, files: sending, after, progress: sending.length ? 0 : undefined }])
    try {
      const posted = sending.length
        ? await sendWithFiles({ url, chatId, text, files: sending, onProgress: (progress) => change({ progress }) })
        : await api.chats.send({ chatId, text })
      live.addMessage(posted)
      updateSends(chatId, (entries) => entries.filter((entry) => entry.key !== key))
    } catch (caught) {
      change({ error: errorMessage(caught), progress: undefined })
    }
  }

  const rows = transcript(messages, outgoing)
  // The list is inverted, so the newest row is its first and sits at the bottom.
  const newestFirst = [...rows].reverse()

  // A row arriving while the owner reads further up offers to jump to it instead of moving what they read.
  const newestRow = rows.at(-1)?.key
  const shownNewest = useRef(newestRow)
  useEffect(() => {
    if (newestRow === shownNewest.current) return
    shownNewest.current = newestRow
    if (!following.current) setUnseen(true)
  }, [newestRow])

  // Goes to the message a search hit opened, loading back to it first, and highlights it a moment.
  const [highlighted, setHighlighted] = useState<string>()
  const wentTo = useRef<string>(undefined)
  const seeking = !!focusMessage && !messages.some((entry) => entry.id === focusMessage) && hasOlder
  useEffect(() => {
    if (!loaded || !seeking || !focusMessage) return
    live.loadUntil(chatId, focusMessage).catch((caught) => setError(errorMessage(caught)))
  }, [loaded, seeking, chatId, focusMessage, live])
  const focusIndex = focusMessage ? newestFirst.findIndex((row) => row.key === focusMessage) : -1
  useEffect(() => {
    if (!loaded || seeking || !focusMessage || wentTo.current === focusMessage || focusIndex < 0) return
    wentTo.current = focusMessage
    following.current = false
    setHighlighted(focusMessage)
    const timer = setTimeout(() => list.current?.scrollToIndex({ index: focusIndex, viewPosition: 0.5, animated: false }), 60)
    return () => clearTimeout(timer)
  }, [loaded, seeking, focusMessage, focusIndex])
  useEffect(() => {
    if (!highlighted) return
    const timer = setTimeout(() => setHighlighted(undefined), highlightMs)
    return () => clearTimeout(timer)
  }, [highlighted])

  const openRoutine = (botId: string, routineId: string) => router.push({ pathname: '/routine/[routineId]', params: { routineId, botId } })
  // The phone's Screen comes with #114; until then it's the bot's page on the web, where the Screen is.
  const openScreen = (botId: string) => openOnWeb(url, `/bots/${encodeURIComponent(botId)}`)

  if (!chat) {
    return (
      <>
        <Stack.Screen options={{ title: '', headerBackTitle: 'Chats' }} />
        <View style={[styles.gone, { backgroundColor: colors.background }]}>
          {live.bots ? <Text style={[styles.goneText, { color: colors.mutedForeground }]}>{"This chat doesn't exist any more."}</Text> : <ActivityIndicator color={colors.mutedForeground} />}
        </View>
      </>
    )
  }

  const name = chatName(live.bots, chat)
  const subtitle = bot ? (bot.working ? 'Working' : bot.title) : typing ? `${typing.name} is taking a turn` : `${members.length} members`

  function rowElement(row: Row) {
    const card = row.message?.card
    const highlight = row.message && row.message.id === highlighted ? { backgroundColor: colors.blueSubtle } : undefined
    let content
    // A card's bot is its author's, so its routine chip and Screen open in a group chat too.
    const author = row.message?.botId
    if (card?.type === 'routine_change') {
      content = <RoutineChangeRow message={row.message!} card={card} onOpenRoutine={author ? (routineId) => openRoutine(author, routineId) : undefined} />
    }
    else if (card) {
      content = (
        <View style={styles.cardRow}>
          {group && !row.continuesPrevious && <Text style={[styles.author, { color: colors.mutedForeground }]}>{row.authorName}</Text>}
          {card.type === 'question' && <QuestionCard message={row.message!} card={card} />}
          {card.type === 'take_over' && <TakeOverCard message={row.message!} card={card} botName={row.authorName} onScreen={author ? () => openScreen(author) : undefined} />}
          {card.type === 'plugin_request' && <PluginRequestCard message={row.message!} card={card} botName={row.authorName} />}
          {card.type === 'plugin_reconnect' && <PluginReconnectCard card={card} botName={row.authorName} />}
        </View>
      )
    } else content = <MessageBubble row={row} showAuthor={!!group} onResend={live.connected ? (entry) => void send(entry.text, entry.files, entry.key) : undefined} onDiscard={(entry) => updateSends(chatId, (entries) => entries.filter((other) => other.key !== entry.key))} />
    return <View style={[styles.rowWrap, row.continuesNext ? styles.close : styles.apart, highlight]}>{content}</View>
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerBackTitle: 'Chats',
          headerTitleAlign: 'left',
          // Transparent on both platforms, so the screen always starts under the header (as iOS 26's glass bar
          // has it) and the transcript is padded below it the same way, keyboard included.
          headerTransparent: true,
          headerTitle: () => (
            <View style={styles.title} accessible accessibilityRole="header" accessibilityLabel={`${name}, ${subtitle}`}>
              {bot ? <BotAvatar bot={bot} size={30} working={bot.working} /> : <GroupAvatar members={members} size={30} working={!!typing} />}
              <View style={styles.titleText}>
                <Text numberOfLines={1} style={[styles.name, { color: colors.foreground }]}>
                  {name}
                </Text>
                {!!subtitle && (
                  <Text numberOfLines={1} style={[styles.subtitle, { color: bot?.working ? colors.greenForeground : colors.mutedForeground }]}>
                    {subtitle}
                  </Text>
                )}
              </View>
            </View>
          ),
          headerRight: () =>
            bot ? (
              <Pressable accessibilityRole="button" accessibilityLabel={`${bot.name}'s screen`} hitSlop={8} onPress={() => openScreen(bot.id)} style={styles.headerButton}>
                <ScreenIcon color={colors.foreground} />
              </Pressable>
            ) : null,
        }}
      />
      <KeyboardAvoidingView behavior="padding" style={[styles.screen, { paddingTop: headerHeight, backgroundColor: colors.background }]}>
        <ConnectionBanner />
        <View style={styles.screen}>
          {!messages.length && chat.lastMessage && unreachable ? (
            <Text style={[styles.empty, { color: colors.mutedForeground }]}>{"This chat's messages aren't on this phone yet. They show once OpenBot can be reached."}</Text>
          ) : !shown || (!messages.length && chat.lastMessage && !live.connected) ? (
            <ActivityIndicator style={styles.loading} color={colors.mutedForeground} />
          ) : rows.length === 0 && !typing ? (
            <Text style={[styles.empty, { color: colors.mutedForeground }]}>
              {bot ? `Say hi to ${bot.name}.` : 'Say hi to the group. Mention @name to ask one member, or @everyone.'}
            </Text>
          ) : (
            <FlatList
              ref={list}
              inverted
              data={newestFirst}
              keyExtractor={(row) => row.key}
              renderItem={({ item }) => rowElement(item)}
              contentContainerStyle={styles.content}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: followThreshold }}
              onEndReached={loadOlder}
              onEndReachedThreshold={1.5}
              onScroll={(event) => {
                following.current = event.nativeEvent.contentOffset.y < followThreshold
                if (following.current) setUnseen(false)
              }}
              scrollEventThrottle={64}
              onScrollToIndexFailed={({ index, averageItemLength }) => {
                // Not laid out that far yet: near it first, then to it once measured, once.
                if (retry.current) return
                list.current?.scrollToOffset({ offset: averageItemLength * index, animated: false })
                retry.current = setTimeout(() => list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: false }), 120)
              }}
              ListHeaderComponent={typing ? <Typing label={bot ? `${typing.name} is working` : `${typing.name} is taking a turn`} /> : undefined}
              ListFooterComponent={hasOlder || seeking ? <ActivityIndicator style={[styles.older, !loadingOlder && !seeking && styles.invisible]} color={colors.mutedForeground} /> : undefined}
            />
          )}
          {unseen && (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setUnseen(false)
                list.current?.scrollToOffset({ offset: 0, animated: true })
              }}
              style={[styles.unseen, { backgroundColor: colors.popover, borderColor: colors.border }]}
            >
              <Text style={[styles.unseenText, { color: colors.foreground }]}>New messages ↓</Text>
            </Pressable>
          )}
        </View>
        {error && <Text style={[styles.error, { color: colors.destructiveForeground }]}>{error}</Text>}
        {bot?.error && !bot.working && (
          <Text accessibilityRole="alert" style={[styles.modelError, { backgroundColor: `${colors.red}1a`, color: colors.redForeground }]}>
            {`${bot.name} couldn't reach its model: ${bot.error}. Check its provider in Settings on the web, then send your message again.`}
          </Text>
        )}
        <View style={{ paddingBottom: keyboard ? 0 : insets.bottom }}>
          <Composer
            chatId={chatId}
            label={`Message ${name}`}
            files={files}
            notice={notice}
            canSend={live.connected}
            onAttach={(added) => {
              const result = addFiles(files, added)
              setFiles(result.files)
              setNotice(result.notice)
            }}
            onRemove={(file) => {
              setFiles(files.filter((other) => other !== file))
              setNotice(undefined)
            }}
            onSend={(text) => {
              const sending = files
              setFiles([])
              setNotice(undefined)
              void send(text, sending)
            }}
          />
        </View>
      </KeyboardAvoidingView>
    </>
  )
}

/** A message: its author in a group, who it went to or came from between bots, its files, its Markdown in a bubble. */
function MessageBubble({
  row,
  showAuthor,
  onResend,
  onDiscard,
}: {
  row: Row
  showAuthor: boolean
  /** Undefined while the instance can't be reached, as there's no queue to send later. */
  onResend: ((entry: Outgoing<PickedFile>) => void) | undefined
  onDiscard: (entry: Outgoing<PickedFile>) => void
}) {
  const colors = useColors()
  const failed = row.outgoing?.error
  const markdown = useMemo(() => parseMarkdown(row.text), [row.text])
  const wide = hasBlocks(markdown)
  const corner = 6
  // Consecutive messages of one author sit close together, with tighter corners on the sender's side.
  const corners = row.mine
    ? { borderTopRightRadius: row.continuesPrevious ? corner : 18, borderBottomRightRadius: row.continuesNext ? corner : 18 }
    : { borderTopLeftRadius: row.continuesPrevious ? corner : 18, borderBottomLeftRadius: row.continuesNext ? corner : 18 }
  return (
    <View accessible={false} style={[styles.message, wide && styles.wide, row.mine ? styles.mine : styles.theirs]}>
      {showAuthor && !row.mine && !row.continuesPrevious && <Text style={[styles.author, { color: colors.mutedForeground }]}>{row.authorName}</Text>}
      {row.message?.botMessage && <BotMessageLabel botMessage={row.message.botMessage} />}
      {row.message && row.message.attachments.length > 0 && <Attachments messageId={row.message.id} attachments={row.message.attachments} mine={row.mine} />}
      {row.outgoing && row.outgoing.files.length > 0 && (
        <View style={[styles.outgoingFiles, row.mine && styles.end]}>
          <PickedFiles files={row.outgoing.files} progress={(row.outgoing as Sending).progress} dimmed={!!failed} />
        </View>
      )}
      {/* Grok doesn't bubble a message of files only. */}
      {!!row.text && (
        <View
          accessibilityLabel={`${row.authorName}: ${row.text}`}
          style={[styles.bubble, wide && styles.wideBubble, corners, { backgroundColor: row.mine ? colors.bubbleUser : colors.bubbleAgent, opacity: failed ? 0.6 : 1 }]}
        >
          <Markdown root={markdown} onColor={row.mine} />
        </View>
      )}
      {failed && row.outgoing && (
        <View accessibilityRole="alert" style={styles.failed}>
          <Text style={[styles.failedText, { color: colors.destructiveForeground }]}>Failed to send</Text>
          {onResend && (
            <Text accessibilityRole="button" onPress={() => onResend(row.outgoing!)} style={[styles.failedText, styles.failedAction, { color: colors.destructiveForeground }]}>
              Resend
            </Text>
          )}
          <Text accessibilityRole="button" onPress={() => onDiscard(row.outgoing!)} style={[styles.failedText, styles.failedAction, { color: colors.destructiveForeground }]}>
            Delete
          </Text>
        </View>
      )}
      {failed && <Text style={[styles.failedReason, { color: colors.mutedForeground }]}>{failed}</Text>}
    </View>
  )
}

/** Above a message between bots: Grok's "→ to Rex" on the sender's side, "← from Ana" on the recipient's. */
function BotMessageLabel({ botMessage }: { botMessage: BotMessageInfo }) {
  const colors = useColors()
  return (
    <Text style={[styles.author, { color: colors.mutedForeground }]}>
      {botMessage.direction === 'to' ? `→ to ${botMessage.name ?? 'a deleted bot'}` : `← from ${botMessage.name ?? 'a deleted bot'}`}
    </Text>
  )
}

/**
 * The bot working (a DM's) or taking its turn (a group's), as three dots in a bubble at the end, each brightening in
 * turn as the web's do; still with reduced motion.
 */
function Typing({ label }: { label: string }) {
  const colors = useColors()
  const [phase] = useState(() => new Animated.Value(0))
  useEffect(() => {
    let loop: Animated.CompositeAnimation | undefined
    let cancelled = false
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (reduce || cancelled) return
      loop = Animated.loop(Animated.timing(phase, { toValue: 1, duration: 1200, easing: Easing.linear, useNativeDriver: true }))
      loop.start()
    })
    return () => {
      cancelled = true
      loop?.stop()
    }
  }, [phase])
  return (
    <View accessible accessibilityLabel={label} style={[styles.typing, { backgroundColor: colors.bubbleAgent }]}>
      {[0, 1, 2].map((dot) => (
        <Animated.View
          key={dot}
          style={[
            styles.typingDot,
            {
              backgroundColor: colors.mutedForeground,
              // Each dot peaks a third of the cycle after the one before it.
              opacity: phase.interpolate({ inputRange: [0, dot / 3 + 0.01, dot / 3 + 0.2, 1], outputRange: [0.35, 0.35, 1, 0.35] }),
            },
          ]}
        />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  loading: { marginTop: 48 },
  gone: { flex: 1, alignItems: 'center', paddingTop: 48 },
  goneText: { fontSize: 15 },
  empty: { textAlign: 'center', fontSize: 15, marginTop: 48, paddingHorizontal: 32 },
  title: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 260 },
  titleText: { flexShrink: 1 },
  name: { fontSize: 16, fontWeight: '600' },
  subtitle: { fontSize: 12 },
  headerButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8 },
  rowWrap: { borderRadius: 16, marginHorizontal: -6, paddingHorizontal: 6 },
  close: { marginTop: 3 },
  apart: { marginTop: 14 },
  cardRow: { maxWidth: '92%', gap: 4 },
  message: { maxWidth: '85%', gap: 4 },
  wide: { width: '85%' },
  mine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  theirs: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  end: { justifyContent: 'flex-end' },
  author: { fontSize: 12, paddingHorizontal: 12 },
  bubble: { borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8 },
  wideBubble: { alignSelf: 'stretch' },
  outgoingFiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  failed: { flexDirection: 'row', gap: 10 },
  failedText: { fontSize: 14 },
  failedAction: { fontWeight: '600', textDecorationLine: 'underline' },
  failedReason: { fontSize: 12, maxWidth: 260, textAlign: 'right' },
  typing: { alignSelf: 'flex-start', flexDirection: 'row', gap: 4, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 11, marginTop: 14 },
  typingDot: { width: 6, height: 6, borderRadius: 3 },
  older: { paddingVertical: 12 },
  invisible: { opacity: 0 },
  unseen: {
    position: 'absolute',
    bottom: 10,
    alignSelf: 'center',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 6,
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)',
  },
  unseenText: { fontSize: 14 },
  error: { fontSize: 13, paddingHorizontal: 16, paddingVertical: 4 },
  modelError: { fontSize: 13, lineHeight: 18, marginHorizontal: 12, marginTop: 4, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, overflow: 'hidden' },
})
