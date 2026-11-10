import type { BotInfo, HandBackOutcome } from '@openbot/api-contract'
import { useLive, waitingTakeOver } from '@openbot/client'
import { inputChange, type Modifier, type ScreenStatus, type ScreenViewport, type SpecialKey } from '@openbot/client/screen'
import * as Clipboard from 'expo-clipboard'
import { NetworkStateType, useNetworkState } from 'expo-network'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { type ReactNode, type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Keyboard, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, type TextInputInstance, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ActualSizeIcon, CloseIcon, FitIcon, KeyboardIcon, KeysIcon, PasteIcon, TuckIcon } from '../../components/icons.tsx'
import ScreenView, { type ScreenViewRef } from '../../components/screen-view.tsx'
import { useAppActive } from '../../lib/app-state.ts'
import { errorMessage } from '../../lib/errors.ts'
import { useInstance } from '../../lib/instance-context.ts'
import { kvStorage } from '../../lib/storage.ts'
import { turnHintKey } from '../../lib/storage-keys.ts'

// Every screen is 1280×800 (`screenSize` on the server).
const screenAspect = 1280 / 800

/** Dark in both themes, as the web's fullscreen Screen and Grok's take-control view. */
const tone = {
  background: '#0b0b0b',
  bar: '#1c1c1e',
  raised: '#2c2c2e',
  text: '#ffffff',
  muted: 'rgba(255,255,255,0.62)',
  amberBg: 'rgba(249,133,0,0.16)',
  amber: '#ffbd3b',
  on: '#ffffff',
  onText: '#000000',
}

/**
 * A bot's Screen, full-screen over the app (spec: Screen and take-over). From the chat's header or the bot's info
 * screen it opens view-only, with **Take over** always there (control is shared, the bot isn't paused) and **Hand back**
 * to watch again. From a take-over card's Take over (`takeOverId`, its message, in `chatId`) it opens in control, the
 * card's instruction pinned with **I'm done, continue** and **Skip this step**, which hand back and close. Closing
 * never hands back: a card stays waiting. It alone turns with the phone: portrait fits the width with the toolbar
 * below (and a one-time hint to turn sideways), landscape fills the display with a slim floating toolbar.
 */
export default function ScreenScreen() {
  const { botId, takeOverId, chatId } = useLocalSearchParams<{ botId: string; takeOverId?: string; chatId?: string }>()
  const live = useLive()
  const bot = live.bots?.find((each) => each.id === botId)
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      {bot ? (
        <Viewer bot={bot} takeOverId={takeOverId} chatId={chatId ?? bot.chatId} />
      ) : (
        <View style={[styles.fill, styles.center, { backgroundColor: tone.background }]}>
          {live.bots ? <Text style={styles.muted}>{"This bot doesn't exist any more."}</Text> : <ActivityIndicator color={tone.muted} />}
        </View>
      )}
    </>
  )
}

