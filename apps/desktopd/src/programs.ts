import { execFile } from 'node:child_process'
import { access, readFile, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { App, Program, ScreenSpec } from './screen-manager.ts'

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
 * Whether this user may create user namespaces, which Chrome's sandbox needs in a container (its setuid helper can't
 * work without privileges Docker drops). Some hosts' Docker keeps them from containers, e.g. GitHub's Ubuntu 24.04 runners.
 */
export const userNamespacesAllowed = () => new Promise<boolean>((resolve) => execFile('unshare', ['--user', 'true'], (error) => resolve(!error)))

/** The bots' wallpaper, bundled in the image (docker/desktop/wallpaper.png): blue mountains, scaled to cover the screen. */
const wallpaper = '/usr/share/openbot/wallpaper.png'

/** What every program of the bot's screen runs in, and what it starts: its display, session bus and browser. */
function screenEnv(home: string, { botId, display }: ScreenSpec, { sandbox }: { sandbox: boolean }): Record<string, string> {
  return {
    DISPLAY: `:${display}`,
    HOME: home,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${sessionBusSocket(display)}`,
    // For openbot-browser, however Chrome is opened on the screen (docker/openbot-browser.sh).
    OPENBOT_BROWSER_PROFILE: profileFolder(home, botId),
    OPENBOT_BROWSER_SANDBOX: sandbox ? '1' : '0',
  }
}

/**
 * A bot's screen: Xvfb at 1280×800, its own D-Bus session with an accessibility bus, Openbox, the desktop (a wallpaper
 * under tint2's dock), x11vnc serving the stream on localhost, and cua-driver for the desktop tools. Its browser starts
 * when it's needed (`screenBrowser`), or when the bot opens it.
 */
export function screenPrograms(home: string, options: { sandbox: boolean }): (screen: ScreenSpec) => Program[] {
  return (screen) => {
    const { display } = screen
    const bus = sessionBusSocket(display)
    // Every program after the bus is in the screen's session, so apps on it (and Chrome) show up on its AT-SPI bus.
    const env = screenEnv(home, screen, options)
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
      // Sets the wallpaper, then shows the dock over it (docker/desktop/tint2rc), which maximized windows stay above.
      { name: 'dock', command: 'sh', args: ['-c', 'hsetroot -cover "$1" && exec tint2 -c /etc/openbot/dock.tint2rc', 'dock', wallpaper], env },
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

/**
 * The bot's Google Chrome, opened on its screen when the browser tools need it (docker/openbot-browser.sh): its own
 * profile, DevTools on 127.0.0.1:9222+N, in Chrome's sandbox unless `sandbox` is false. Already open when its DevTools
 * answer, however it was opened.
 */
export function screenBrowser(home: string, options: { sandbox: boolean }): (screen: ScreenSpec) => App {
  return (screen) => {
    const port = browserDebugPort(screen.display)
    return {
      name: 'chrome',
      command: 'openbot-browser',
      args: ['about:blank'],
      env: screenEnv(home, screen, options),
      ready: () => until(() => listening(port), 'the browser', 30_000),
      open: () => listening(port),
    }
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
