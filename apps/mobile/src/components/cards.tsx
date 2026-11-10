import type {
  HandBackOutcome,
  MessageInfo,
  PluginReconnectCardInfo,
  PluginRequestCardInfo,
  PluginRequestChoice,
  QuestionAnswer,
  QuestionCardInfo,
  RoutineChangeCardInfo,
  TakeOverCardInfo,
} from '@openbot/api-contract'
import { optionLetter, routineChangeVerbs, shownAnswer, useLive } from '@openbot/client'
import { type ReactNode, useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { errorMessage } from '../lib/errors.ts'
import { useInstance } from '../lib/instance-context.ts'
import { openOnWeb } from '../lib/open-on-web.ts'
import { useLoadOnFocus } from '../lib/use-load.ts'
import { useColors } from '../lib/theme.ts'
import { ClockIcon, CloseIcon } from './icons.tsx'
import { Markdown } from './markdown.tsx'
import { PluginIcon } from './plugin-icon.tsx'

/**
 * Sends a card's answer (an answer, a dismissal, a hand-back, a decision) once at a time, putting the server's message
 * as it is now in the transcript, and keeps the error to show. `blocked` while one is sending or the instance can't be
 * reached.
 */
function useCardAction() {
  const live = useLive()
  const [sending, setSending] = useState<string>()
  const [error, setError] = useState<string>()
  async function run(which: string, request: () => Promise<MessageInfo>) {
    if (sending) return
    setSending(which)
    setError(undefined)
    try {
      live.addMessage(await request())
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSending(undefined)
    }
  }
  // Offline, cards are read-only, as the rest of the chat (spec: Offline).
  return { sending, error, run, blocked: !!sending || !live.connected }
}

/** A card's frame: a bubble as wide as the transcript allows, outlined while it waits for the owner. */
function Frame({ waiting, label, children }: { waiting: boolean; label: string; children: ReactNode }) {
  const colors = useColors()
  return (
    <View
      accessible={false}
      accessibilityLabel={label}
      style={[styles.frame, { backgroundColor: colors.bubbleAgent }, waiting && { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong }]}
    >
      {children}
    </View>
  )
}

/** The card's status: Action needed (amber) while it waits, then how it ended. */
function Status({ label, tone }: { label: string; tone: 'waiting' | 'done' | 'off' }) {
  const colors = useColors()
  const dot = tone === 'waiting' ? colors.amber : tone === 'done' ? colors.green : colors.mutedForeground
  return (
    <View style={[styles.status, { backgroundColor: colors.secondary }]}>
      <View style={[styles.statusDot, { backgroundColor: dot }]} />
      <Text style={[styles.statusText, { color: colors.mutedForeground }]}>{label}</Text>
    </View>
  )
}

function Header({ title, icon, status }: { title: string; icon?: ReactNode; status: ReactNode }) {
  const colors = useColors()
  return (
    <View style={styles.header}>
      {icon}
      <Text numberOfLines={1} style={[styles.headerTitle, { color: colors.foreground }]}>
        {title}
      </Text>
      {status}
    </View>
  )
}

/** A card's button: `primary` (black, white in dark), `outline` or `plain`. */
function CardButton({
  label,
  onPress,
  kind = 'outline',
  busy = false,
  disabled = false,
}: {
  label: string
  onPress: () => void
  kind?: 'primary' | 'outline' | 'plain'
  busy?: boolean
  disabled?: boolean
}) {
  const colors = useColors()
  const color = kind === 'primary' ? colors.primaryForeground : kind === 'plain' ? colors.mutedForeground : colors.foreground
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        kind === 'primary' && { backgroundColor: colors.primary },
        kind === 'outline' && { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong },
        { opacity: disabled ? 0.5 : pressed ? 0.7 : 1 },
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={color} /> : <Text style={[styles.buttonText, { color }]}>{label}</Text>}
    </Pressable>
  )
}

function ErrorLine({ error }: { error: string | undefined }) {
  const colors = useColors()
  if (!error) return null
  return (
    <Text accessibilityRole="alert" style={[styles.small, { color: colors.destructiveForeground }]}>
      {error}
    </Text>
  )
}

/**
 * A bot's question: its prompt, 1–6 lettered options a tap answers and, when allowed, the owner's own answer. Its ×
 * dismisses it unanswered without waking the bot. Once answered or dismissed it shows how.
 */