function Viewer({ bot, takeOverId, chatId }: { bot: BotInfo; takeOverId?: string; chatId: string }) {
  const { api, url } = useInstance()
  const live = useLive()
  const insets = useSafeAreaInsets()
  const window = useWindowDimensions()
  const landscape = window.width > window.height
  // The card opened from, or else the latest waiting in the bot's chat, as on the web.
  const waiting = waitingTakeOver(live.messages.get(chatId) ?? [], takeOverId)
  // A card's Take over opens in control (once its message is in, should it come a moment later); otherwise it's
  // watched until the owner takes over.
  const [interactive, setInteractive] = useState(false)
  const [tookOver, setTookOver] = useState(false)
  if (takeOverId && waiting && !tookOver) {
    setTookOver(true)
    setInteractive(true)
  }
  const [viewport, setViewport] = useState<ScreenViewport>('fit')
  const [status, setStatus] = useState<ScreenStatus>('connecting')
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const [modifiers, setModifiers] = useState<Modifier[]>([])
  const [tucked, setTucked] = useState(false)
  const screen = useRef<ScreenViewRef>(null)
  const keyboardInput = useRef<TextInputInstance>(null)
  // Lower quality and higher compression on cellular (spec: automatic only).
  const network = useNetworkState()
  const quality = network.type === NetworkStateType.CELLULAR ? 'low' : 'high'
  // The stream closes in the background and opens again on return.
  const active = useAppActive()

  // "Turn sideways for a bigger screen", the first time on this phone, in portrait until it's turned.
  const [firstTime] = useState(() => kvStorage.getItem(turnHintKey) === null)
  useEffect(() => {
    if (firstTime) kvStorage.setItem(turnHintKey, 'yes')
  }, [firstTime])
  const [turned, setTurned] = useState(false)
  if (landscape && !turned) setTurned(true)
  const hint = firstTime && !turned

  /** Watching again (Hand back) puts the keyboard and keys away, letting go of the modifiers. */
  const watch = () => {
    setInteractive(false)
    setKeysOpen(false)
    setModifiers([])
    keyboardInput.current?.blur()
  }

  // The keyboard put away by the phone (its own button, turning) leaves the hidden input: it's let go too, so the
  // Keyboard button raises it again on the next tap.
  useEffect(() => {
    const subscription = Keyboard.addListener('keyboardDidHide', () => keyboardInput.current?.blur())
    return () => subscription.remove()
  }, [])

  const close = () => router.back()
  const handBack = (outcome: HandBackOutcome) => {
    if (!waiting) return
    // As on the web: sent, and the Screen closes without waiting; the card in the chat shows how it went.
    api.chats.handBack({ messageId: waiting.message.id, outcome }).then(
      (message) => live.addMessage(message),
      (caught) => Alert.alert("Couldn't hand back", errorMessage(caught)),
    )
    close()
  }
  const toggleKeyboard = () => (keyboardOpen ? keyboardInput.current?.blur() : keyboardInput.current?.focus())
  /** What the phone's keyboard did to the hidden input, typed on the Screen, the held modifiers going with it. */
  const onTyped = (backspaces: number, text: string) => withModifiers((held) => screen.current?.type(backspaces, text, held))
  const toggleModifier = (modifier: Modifier) => setModifiers((held) => (held.includes(modifier) ? held.filter((each) => each !== modifier) : [...held, modifier]))
  /** Sends a key with the held modifiers, which then let go. */
  const withModifiers = (send: (held: Modifier[]) => void) => {
    send(modifiers)
    setModifiers([])
  }
  const press = (key: SpecialKey) => withModifiers((held) => screen.current?.press(key, held))
  const paste = async () => {
    const text = await Clipboard.getStringAsync()
    if (text) withModifiers((held) => screen.current?.type(0, text, held))
  }
  // Closing the keys lets go of the modifiers, which would otherwise go, unseen, with the next key typed.
  const toggleKeys = () => {
    if (keysOpen) setModifiers([])
    setKeysOpen(!keysOpen)
  }
  const onStatus = useCallback(async (next: ScreenStatus) => setStatus(next), [])
  const ticket = useCallback((input: { botId: string }) => api.screens.ticket(input), [api])

  const fitHeight = Math.round(window.width / screenAspect)

  const view = active ? (
    <ScreenView
      ref={screen}
      botId={bot.id}
      server={url}
      interactive={interactive}
      quality={quality}
      viewport={viewport}
      ticket={ticket}
      onStatus={onStatus}
      dom={{
        scrollEnabled: false,
        bounces: false,
        overScrollMode: 'never',
        style: { flex: 1, backgroundColor: 'transparent' },
        containerStyle: { flex: 1 },
      }}
    />
  ) : null

  const pill = <StatusPill status={status} botName={bot.name} onRetry={() => screen.current?.retry()} />
  const toggleControl = <ControlButton interactive={interactive} hasCard={!!waiting} onTakeOver={() => setInteractive(true)} onHandBack={watch} />
  const tools = (
    <Toolbar
      compact={landscape}
      interactive={interactive}
      viewport={viewport}
      keyboardOpen={keyboardOpen}
      keysOpen={keysOpen}
      onKeyboard={toggleKeyboard}
      onKeys={toggleKeys}
      onPaste={() => void paste()}
      onViewport={() => setViewport((now) => (now === 'fit' ? 'actual' : 'fit'))}
    />
  )
  const keys = interactive && keysOpen ? <KeysRow modifiers={modifiers} onPress={press} onModifier={toggleModifier} /> : null
  const note = interactive && bot.working && !waiting ? <Text style={[styles.note, landscape && styles.noteFloating]}>{`${bot.name} is working; you'll both be in control.`}</Text> : null
  const banner = waiting ? <CardBanner instruction={waiting.card.instruction} botName={bot.name} compact={landscape} onHandBack={handBack} /> : null

  // One tree for both orientations, the frame always in the same place, so turning the phone keeps the stream.
  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.fill, { backgroundColor: tone.background, paddingTop: landscape ? 0 : insets.top }]}>
      <StatusBar hidden={landscape} style="light" />
      {!landscape && (
        <View style={styles.topBar}>
          <IconButton label="Close" onPress={close}>
            <CloseIcon color={tone.text} size={16} />
          </IconButton>
          <Text numberOfLines={1} style={styles.title}>{`${bot.name}'s screen`}</Text>
          {toggleControl}
        </View>
      )}
      {!landscape && banner}
      {!landscape && note}
      <View style={landscape || viewport === 'actual' ? styles.fill : { height: fitHeight }}>
        {interactive && <HiddenKeyboardInput ref={keyboardInput} onTyped={onTyped} onEnter={() => press('enter')} onFocusChange={setKeyboardOpen} />}
        {view}
        {pill}
      </View>
      {!landscape && (
        <>
          <View style={styles.fill} />
          {hint && <Text style={styles.hint}>Turn sideways for a bigger screen.</Text>}
          {keys}
          <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>{tools}</View>
        </>
      )}
      {landscape && (
        <>
          <View pointerEvents="box-none" style={[styles.floatingTop, { left: insets.left + 12, right: insets.right + 12 }]}>
            {banner}
            {note}
          </View>
          <View pointerEvents="box-none" style={[styles.floatingBottom, { paddingLeft: insets.left + 12, paddingRight: insets.right + 12, paddingBottom: Math.max(insets.bottom, 8) }]}>
            {keys}
            {tucked ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Show the toolbar" onPress={() => setTucked(false)} style={[styles.tuckHandle, { backgroundColor: tone.bar }]}>
                <TuckIcon color={tone.text} out />
              </Pressable>
            ) : (
              <View style={[styles.floatingBar, { backgroundColor: tone.bar }]}>
                <IconButton label="Close" onPress={close}>
                  <CloseIcon color={tone.text} size={16} />
                </IconButton>
                {toggleControl}
                {tools}
                <IconButton label="Tuck the toolbar away" onPress={() => setTucked(true)}>
                  <TuckIcon color={tone.muted} out={false} />
                </IconButton>
              </View>
            )}
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  )
}

