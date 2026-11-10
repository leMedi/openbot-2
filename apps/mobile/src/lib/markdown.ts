import type { Root } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const processor = unified().use(remarkParse).use(remarkGfm).freeze()

/** A message's Markdown as a syntax tree, with GitHub's extensions (tables, task lists, strikethrough, autolinks), as the web parses it. */
export function parseMarkdown(text: string): Root {
  return processor.parse(text)
}

/**
 * The nodes the phone's renderer draws. Raw HTML is among them, drawn as nothing, as the web drops it, and so are
 * link definitions, which their references use; a footnote's reference and definition are drawn as plain text.
 */
export const renderedTypes: ReadonlySet<string> = new Set([
  'root',
  'paragraph',
  'heading',
  'text',
  'strong',
  'emphasis',
  'delete',
  'inlineCode',
  'code',
  'link',
  'linkReference',
  'imageReference',
  'definition',
  'list',
  'listItem',
  'blockquote',
  'thematicBreak',
  'break',
  'table',
  'tableRow',
  'tableCell',
  'image',
  'html',
  'footnoteReference',
  'footnoteDefinition',
])

/**
 * Whether a message holds more than lines of text (a list, quote, code, a table or a rule): its bubble then takes the
 * transcript's full width, as React Native measures nested text against a width it doesn't keep when the bubble
 * shrinks to fit, leaving lists too short or too tall.
 */
export function hasBlocks(root: Root): boolean {
  return root.children.some((node) => !['paragraph', 'heading', 'html', 'definition'].includes(node.type))
}