export function QuestionCard({ message, card }: { message: MessageInfo; card: QuestionCardInfo }) {
  const { api } = useInstance()
  const colors = useColors()
  const { sending, error, run, blocked } = useCardAction()
  const [text, setText] = useState('')
  const answer = (chosen: QuestionAnswer, which: string) => void run(which, () => api.chats.answer({ messageId: message.id, answer: chosen }))

  if (card.dismissed) {
    return (
      <Frame waiting={false} label="Dismissed question">
        <Text style={[styles.body, { color: colors.mutedForeground }]}>{card.prompt}</Text>
        <Text style={[styles.small, { color: colors.mutedForeground }]}>Dismissed</Text>
      </Frame>
    )
  }
  if (card.answer) {
    return (
      <Frame waiting={false} label="Answered question">
        <Text style={[styles.body, { color: colors.mutedForeground }]}>{card.prompt}</Text>
        <View style={styles.answered}>
          <Text style={[styles.body, styles.strong, { color: colors.greenForeground }]}>✓</Text>
          <Text accessibilityLabel={`Answered: ${shownAnswer(card)}`} style={[styles.body, styles.strong, styles.flex, { color: colors.foreground }]}>
            {shownAnswer(card)}
          </Text>
        </View>
      </Frame>
    )
  }
  return (
    <Frame waiting label="Question">
      <View style={styles.questionTop}>
        <Text style={[styles.body, styles.strong, styles.flex, { color: colors.foreground }]}>{card.prompt}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss question"
          hitSlop={10}
          disabled={blocked}
          onPress={() => void run('dismiss', () => api.chats.dismiss({ messageId: message.id }))}
          style={({ pressed }) => [styles.dismiss, { opacity: blocked ? 0.5 : pressed ? 0.6 : 1 }]}
        >
          <CloseIcon color={colors.mutedForeground} />
        </Pressable>
      </View>
      {card.details && <Markdown text={card.details} muted />}
      <View style={styles.options}>
        {card.options.map((option, index) => {
          const tone =
            option.style === 'primary'
              ? { background: colors.primary, color: colors.primaryForeground }
              : option.style === 'danger'
                ? { background: `${colors.red}1a`, color: colors.redForeground }
                : { background: colors.secondary, color: colors.foreground }
          return (
            <Pressable
              key={index}
              accessibilityRole="button"
              accessibilityLabel={`${optionLetter(index)}. ${option.label}${option.description ? `. ${option.description}` : ''}`}
              disabled={blocked}
              onPress={() => answer({ option: index }, `option${index}`)}
              style={({ pressed }) => [styles.option, { backgroundColor: tone.background, opacity: blocked && sending !== `option${index}` ? 0.6 : pressed ? 0.75 : 1 }]}
            >
              <View style={[styles.letter, { borderColor: `${tone.color}40` }]}>
                {sending === `option${index}` ? (
                  <ActivityIndicator size="small" color={tone.color} />
                ) : (
                  <Text style={[styles.letterText, { color: tone.color }]}>{optionLetter(index)}</Text>
                )}
              </View>
              <View style={styles.flex}>
                <Text style={[styles.body, styles.strong, { color: tone.color }]}>{option.label}</Text>
                {option.description && <Text style={[styles.small, { color: tone.color, opacity: 0.75 }]}>{option.description}</Text>}
              </View>
            </Pressable>
          )
        })}
      </View>
      {card.allowText && (
        <View style={styles.ownAnswer}>
          <TextInput
            accessibilityLabel="Type your own answer"
            placeholder="Type your own answer"
            placeholderTextColor={colors.faint}
            multiline
            value={text}
            onChangeText={setText}
            style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
          />
          {!!text.trim() && <CardButton label="Submit" kind="primary" busy={sending === 'text'} disabled={blocked} onPress={() => answer({ text: text.trim() }, 'text')} />}
        </View>
      )}
      <ErrorLine error={error} />
    </Frame>
  )
}

const takeOverStatus = {
  waiting: { label: 'Action needed', tone: 'waiting' },
  done: { label: 'Done', tone: 'done' },
  skipped: { label: 'Skipped', tone: 'off' },
} as const

/**
 * A bot stuck on its screen asks the owner to take over: the instruction, then **Take over**, which opens the bot's
 * screen (on the web until the phone's Screen comes, #114), **I'm done**, which hands it back and wakes the bot, and
 * **Skip**, which hands it back without the step. Once handed back it shows how.
 */