/** The hidden input's filling, so Backspace always has something to take off (as noVNC's app does). */
const filling = '_'.repeat(64)

/**
 * The phone's keyboard on the Screen, the hidden-input trick from noVNC's app: an input out of sight, kept filled,
 * whose changes are typed on the Screen (characters taken off as Backspace, an autocorrection undone back to where it
 * differs and typed again). It's native rather than in the page: the Keyboard button is tapped in the app, and a page
 * raises no keyboard for a focus that doesn't come from a tap in it (iOS, unless the web view is told otherwise, which
 * Expo's can't be; Android, whose web view hasn't the focus).
 */
function HiddenKeyboardInput({
  ref,
  onTyped,
  onEnter,
  onFocusChange,
}: {
  ref: Ref<TextInputInstance>
  onTyped: (backspaces: number, text: string) => void
  onEnter: () => void
  onFocusChange: (focused: boolean) => void
}) {
  const input = useRef<TextInputInstance>(null)
  useImperativeHandle(ref, () => input.current!, [])
  const value = useRef(filling)
  const refill = () => {
    value.current = filling
    input.current?.setNativeProps({ text: filling })
    input.current?.setSelection(filling.length, filling.length)
  }
  return (
    <TextInput
      ref={input}
      defaultValue={filling}
      onChangeText={(next) => {
        const { backspaces, text } = inputChange(value.current, next)
        value.current = next
        if (backspaces || text) onTyped(backspaces, text)
        // Kept from running out, or growing without end.
        if (next.length < filling.length / 2 || next.length > filling.length * 4) refill()
      }}
      onSubmitEditing={onEnter}
      submitBehavior="submit"
      onFocus={() => {
        refill()
        onFocusChange(true)
      }}
      onBlur={() => onFocusChange(false)}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      autoComplete="off"
      importantForAutofill="no"
      caretHidden
      contextMenuHidden
      // Android's landscape keyboard would otherwise cover the display with an editor showing the filling.
      disableFullscreenUI
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.hiddenInput}
    />
  )
}

/** Take over when watching, Hand back when in control without a card (a card's own buttons hand back with one). */
function ControlButton({ interactive, hasCard, onTakeOver, onHandBack }: { interactive: boolean; hasCard: boolean; onTakeOver: () => void; onHandBack: () => void }) {
  if (interactive && hasCard) return <View style={styles.controlSpacer} />
  return interactive ? (
    <Pressable accessibilityRole="button" onPress={onHandBack} style={({ pressed }) => [styles.control, { backgroundColor: tone.raised }, pressed && styles.pressed]}>
      <Text style={[styles.controlText, { color: tone.text }]}>Hand back</Text>
    </Pressable>
  ) : (
    <Pressable accessibilityRole="button" onPress={onTakeOver} style={({ pressed }) => [styles.control, { backgroundColor: tone.on }, pressed && styles.pressed]}>
      <Text style={[styles.controlText, { color: tone.onText }]}>✋ Take over</Text>
    </Pressable>
  )
}

