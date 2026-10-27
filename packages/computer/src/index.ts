// The real computer's parts outside pi: the screen daemon's client, and each bot's browser over CDP.
export { connectScreens, ScreenDaemonError } from './screens-client.ts'
export { botIdPattern, type DaemonError, defaultDaemonSocket, type StartScreenRequest } from './protocol.ts'
export { browserDebugPort, connectBrowser } from './browser.ts'
