import type { ReactNode } from 'react'
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
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
})

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