/** The take-over card's instruction, pinned, with its hand-backs, as the web's fullscreen banner. */
function CardBanner({ instruction, botName, compact, onHandBack }: { instruction: string; botName: string; compact: boolean; onHandBack: (outcome: HandBackOutcome) => void }) {
  return (
    <View accessibilityRole="summary" style={[styles.banner, compact && styles.bannerCompact]}>
      <Text numberOfLines={compact ? 2 : 4} style={styles.bannerText}>
        {instruction.trim() || `${botName} needs you`}
      </Text>
      <View style={styles.bannerButtons}>
        <Pressable accessibilityRole="button" onPress={() => onHandBack('skipped')} style={({ pressed }) => [styles.bannerButton, { backgroundColor: 'rgba(255,255,255,0.12)' }, pressed && styles.pressed]}>
          <Text style={[styles.controlText, { color: tone.text }]}>Skip this step</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => onHandBack('done')} style={({ pressed }) => [styles.bannerButton, { backgroundColor: tone.on }, pressed && styles.pressed]}>
          <Text style={[styles.controlText, { color: tone.onText }]}>{"I'm done, continue"}</Text>
        </Pressable>
      </View>
    </View>
  )
}

const statusLabels: Partial<Record<ScreenStatus, string>> = {
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  starting: 'Booting up the computer…',
}

/** Connecting… / Reconnecting… / Booting up the computer…, or "Can't reach Rex's screen" with Retry; nothing once connected. */
function StatusPill({ status, botName, onRetry }: { status: ScreenStatus; botName: string; onRetry: () => void }) {
  if (status === 'connected') return null
  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, styles.center]}>
      <View accessibilityRole="alert" style={[styles.pill, { backgroundColor: tone.raised }]}>
        {status === 'unreachable' ? (
          <>
            <Text style={styles.pillText}>{`Can't reach ${botName}'s screen`}</Text>
            <Pressable accessibilityRole="button" onPress={onRetry} hitSlop={8} style={({ pressed }) => [styles.retry, pressed && styles.pressed]}>
              <Text style={[styles.controlText, { color: tone.onText }]}>Retry</Text>
            </Pressable>
          </>
        ) : (
          <>
            <ActivityIndicator size="small" color={tone.muted} />
            <Text style={styles.pillText}>{statusLabels[status]}</Text>
          </>
        )}
      </View>
    </View>
  )
}

function Toolbar({
  compact,
  interactive,
  viewport,
  keyboardOpen,
  keysOpen,
  onKeyboard,
  onKeys,
  onPaste,
  onViewport,
}: {
  compact: boolean
  interactive: boolean
  viewport: ScreenViewport
  keyboardOpen: boolean
  keysOpen: boolean
  onKeyboard: () => void
  onKeys: () => void
  onPaste: () => void
  onViewport: () => void
}) {
  const Tool = compact ? IconButton : LabelledTool
  return (
    <>
      {interactive && (
        <>
          <Tool label="Keyboard" selected={keyboardOpen} onPress={onKeyboard}>
            <KeyboardIcon color={tone.text} />
          </Tool>
          <Tool label="Keys" selected={keysOpen} onPress={onKeys}>
            <KeysIcon color={tone.text} />
          </Tool>
          <Tool label="Paste" onPress={onPaste}>
            <PasteIcon color={tone.text} />
          </Tool>
        </>
      )}
      <Tool label={viewport === 'fit' ? '1:1' : 'Fit'} onPress={onViewport}>
        {viewport === 'fit' ? <ActualSizeIcon color={tone.text} /> : <FitIcon color={tone.text} />}
      </Tool>
    </>
  )
}

function LabelledTool({ label, selected, onPress, children }: { label: string; selected?: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.tool, selected && { backgroundColor: tone.raised }, pressed && styles.pressed]}
    >
      {children}
      <Text style={styles.toolLabel}>{label}</Text>
    </Pressable>
  )
}

function IconButton({ label, selected, onPress, children }: { label: string; selected?: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, selected && { backgroundColor: tone.raised }, pressed && styles.pressed]}
    >
      {children}
    </Pressable>
  )
}

const keyButtons: { key: SpecialKey; label: string; name: string }[] = [
  { key: 'escape', label: 'Esc', name: 'Escape' },
  { key: 'tab', label: 'Tab', name: 'Tab' },
  { key: 'enter', label: 'Enter', name: 'Enter' },
  { key: 'left', label: '←', name: 'Left arrow' },
  { key: 'up', label: '↑', name: 'Up arrow' },
  { key: 'down', label: '↓', name: 'Down arrow' },
  { key: 'right', label: '→', name: 'Right arrow' },
]

