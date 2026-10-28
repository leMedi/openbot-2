// What the screen daemon (`apps/desktopd`, running as `openbot`) and its client say to each other: JSON over HTTP on a
// Unix socket, so screens outlive the server.
//
//   GET    /screens            every screen being kept running: ScreenListing[]
//   GET    /screens/:botId     one screen's ScreenStatus (stopped when there is none)
//   PUT    /screens/:botId     { display } → starts it, or keeps it running there: ScreenStatus
//   DELETE /screens/:botId     stops it and deletes its browser profile
//   GET    /screens/:botId/pids  its processes' ids by program, for diagnostics and tests
//   GET    /health             Health: its bootId changes each time the daemon starts
//
// Errors answer { error } with a 4xx or 5xx status.

/** Where the daemon listens unless `OPENBOT_DESKTOPD_SOCKET` says otherwise. */
export const defaultDaemonSocket = '/run/openbot/desktopd.sock'

/** Bot ids name folders, so only these characters are accepted. */
export const botIdPattern = /^[A-Za-z0-9_-]{1,128}$/

export type StartScreenRequest = { display: number }

/** `bootId` is new each time the daemon starts, so a client can tell it restarted (and lost what it kept in memory). */
export type Health = { ok: true; bootId: string }

export type DaemonError = { error: string }
