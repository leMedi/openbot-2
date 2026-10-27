// The screen daemon (design §2.1): keeps every bot's screen running, as `openbot`, and answers the server on a Unix
// socket, so screens survive server restarts. Run by supervisord; `node src/main.ts`.
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { serve } from './http.ts'
import { clearDisplay, profileFolder, screenPrograms, streamPort, userNamespacesAllowed } from './programs.ts'
import { ScreenManager } from './screen-manager.ts'

const home = resolve(process.env.OPENBOT_HOME || homedir())
const socketPath = process.env.OPENBOT_DESKTOPD_SOCKET || '/run/openbot/desktopd.sock'
const log = (message: string) => console.log(`[desktopd] ${message}`)

const sandbox = await userNamespacesAllowed()
if (!sandbox) log("this host doesn't allow user namespaces: bots' browsers run without Chromium's sandbox")

const manager = new ScreenManager({
  programs: screenPrograms(home, { sandbox }),
  streamPort,
  profile: (botId) => profileFolder(home, botId),
  cleanup: clearDisplay,
  stateFile: join(home, '.openbot', 'screens.json'),
  log,
})

const server = await serve(manager, socketPath)
log(`listening on ${socketPath}`)
await manager.restore()

let stopping = false
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    if (stopping) return
    stopping = true
    log(`${signal}: stopping every screen`)
    server.close()
    await manager.shutdown()
    process.exit(0)
  })
}