const modifierButtons: { modifier: Modifier; label: string }[] = [
  { modifier: 'ctrl', label: 'Ctrl' },
  { modifier: 'alt', label: 'Alt' },
  { modifier: 'super', label: 'Super' },
]

/** Ctrl, Alt and Super, held until the next key, then Esc, Tab and Enter; the arrows below. */
function KeysRow({ modifiers, onPress, onModifier }: { modifiers: Modifier[]; onPress: (key: SpecialKey) => void; onModifier: (modifier: Modifier) => void }) {
  const keyButton = ({ key, label, name }: (typeof keyButtons)[number]) => (
    <Pressable key={key} accessibilityRole="button" accessibilityLabel={name} onPress={() => onPress(key)} style={({ pressed }) => [styles.key, { backgroundColor: tone.raised }, pressed && styles.pressed]}>
      <Text style={[styles.keyText, { color: tone.text }]}>{label}</Text>
    </Pressable>
  )
  return (
    <View style={styles.keys}>
      <View style={styles.keysLine}>
        {modifierButtons.map(({ modifier, label }) => {
          const held = modifiers.includes(modifier)
          return (
            <Pressable
              key={modifier}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected: held }}
              onPress={() => onModifier(modifier)}
              style={({ pressed }) => [styles.key, { backgroundColor: held ? tone.on : tone.raised }, pressed && styles.pressed]}
            >
              <Text style={[styles.keyText, { color: held ? tone.onText : tone.text }]}>{label}</Text>
            </Pressable>
          )
        })}
        {keyButtons.slice(0, 3).map(keyButton)}
      </View>
      <View style={styles.keysLine}>{keyButtons.slice(3).map(keyButton)}</View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hiddenInput: { position: 'absolute', left: 0, top: 0, width: 1, height: 1, opacity: 0, padding: 0 },
  center: { alignItems: 'center', justifyContent: 'center' },
  muted: { color: tone.muted, fontSize: 15 },
  pressed: { opacity: 0.6 },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, height: 48 },
  title: { flex: 1, color: tone.text, fontSize: 16, fontWeight: '600' },
  control: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 },
  controlSpacer: { width: 1 },
  controlText: { fontSize: 14, fontWeight: '600' },
  banner: { marginHorizontal: 8, marginBottom: 8, borderRadius: 12, padding: 12, gap: 10, backgroundColor: tone.amberBg },
  bannerCompact: { marginHorizontal: 0, flexDirection: 'row', alignItems: 'center', padding: 8, paddingLeft: 12, backgroundColor: 'rgba(40,26,6,0.92)' },
  bannerText: { flexShrink: 1, flexGrow: 1, color: tone.amber, fontSize: 14, lineHeight: 19 },
  bannerButtons: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  bannerButton: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  note: { color: tone.muted, fontSize: 13, textAlign: 'center', paddingHorizontal: 16, paddingBottom: 8 },
  noteFloating: { alignSelf: 'center', backgroundColor: 'rgba(28,28,30,0.9)', borderRadius: 999, paddingVertical: 6, paddingBottom: 6, overflow: 'hidden' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 999, paddingVertical: 8, paddingLeft: 14, paddingRight: 8, minHeight: 40 },
  pillText: { color: tone.text, fontSize: 14, paddingRight: 6 },
  retry: { backgroundColor: tone.on, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 },
  hint: { color: tone.muted, fontSize: 13, textAlign: 'center', paddingBottom: 10 },
  bottomBar: { flexDirection: 'row', justifyContent: 'space-around', paddingTop: 6, paddingHorizontal: 8, backgroundColor: tone.bar },
  tool: { alignItems: 'center', gap: 3, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 10, minWidth: 64 },
  toolLabel: { color: tone.text, fontSize: 11 },
  iconButton: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  keys: { gap: 6, padding: 8, alignItems: 'center' },
  keysLine: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6 },
  key: { minWidth: 44, height: 38, borderRadius: 8, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  keyText: { fontSize: 15, fontWeight: '500' },
  floatingTop: { position: 'absolute', top: 10, gap: 8 },
  floatingBottom: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', gap: 6 },
  floatingBar: { flexDirection: 'row', alignItems: 'center', gap: 2, borderRadius: 999, paddingHorizontal: 6, paddingVertical: 4, opacity: 0.94 },
  tuckHandle: { alignSelf: 'flex-end', width: 32, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', opacity: 0.9 },
})