export function TakeOverCard({ message, card, botName, onScreen }: { message: MessageInfo; card: TakeOverCardInfo; botName: string; onScreen?: () => void }) {
  const { api } = useInstance()
  const colors = useColors()
  const { sending, error, run, blocked } = useCardAction()
  const handBack = (outcome: HandBackOutcome) => void run(outcome, () => api.chats.handBack({ messageId: message.id, outcome }))
  const status = takeOverStatus[card.outcome ?? 'waiting']
  return (
    <Frame waiting={!card.outcome} label={`${botName} needs you on its screen`}>
      <Header title="Screen" status={<Status label={status.label} tone={status.tone} />} />
      <Text style={[styles.small, { color: card.outcome ? colors.mutedForeground : colors.foreground }]}>{card.instruction}</Text>
      {card.outcome ? (
        <View style={styles.buttons}>
          {onScreen && <CardButton label="Open screen" onPress={onScreen} />}
        </View>
      ) : (
        <View style={styles.buttons}>
          {onScreen && <CardButton label="✋ Take over" kind="primary" onPress={onScreen} />}
          <CardButton label="I'm done" busy={sending === 'done'} disabled={blocked} onPress={() => handBack('done')} />
          <CardButton label="Skip" kind="plain" busy={sending === 'skipped'} disabled={blocked} onPress={() => handBack('skipped')} />
        </View>
      )}
      <ErrorLine error={error} />
    </Frame>
  )
}

/** The picker's choice that connects a new account instead of granting a connected one. */
const another = 'another'

/**
 * A bot asks for a plugin: the plugin and the bot's reason, then, while it waits, an account picker with "Connect another
 * account" and **Allow** when the plugin has accounts, **Connect** when it has none, or **Allow** alone for a plugin of
 * skills only; **Deny** in every case. Connecting signs in on the plugin's page on the web, as Settings → Plugins does
 * on the phone; back in the app the new account is in the picker, to allow.
 */
