// The real computer's parts outside pi: the screen daemon's client, each bot's browser over CDP, and its desktop through
// its screen's cua-driver.
export { connectScreens, ScreenDaemonError } from './screens-client.ts'
export { botIdPattern, type DaemonError, defaultDaemonSocket, type Health, type StartScreenRequest } from './protocol.ts'
export { browserDebugPort, connectBrowser } from './browser.ts'
export { connectDesktop, desktopDriverSocket, type DesktopOptions } from './desktop.ts'
