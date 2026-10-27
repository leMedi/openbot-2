import { access, readFile, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Program, ScreenSpec } from './screen-manager.ts'

// Grok's screen size; @openbot/core's `screenSize`.
const width = 1280
const height = 800

/** The screen's stream (x11vnc), on this machine only. */
export const streamPort = (display: number) => 5900 + display
/** The screen's browser's DevTools protocol, on this machine only; the browser tools drive it. */
export const browserDebugPort = (display: number) => 9222 + display

export const profileFolder = (home: string, botId: string) => join(home, 'bots', botId, 'chromium')

async function until(check: () => Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

export const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })

/**
 * A bot's screen: Xvfb at 1280×800, Openbox, the bot's own Chromium profile in its folder, and x11vnc serving the
 * stream on localhost.
 */
export function screenPrograms(home: string): (screen: ScreenSpec) => Program[] {
  return ({ botId, display }) => {
    const env = { DISPLAY: `:${display}`, HOME: home }
    return [
      {
        name: 'xvfb',
        command: 'Xvfb',
        args: [`:${display}`, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp'],
        ready: () => until(() => exists(`/tmp/.X11-unix/X${display}`), `display :${display}`),
      },
      { name: 'openbox', command: 'openbox', args: [], env },
      {
        name: 'chromium',
        command: 'chromium',
        args: [
          `--user-data-dir=${profileFolder(home, botId)}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--password-store=basic',
          '--disable-dev-shm-usage',
          // Chrome's own sandbox needs user namespaces, which Docker's default seccomp profile blocks; the container
          // is the boundary (ADR 0002).
          '--no-sandbox',
          '--test-type',
          // Restarted after a crash, it opens as it was, without asking to restore.
          '--hide-crash-restore-bubble',
          '--remote-debugging-address=127.0.0.1',
          `--remote-debugging-port=${browserDebugPort(display)}`,
          '--window-position=0,0',
          `--window-size=${width},${height}`,
          '--start-maximized',
          'about:blank',
        ],
        env,
        ready: () => until(() => listening(browserDebugPort(display)), 'the browser', 30_000),
      },
      {
        name: 'x11vnc',
        command: 'x11vnc',
        args: ['-display', `:${display}`, '-rfbport', String(streamPort(display)), '-localhost', '-forever', '-shared', '-nopw', '-quiet', '-xkb'],
        env,
        ready: () => until(() => listening(streamPort(display)), 'the stream'),
      },
    ]
  }
}

/** Removes the display's lock and socket, killing an Xvfb left from a daemon that died without stopping it. */
export async function clearDisplay(display: number): Promise<void> {
  const lock = `/tmp/.X${display}-lock`
  try {
    const pid = Number((await readFile(lock, 'utf8')).trim())
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGKILL')
        await until(async () => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        }, `the old display server ${pid} to exit`, 5_000)
      } catch {
        // Not ours or already gone.
      }
    }
  } catch {
    // No lock.
  }
  await rm(lock, { force: true })
  await rm(`/tmp/.X11-unix/X${display}`, { force: true })
}
