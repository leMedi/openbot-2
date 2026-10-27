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

/** The screen's desktop driver (cua-driver), on this machine only; the desktop tools drive it. */
export const desktopDriverSocket = (display: number) => `/tmp/openbot-cua-driver-${display}.sock`
/** The screen's own D-Bus session, which carries its accessibility bus (AT-SPI) for the desktop driver to read. */
const sessionBusSocket = (display: number) => `/tmp/openbot-dbus-${display}`

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

/** Runs `command` after removing `socket`, which a crashed run of it may have left behind. */
const freshSocket = (socket: string, command: string[]) => ({
  command: 'sh',
  args: ['-c', 'rm -f "$0" && exec "$@"', socket, ...command],
})

/**
 * A bot's screen: Xvfb at 1280×800, its own D-Bus session with an accessibility bus, Openbox, the bot's own Chromium
 * profile in its folder, x11vnc serving the stream on localhost, and cua-driver for the desktop tools.
 */
export function screenPrograms(home: string): (screen: ScreenSpec) => Program[] {
  return ({ botId, display }) => {
    const bus = sessionBusSocket(display)
    // Every program after the bus is in the screen's session, so apps on it (and Chromium) show up on its AT-SPI bus.
    const env = { DISPLAY: `:${display}`, HOME: home, DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}` }
    const driver = desktopDriverSocket(display)
    return [
      {
        name: 'xvfb',
        command: 'Xvfb',
        args: [`:${display}`, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp'],
        ready: () => until(() => exists(`/tmp/.X11-unix/X${display}`), `display :${display}`),
      },
      {
        name: 'dbus',
        ...freshSocket(bus, ['dbus-daemon', '--session', `--address=unix:path=${bus}`, '--nofork', '--nopidfile']),
        env,
        ready: () => until(() => exists(bus), 'the session bus'),
      },
      // Starts the accessibility bus now and publishes it on the display (AT_SPI_BUS), where apps and cua-driver find it.
      { name: 'at-spi', command: '/usr/libexec/at-spi-bus-launcher', args: ['--launch-immediately'], env },
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
      {
        // One driver per screen, as openbot like the apps it drives (it checks who connects, so the server reaches it
        // through `sudo -u openbot cua-driver mcp`). Its agent cursor shows the owner where it acts.
        name: 'cua-driver',
        ...freshSocket(driver, ['cua-driver', 'serve', '--socket', driver, '--pid-file', `/tmp/openbot-cua-driver-${display}.pid`]),
        env,
        ready: () => until(() => exists(driver), 'the desktop driver'),
      },
    ]
  }
}

/** Removes the display's lock and sockets, killing an Xvfb left from a daemon that died without stopping it. */
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
  await rm(sessionBusSocket(display), { force: true })
  await rm(desktopDriverSocket(display), { force: true })
}
