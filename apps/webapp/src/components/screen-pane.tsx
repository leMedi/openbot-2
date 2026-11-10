import type { BotInfo, MessageInfo } from '@openbot/api-contract'
import { type Rfb, useScreenConnection } from '@openbot/client/screen'
import { cn } from '@openbot/ui/lib/utils'
import { useEffect, useRef } from 'react'
import { api } from '../lib/api.ts'
import { useHandBack } from './take-over-card.tsx'

// Every screen is 1280×800 (`screenSize` on the server).
const aspect = '1280 / 800'

/**
 * A bot's screen beside its DM, like Grok's computer preview: live and view-only, with **⤢ Open** to take it fullscreen,
 * where the owner controls it. While a take-over card waits, its instruction sits above the screen with **Skip this
 * step** and **I'm done, continue**. `takeOver` is that card's message.
 */
export function ScreenPane({ bot, takeOver, onOpen }: { bot: BotInfo; takeOver?: MessageInfo; onOpen: () => void }) {
  return (
    <section aria-label={`${bot.name}'s screen`} className="flex flex-col gap-3 p-5">
      {takeOver?.card?.type === 'take_over' && <AttentionCard key={takeOver.id} message={takeOver} instruction={takeOver.card.instruction} botName={bot.name} />}
      <div className="group relative">
        <ScreenView key={bot.id} bot={bot} className="rounded-md" />
        <button
          type="button"
          onClick={onOpen}
          className="absolute inset-0 grid place-items-center rounded-md bg-black/45 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <span className="rounded-full bg-white px-3 py-1 text-sm font-medium text-black">⤢ Open</span>
        </button>
      </div>
      <p className="text-xs text-muted-foreground">{bot.name}'s screen</p>
    </section>
  )
}

/** A waiting take-over card at the top of the pane, as Grok's attention card. */
function AttentionCard({ message, instruction, botName }: { message: MessageInfo; instruction: string; botName: string }) {
  // The card's message updates live once handed back, which takes this away.
  const { sending, error, handBack } = useHandBack(message.id, () => {})
  return (
    <section aria-label="Needs your attention" className="flex flex-col gap-2 rounded-[14px] bg-amber/10 p-2.5 ring-1 ring-amber/20 ring-inset">
      <p className="text-sm font-medium text-amber-foreground">Needs your attention</p>
      <p className="text-sm [overflow-wrap:anywhere]">{instruction.trim() || `${botName} needs you`}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!!sending}
          onClick={() => void handBack('skipped')}
          className="pressable rounded-md bg-secondary px-2.5 py-1 text-sm font-medium hover:bg-secondary-hover disabled:opacity-60"
        >
          Skip this step
        </button>
        <button
          type="button"
          disabled={!!sending}
          onClick={() => void handBack('done')}
          className="pressable rounded-md bg-primary px-2.5 py-1 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
        >
          I'm done, continue
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      )}
    </section>
  )
}

/**
 * The screen over the whole window, dark in both themes, like Grok's take-control view: the owner controls it at once.
 * While a take-over card waits, a banner above the screen offers **Skip this step** and **I'm done, continue**; either
 * hands the screen back and leaves fullscreen. Leaving hands nothing back.
 */
export function FullscreenScreen({ bot, takeOver, onClose }: { bot: BotInfo; takeOver?: MessageInfo; onClose: () => void }) {
  function handBack(outcome: 'done' | 'skipped') {
    // As in Grok: sent, and fullscreen closes without waiting; the card shows how it went.
    if (takeOver) api().chats.handBack({ messageId: takeOver.id, outcome }).catch((error) => console.error("[screen] Couldn't hand back:", error))
    onClose()
  }

  return (
    <div role="dialog" aria-label={`${bot.name}'s screen`} className="fixed inset-0 z-40 flex flex-col bg-[#141414f2] text-white">
      <div className="flex h-11 shrink-0 items-center gap-3 bg-black/55 px-4">
        <span className="text-sm font-semibold">{bot.name}'s screen</span>
        <button type="button" onClick={onClose} aria-label="Exit fullscreen" className="ml-auto rounded-md px-2 py-1 text-lg hover:bg-white/10">
          ✕
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        {takeOver?.card?.type === 'take_over' && (
          <div role="status" className="flex shrink-0 items-center gap-3 rounded-[10px] bg-[#f9850021] py-2.5 pr-2.5 pl-3 text-sm text-[#ffbd3b]">
            <p className="line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere]">{takeOver.card.instruction}</p>
            <button
              type="button"
              onClick={() => handBack('skipped')}
              className="pressable shrink-0 rounded-md bg-white/10 px-2.5 py-1 font-medium text-white hover:bg-white/15"
            >
              Skip this step
            </button>
            <button
              type="button"
              onClick={() => handBack('done')}
              className="pressable shrink-0 rounded-md bg-[#fdfdfd] px-2.5 py-1 font-medium text-black hover:bg-white"
            >
              I'm done, continue
            </button>
          </div>
        )}
        <div className="grid min-h-0 flex-1 place-items-center [container-type:size]">
          <div style={{ width: 'min(100cqw, 100cqh * 1280 / 800)' }}>
            <ScreenView bot={bot} interactive className="rounded-md" dark />
          </div>
        </div>
      </div>
    </div>
  )
}

