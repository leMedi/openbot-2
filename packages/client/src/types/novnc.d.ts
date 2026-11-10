// The parts of noVNC's client (https://github.com/novnc/noVNC/blob/master/docs/API.md) the Screen connection and the apps use.
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean; wsProtocols?: string[] })
    viewOnly: boolean
    scaleViewport: boolean
    resizeSession: boolean
    clipViewport: boolean
    dragViewport: boolean
    focusOnClick: boolean
    showDotCursor: boolean
    background: string
    qualityLevel: number
    compressionLevel: number
    focus(options?: FocusOptions): void
    blur(): void
    sendKey(keysym: number, code: string | null, down?: boolean): void
    clipboardPasteFrom(text: string): void
    disconnect(): void
  }
}
