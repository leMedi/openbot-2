import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { colors, radii, text } from './tokens.ts'

// tokens.ts is the source of truth; theme.css restates it for the web. These read theme.css as CSS and fail on any drift.

const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The custom properties declared directly in the block opened by `selector {`, not in blocks nested inside it. */
function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`theme.css has no ${selector} block`)
  let depth = 0
  let body = ''
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) break
    else if (depth === 1) body += css[i]
  }
  const vars = new Map<string, string>()
  for (const [, name, value] of body.matchAll(/^\s*--([\w-]+):\s*([^;]+);/gm)) vars.set(name as string, (value as string).trim())
  return vars
}

function resolve(vars: Map<string, string>, name: string): string {
  const value = vars.get(name)
  if (value === undefined) throw new Error(`--${name} is not declared`)
  const ref = /^var\(--([\w-]+)\)$/.exec(value)
  return ref ? resolve(vars, ref[1] as string) : value
}

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
/** Not colours: shadows stay CSS-only (the phone draws none of its own), and --radius is restated as radii.lg. */
const notColors = (name: string) => name.startsWith('elevation-') || name === 'radius'

const root = block(':root')
const dark = new Map([...root, ...block('.dark')])
const theme = block('@theme inline')

describe('theme.css matches tokens.ts', () => {
  for (const [mode, vars] of [
    ['light', root],
    ['dark', dark],
  ] as const) {
    test(`${mode} colours`, () => {
      const fromCss = Object.fromEntries([...vars.keys()].filter((name) => !notColors(name)).map((name) => [name, resolve(vars, name)]))
      const fromTokens = Object.fromEntries(Object.entries(colors[mode]).map(([key, value]) => [kebab(key), value]))
      expect(fromCss).toEqual(fromTokens)
    })
  }

  test('every colour is exposed to Tailwind', () => {
    for (const key of Object.keys(colors.light)) expect(theme.get(`color-${kebab(key)}`)).toBe(`var(--${kebab(key)})`)
  })

  test('radii', () => {
    const fromCss = Object.fromEntries(
      [...theme.keys()].filter((name) => name.startsWith('radius-')).map((name) => [name.slice('radius-'.length), resolve(new Map([...root, ...theme]), name)]),
    )
    expect(fromCss).toEqual(Object.fromEntries(Object.entries(radii).map(([key, px]) => [key, `${px}px`])))
  })

  test('type sizes', () => {
    const sizes = [...theme.keys()].filter((name) => /^text-[\w]+$/.test(name)).map((name) => name.slice('text-'.length))
    const fromCss = Object.fromEntries(
      sizes.map((size) => {
        const letterSpacing = theme.get(`text-${size}--letter-spacing`)
        return [
          size,
          {
            fontSize: theme.get(`text-${size}`),
            lineHeight: theme.get(`text-${size}--line-height`),
            ...(letterSpacing !== undefined && { letterSpacing }),
          },
        ]
      }),
    )
    const fromTokens = Object.fromEntries(
      Object.entries(text).map(([size, t]) => [
        size,
        {
          fontSize: `${t.fontSize}px`,
          lineHeight: `${t.lineHeight}px`,
          ...('letterSpacing' in t && { letterSpacing: `${t.letterSpacing}px` }),
        },
      ]),
    )
    expect(fromCss).toEqual(fromTokens)
  })
})