// X keysyms sent to the screen for a copy, cut or paste.
const XK_Control_L = 0xffe3
const XK_Alt_L = 0xffe9
const XK_Super_L = 0xffeb
const keys = { c: { keysym: 0x63, code: 'KeyC' }, x: { keysym: 0x78, code: 'KeyX' }, v: { keysym: 0x76, code: 'KeyV' } }

/** The modifiers the owner held for a shortcut. */
type Held = { meta: boolean; ctrl: boolean }

/** Ctrl+`key` on the screen, for the owner's Ctrl or ⌘ + `key`. */
function pressCtrl(rfb: Rfb, key: keyof typeof keys, held?: Held) {
  // ⌘ reaches the screen as Alt (left) or Super (right), so let it go: ⌘+Ctrl+V pastes nothing.
  if (held?.meta) {
    rfb.sendKey(XK_Alt_L, 'AltLeft', false)
    rfb.sendKey(XK_Super_L, 'MetaRight', false)
  }
  rfb.sendKey(XK_Control_L, 'ControlLeft', true)
  rfb.sendKey(keys[key].keysym, keys[key].code)
  // A held Ctrl is let go when the owner lets go of it.
  if (!held?.ctrl) rfb.sendKey(XK_Control_L, 'ControlLeft', false)
}

/** The shortcut's letter, for Ctrl or ⌘ without Alt. */
function shortcut(event: KeyboardEvent): string | undefined {
  if (event.altKey || !(event.ctrlKey || event.metaKey)) return
  return event.key.toLowerCase()
}

/** How long a copy waits for the screen's clipboard to change before taking what it already holds. */
const copyWaitMs = 500

/**
 * The clipboard between the owner's computer and the screen, while the owner controls it.
 *
 * Paste: Ctrl+V (⌘V on a Mac), or the browser's own Paste, puts the text in the screen's clipboard (x11vnc sets its
 * CLIPBOARD and PRIMARY) and presses Ctrl+V there. noVNC never sees the V, so the browser fires its `paste` event,
 * which reads the clipboard without asking; where it doesn't fire (Safari, on a canvas), the Clipboard API asks.
 *
 * Copy: Ctrl+C or Ctrl+X (⌘C, ⌘X) presses Ctrl+C or Ctrl+X on the screen, and its clipboard, which x11vnc sends when
 * it changes, is written to the owner's. The write starts during the key press, as Safari requires, with a promise of
 * the text: the clipboard that arrives next or, for ⌘, the one the screen already had if none does (the same text
 * copied again). Ctrl+C still reaches the screen as Ctrl+C, for a terminal.
 *
 * Text only, and the RFB clipboard is Latin-1: other characters arrive as ?.
 */
