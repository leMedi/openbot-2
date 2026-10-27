import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One element of a test page; a link, or a button with `href`, goes there when clicked. */
export type PageElement =
  | { role: 'heading' | 'text'; name: string }
  | { role: 'link'; name: string; href: string }
  | { role: 'button'; name: string; href?: string }
  | { role: 'textbox'; name: string }

/** A web page for tests, which the fake browser shows as is and a real browser loads as HTML. */
export type TestPage = { title: string; elements: PageElement[] }

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

/** `page` as HTML a real browser shows with the same accessibility tree as the fake's. */
export function renderPage({ title, elements }: TestPage): string {
  const body = elements.map((element) => {
    const name = escape(element.name)
    switch (element.role) {
      case 'heading':
        return `<h1>${name}</h1>`
      case 'text':
        return `<p>${name}</p>`
      case 'link':
        return `<p><a href="${escape(element.href)}">${name}</a></p>`
      case 'button':
        return `<p><button${element.href ? ` onclick="location.href=${escape(JSON.stringify(element.href))}"` : ''}>${name}</button></p>`
      case 'textbox':
        return `<p><input type="text" aria-label="${name}"></p>`
    }
  })
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title></head><body>${body.join('')}</body></html>`
}

/** Serves test pages over HTTP on 127.0.0.1, for a real browser on this machine. */
export async function servePages() {
  const pages = new Map<string, TestPage>()
  const server = createServer((req, res) => {
    const page = pages.get(new URL(req.url ?? '/', 'http://pages.test').pathname.slice(1))
    if (!page) return res.writeHead(404).end()
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(renderPage(page))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    /** Serves `page` at `/<name>`; returns its URL. */
    page(name: string, page: TestPage): string {
      pages.set(name, page)
      return `${origin}/${name}`
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
