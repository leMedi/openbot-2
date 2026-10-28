import { type ReactNode, useEffect } from 'react'
import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import { api } from '../lib/api.ts'
import styles from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'OpenBot' },
    ],
    links: [{ rel: 'stylesheet', href: styles }],
  }),
  shellComponent: RootDocument,
  component: Root,
})

/**
 * Every page. Each load offers the browser's time zone, so the first visit sets the owner's; the server keeps one
 * already set, so later loads change nothing.
 */
function Root() {
  useEffect(() => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    // Best effort: a zone the server doesn't know is left for the owner to choose in Settings → General.
    if (timeZone) api().general.detectTimeZone({ timeZone }).catch(() => {})
  }, [])
  return <Outlet />
}

/**
 * Follows the system theme before first paint, so dark mode never flashes light. A later switch crossfades through a
 * view transition, unless motion is reduced.
 */
const followSystemTheme = `(() => {
  const dark = matchMedia('(prefers-color-scheme: dark)')
  const apply = () => document.documentElement.classList.toggle('dark', dark.matches)
  apply()
  dark.addEventListener('change', () => {
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(apply)
    else apply()
  })
})()`

function RootDocument({ children }: { children: ReactNode }) {
  return (
    // The theme script sets a class React didn't render.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: followSystemTheme }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
