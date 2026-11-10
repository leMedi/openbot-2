'use dom'

import { type Modifier, pressKey, type ScreenQuality, type ScreenStatus, type ScreenViewport, type SpecialKey, typeChange, useScreenConnection } from '@openbot/client/screen'
import { type DOMImperativeFactory, type DOMProps, useDOMImperativeHandle } from 'expo/dom'
import { type Ref, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** What the app does on the Screen: its toolbar's keys, Paste and what the phone's keyboard typed. */
export type ScreenViewRef = {
  retry: () => void
  press: (key: SpecialKey, modifiers: Modifier[]) => void
  /** Takes `backspaces` characters off, then types `text`, `modifiers` held around the first key. */
  type: (backspaces: number, text: string, modifiers: Modifier[]) => void
}

export type ScreenViewProps = {
  ref: Ref<ScreenViewRef>
  botId: string
  /** The instance's address, the ticket's path being on it (this page is the app's, not the instance's). */
  server: string
  interactive: boolean
  quality: ScreenQuality
  viewport: ScreenViewport
  /** A ticket to the bot's Screen, from the app's API client. */
  ticket: (input: { botId: string }) => Promise<{ url: string }>
  onStatus: (status: ScreenStatus) => Promise<void>
  dom?: DOMProps
}

/**
 * A bot's Screen on the phone (spec: Screen and take-over): noVNC in a web view, with its own touch gestures (a tap
 * clicks, two fingers scroll, a long press right-clicks), connected by the same hook as the web's. The app draws the
 * status, the toolbar and the card around it, and holds the hidden input the phone's keyboard types into.
 */
export default function ScreenView(props: ScreenViewProps) {
  const { ref, botId, server, interactive, quality, viewport } = props
  const target = useRef<HTMLDivElement>(null)
  // The ticket is a native action, a new function each render: the connection takes the latest.
  const latest = useRef(props)
  useLayoutEffect(() => {
    latest.current = props
  })
  const [api] = useState(() => ({ screens: { ticket: (input: { botId: string }) => latest.current.ticket(input) } }))
  const { status, retry, rfb } = useScreenConnection(target, { api, botId, interactive, quality, viewport, server })

  useEffect(() => {
    void latest.current.onStatus(status)
  }, [status])

  // The page is the Screen alone: no page zoom, scroll or bounce under noVNC's gestures.
  useEffect(() => {
    const meta = document.querySelector('meta[name=viewport]') ?? document.head.appendChild(document.createElement('meta'))
    meta.setAttribute('name', 'viewport')
    meta.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    Object.assign(document.documentElement.style, { height: '100%', overflow: 'hidden', background: 'transparent' })
    Object.assign(document.body.style, { margin: '0', height: '100%', overflow: 'hidden', position: 'fixed', inset: '0', background: 'transparent', touchAction: 'none' })
  }, [])

  const rfbRef = useRef(rfb)
  useLayoutEffect(() => {
    rfbRef.current = rfb
  })
  // Expo types the handle's arguments as any JSON; these are the app's own, typed by ScreenViewRef.
  useDOMImperativeHandle(
    ref as Ref<DOMImperativeFactory>,
    () => {
      const handle: ScreenViewRef = {
        retry,
        press: (key, modifiers) => {
          if (rfbRef.current) pressKey(rfbRef.current, key, modifiers)
        },
        type: (backspaces, text, modifiers) => {
          if (rfbRef.current) typeChange(rfbRef.current, { backspaces, text }, modifiers)
        },
      }
      return handle as unknown as DOMImperativeFactory
    },
    [retry],
  )

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
      <div ref={target} style={{ position: 'absolute', inset: 0, visibility: status === 'connected' ? 'visible' : 'hidden' }} />
    </div>
  )
}