export function PluginRequestCard({ message, card, botName }: { message: MessageInfo; card: PluginRequestCardInfo; botName: string }) {
  const { api, url } = useInstance()
  const colors = useColors()
  const { sending, error, run, blocked } = useCardAction()
  const waiting = !card.decision
  // Loaded again on returning from the browser, where an account may have been connected.
  const plugin = useLoadOnFocus(useCallback(() => (waiting ? api.plugins.get({ name: card.plugin }) : Promise.resolve(undefined)), [api, card.plugin, waiting]))
  const [picked, setPicked] = useState<string>()
  const accounts = plugin.data?.accounts ?? []
  // An account picked, then disconnected, falls back to the first.
  const choice = (picked === another || accounts.some((account) => account.slug === picked) ? picked : undefined) ?? accounts[0]?.slug ?? another
  const decide = (decision: PluginRequestChoice, which: string) => void run(which, () => api.chats.decidePluginRequest({ messageId: message.id, decision }))
  const connect = () => openOnWeb(url, `/settings/plugins/${encodeURIComponent(card.plugin)}`)

  const status = !card.decision
    ? ({ label: 'Action needed', tone: 'waiting' } as const)
    : card.decision.outcome === 'granted'
      ? ({ label: card.decision.account ? `Granted · ${card.decision.account.displayName}` : 'Granted', tone: 'done' } as const)
      : ({ label: 'Denied', tone: 'off' } as const)
  const connecting = !card.skillsOnly && choice === another
  return (
    <Frame waiting={waiting} label={`${botName} asks for ${card.displayName}`}>
      <Header title={card.displayName} icon={plugin.data && <PluginIcon plugin={plugin.data} size={20} />} status={<Status label={status.label} tone={status.tone} />} />
      <Text style={[styles.small, { color: waiting ? colors.foreground : colors.mutedForeground }]}>
        {botName} wants to use {card.displayName}: {card.reason}
      </Text>
      {waiting && plugin.data && !card.skillsOnly && accounts.length > 0 && (
        <View accessibilityRole="radiogroup" accessibilityLabel="Account to grant" style={styles.radios}>
          {[...accounts.map((account) => ({ value: account.slug, label: account.displayName })), { value: another, label: 'Connect another account' }].map((option) => (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: choice === option.value, disabled: blocked }}
              disabled={blocked}
              onPress={() => setPicked(option.value)}
              style={styles.radio}
            >
              <View style={[styles.radioOuter, { borderColor: choice === option.value ? colors.foreground : colors.borderStrong }]}>
                {choice === option.value && <View style={[styles.radioInner, { backgroundColor: colors.foreground }]} />}
              </View>
              <Text numberOfLines={1} style={[styles.small, styles.flex, { color: colors.foreground }]}>
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {waiting && (
        <View style={styles.buttons}>
          <CardButton
            label={connecting ? 'Connect ↗' : 'Allow'}
            kind="primary"
            busy={sending === 'allow'}
            disabled={blocked || !plugin.data}
            onPress={() => (connecting ? connect() : decide({ outcome: 'granted', account: card.skillsOnly ? null : choice }, 'allow'))}
          />
          <CardButton label="Deny" kind="plain" busy={sending === 'deny'} disabled={blocked} onPress={() => decide({ outcome: 'denied' }, 'deny')} />
        </View>
      )}
      <ErrorLine error={error ?? (waiting ? plugin.error : undefined)} />
    </Frame>
  )
}

/**
 * A plugin account the bot is granted needs reconnecting: **Reconnect** signs in again on the plugin's page on the web
 * (as Settings → Plugins does on the phone); the card changes once it is reconnected or disconnected.
 */
export function PluginReconnectCard({ card, botName }: { card: PluginReconnectCardInfo; botName: string }) {
  const { url } = useInstance()
  const colors = useColors()
  const waiting = !card.outcome
  const label = `${card.displayName} (${card.account.displayName})`
  return (
    <Frame waiting={waiting} label={`${label} needs reconnecting`}>
      <Header
        title={label}
        status={<Status label={waiting ? 'Needs reconnect' : card.outcome === 'reconnected' ? 'Reconnected' : 'Disconnected'} tone={waiting ? 'waiting' : card.outcome === 'reconnected' ? 'done' : 'off'} />}
      />
      <Text style={[styles.small, { color: waiting ? colors.foreground : colors.mutedForeground }]}>
        {`The sign-in to ${label} expired and couldn't be renewed, so ${botName} can't use its tools until you reconnect it.`}
      </Text>
      {waiting && (
        <View style={styles.buttons}>
          <CardButton label="Reconnect ↗" kind="primary" onPress={() => openOnWeb(url, `/settings/plugins/${encodeURIComponent(card.plugin)}`)} />
        </View>
      )}
    </Frame>
  )
}

/** Grok's timeline row: "Rex created routine", a clock chip naming the routine that opens it, and the time, between two rules. */
export function RoutineChangeRow({ message, card, onOpenRoutine }: { message: MessageInfo; card: RoutineChangeCardInfo; onOpenRoutine?: (routineId: string) => void }) {
  const colors = useColors()
  const opens = !!onOpenRoutine && card.change !== 'deleted'
  const time = new Date(message.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return (
    <View accessible accessibilityLabel={`${message.authorName} ${routineChangeVerbs[card.change]} routine ${card.name}, ${time}`} style={styles.timeline}>
      <View style={[styles.rule, { backgroundColor: colors.border }]} />
      <Text style={[styles.small, { color: colors.mutedForeground }]}>
        {message.authorName} {routineChangeVerbs[card.change]} routine
      </Text>
      <Pressable
        accessibilityRole={opens ? 'button' : undefined}
        accessibilityLabel={`Open ${card.name}`}
        disabled={!opens}
        onPress={() => onOpenRoutine?.(card.routineId)}
        style={({ pressed }) => [styles.chip, { borderColor: colors.border, backgroundColor: pressed ? colors.secondary : colors.card }]}
      >
        <ClockIcon color={colors.mutedForeground} />
        <Text numberOfLines={1} style={[styles.small, styles.chipText, { color: colors.foreground }]}>
          {card.name}
        </Text>
      </Pressable>
      <Text style={[styles.time, { color: colors.mutedForeground }]}>{time}</Text>
      <View style={[styles.rule, { backgroundColor: colors.border }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  frame: { borderRadius: 16, padding: 12, gap: 10, alignSelf: 'stretch' },
  flex: { flex: 1, minWidth: 0 },
  body: { fontSize: 16, lineHeight: 22 },
  small: { fontSize: 14, lineHeight: 20 },
  strong: { fontWeight: '600' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: { fontSize: 14, fontWeight: '500', flexShrink: 1 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 12 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  button: { minHeight: 36, minWidth: 64, paddingHorizontal: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 15, fontWeight: '500' },
  answered: { flexDirection: 'row', gap: 8 },
  questionTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  dismiss: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', marginTop: -3, marginRight: -4 },
  options: { gap: 6 },
  option: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, minHeight: 44 },
  letter: { width: 22, height: 22, borderRadius: 6, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginTop: 0 },
  letterText: { fontSize: 12, fontWeight: '600' },
  ownAnswer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: { flex: 1, minHeight: 40, maxHeight: 140, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10, fontSize: 16 },
  radios: { gap: 2 },
  radio: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 36 },
  radioOuter: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  radioInner: { width: 10, height: 10, borderRadius: 5 },
  timeline: { flexDirection: 'row', alignItems: 'center', gap: 6, marginVertical: 6 },
  rule: { height: StyleSheet.hairlineWidth, flex: 1, minWidth: 12 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, maxWidth: 160, flexShrink: 1 },
  chipText: { flexShrink: 1 },
  time: { fontSize: 12, fontVariant: ['tabular-nums'] },
})
