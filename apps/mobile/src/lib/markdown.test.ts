import type { Nodes } from 'mdast'
import { describe, expect, it } from 'vitest'
import { hasBlocks, parseMarkdown, renderedTypes } from './markdown.ts'

/** Everything the web's Markdown styles, as a bot might write it. */
const everything = `# Plan

## Steps

### Detail

A paragraph with **bold**, *emphasis*, ~~struck~~, \`code\`, a [link](https://example.com) and https://openbot.dev.
A soft break, then a hard one
here.

- one
- two
  1. nested
  2. ordered

- [x] done
- [ ] to do

> A quote

---

\`\`\`ts
const answer = 42
\`\`\`

| Name | Size |
| :--- | ---: |
| a.txt | 1 KB |

![chart](https://example.com/chart.png)

<b>raw html</b>

Footnote[^1] and a [reference link][r].

[r]: https://example.com/ref

[^1]: The note.
`

function types(node: Nodes, found = new Set<string>()): Set<string> {
  found.add(node.type)
  if ('children' in node) for (const child of node.children) types(child, found)
  return found
}

describe("a message's Markdown on the phone", () => {
  it('has a way to draw every node a message can hold', () => {
    const found = types(parseMarkdown(everything))
    expect([...found].filter((type) => !renderedTypes.has(type))).toEqual([])
    // GitHub's extensions are parsed, as on the web.
    expect([...found]).toEqual(expect.arrayContaining(['table', 'delete', 'link', 'footnoteReference']))
  })

  it('makes bare addresses links', () => {
    const root = parseMarkdown('See https://openbot.dev')
    expect(root.children[0]).toMatchObject({ type: 'paragraph', children: [{ type: 'text' }, { type: 'link', url: 'https://openbot.dev' }] })
  })

  it('knows task list items', () => {
    const root = parseMarkdown('- [x] done')
    expect(root.children[0]).toMatchObject({ type: 'list', children: [{ type: 'listItem', checked: true }] })
  })

  it('tells a message of lines of text from one with blocks', () => {
    expect(hasBlocks(parseMarkdown('# Hi\n\nTwo **lines**\nof text'))).toBe(false)
    expect(['- a list', '> a quote', '```\ncode\n```', '| a |\n| - |\n| b |', '---'].map((text) => hasBlocks(parseMarkdown(text)))).toEqual([true, true, true, true, true])
  })
})