function forwardClipboard(screen: HTMLElement, rfb: Rfb): () => void {
  // The screen's clipboard as last sent, and whoever waits for its next one.
  let screenText: string | undefined
  let nextText: ((text: string) => void) | undefined
  // The modifier the owner holds for a paste, until the browser's paste arrives.
  let pending: (Held & { fallback: ReturnType<typeof setTimeout> }) | undefined

  function paste(text: string, held?: Held) {
    rfb.clipboardPasteFrom(text)
    // Pasted here, so it's the screen's clipboard now; x11vnc doesn't send back what it got.
    screenText = text
    pressCtrl(rfb, 'v', held)
  }

  function copy(event: KeyboardEvent, key: 'c' | 'x') {
    const held = { meta: event.metaKey, ctrl: event.ctrlKey }
    // On a Mac ⌘ isn't Ctrl on the screen, so press it ourselves; Ctrl goes through noVNC as typed.
    if (held.meta && !held.ctrl) {
      event.stopPropagation()
      event.preventDefault()
    }
    const text = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        nextText = undefined
        // ⌘C copies; Ctrl+C may have been a terminal's interrupt, which mustn't put the old clipboard on the owner's.
        if (screenText && held.meta) resolve(screenText)
        else reject(new Error('Nothing was copied on the screen'))
      }, copyWaitMs)
      nextText = (copied) => {
        clearTimeout(timer)
        resolve(copied)
      }
    })
    if (held.meta && !held.ctrl) pressCtrl(rfb, key, held)
    writeClipboard(text).catch((error) => console.warn("[screen] Couldn't copy to the clipboard:", error))
  }

  function onKeyDown(event: KeyboardEvent) {
    const key = shortcut(event)
    if (key === 'c' || key === 'x') return copy(event, key)
    if (key !== 'v') return
    // Keeps the V from noVNC, which would cancel the browser's paste, and lets the browser paste.
    event.stopPropagation()
    clearTimeout(pending?.fallback)
    const held = { meta: event.metaKey, ctrl: event.ctrlKey }
    pending = {
      ...held,
      fallback: setTimeout(() => {
        pending = undefined
        navigator.clipboard
          ?.readText()
          .then((text) => paste(text, held))
          .catch((error) => console.warn("[screen] Couldn't read the clipboard:", error))
      }, 150),
    }
  }

  function onPaste(event: ClipboardEvent) {
    event.preventDefault()
    const held = pending
    clearTimeout(held?.fallback)
    pending = undefined
    const text = event.clipboardData?.getData('text/plain')
    if (text) paste(text, held)
  }

  function onScreenClipboard(event: Event) {
    const text = (event as CustomEvent<{ text: string }>).detail.text
    screenText = text
    nextText?.(text)
    nextText = undefined
  }

  screen.addEventListener('keydown', onKeyDown, true)
  screen.addEventListener('paste', onPaste)
  rfb.addEventListener('clipboard', onScreenClipboard)
  return () => {
    clearTimeout(pending?.fallback)
    screen.removeEventListener('keydown', onKeyDown, true)
    screen.removeEventListener('paste', onPaste)
    rfb.removeEventListener('clipboard', onScreenClipboard)
  }
}

/**
 * Writes text that's still coming to the clipboard. A ClipboardItem takes the promise during the key press, which
 * Safari needs; where there's none, the text is written once it comes.
 */
async function writeClipboard(text: Promise<string>) {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    const blob = text.then((value) => new Blob([value], { type: 'text/plain' }))
    return navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })])
  }
  return navigator.clipboard.writeText(await text)
}

/** The live screen, reconnecting when it drops (see `useScreenConnection`). */
function ScreenView({ bot, interactive = false, className, dark }: { bot: BotInfo; interactive?: boolean; className?: string; dark?: boolean }) {
  const target = useRef<HTMLDivElement>(null)
  const { status, retry, rfb } = useScreenConnection(target, { api: api(), botId: bot.id, interactive })
  useEffect(() => (interactive && rfb && target.current ? forwardClipboard(target.current, rfb) : undefined), [interactive, rfb])
  const state = status === 'reconnecting' ? 'connecting' : status

  return (
    <div
      style={{ aspectRatio: aspect }}
      className={cn('relative overflow-hidden', dark ? 'bg-white/5' : 'bg-secondary', className)}
    >
      <div ref={target} data-testid="screen" className={cn('absolute inset-0', state !== 'connected' && 'invisible')} />
      {state !== 'connected' && (
        <div className={cn('absolute inset-0 grid place-items-center p-4 text-center text-sm', dark ? 'text-white/70' : 'text-muted-foreground')}>
          {state === 'unreachable' ? (
            <div className="flex flex-col items-center gap-2">
              <span>Can't reach {bot.name}'s screen</span>
              <button
                type="button"
                onClick={retry}
                className="rounded-full bg-secondary px-3 py-1 text-sm text-foreground hover:bg-secondary-hover"
              >
                Retry
              </button>
            </div>
          ) : (
            <span className="flex items-center gap-2">
              <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              {state === 'starting' ? 'Booting up the computer' : `Connecting to ${bot.name}'s screen…`}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
