// The parts of noVNC's client (https://github.com/novnc/noVNC/blob/master/docs/API.md) the Screen pane uses.
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean; wsProtocols?: string[] })
    viewOnly: boolean
    scaleViewport: boolean
    resizeSession: boolean
    clipViewport: boolean
    focusOnClick: boolean
    showDotCursor: boolean
    background: string
    focus(options?: FocusOptions): void
    blur(): void
    disconnect(): void
  }
}
