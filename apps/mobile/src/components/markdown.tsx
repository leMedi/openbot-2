import type { Definition, ListItem, Nodes, PhrasingContent, Root, RootContent, Table } from 'mdast'
import { type ReactNode, useMemo } from 'react'
import { Linking, Platform, ScrollView, StyleSheet, Text, type TextStyle, useColorScheme, View } from 'react-native'
import { useInstance } from '../lib/instance-context.ts'
import { parseMarkdown } from '../lib/markdown.ts'
import { useColors } from '../lib/theme.ts'

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' })

/** The message text's size, which the transcript's bubbles share. */
export const messageText = { fontSize: 16, lineHeight: 22 } as const

type Context = {
  color: string
  muted: string
  border: string
  /** Code's background: dark on light bubbles, light on the owner's dark ones (the web's --code-tint). */
  tint: string
  link: (url: string) => void
  definitions: Map<string, Definition>
}


/** The plain text of a node, for a table column's width and a footnote. */
function plain(node: Nodes): string {
  if ('value' in node && typeof node.value === 'string') return node.value
  if ('children' in node) return node.children.map(plain).join('')
  return ''
}

function inline(node: PhrasingContent, context: Context, key: number): ReactNode {
  const children = () => ('children' in node ? node.children.map((child, index) => inline(child, context, index)) : null)
  switch (node.type) {
    case 'text':
      return node.value
    case 'strong':
      return (
        <Text key={key} style={styles.strong}>
          {children()}
        </Text>
      )
    case 'emphasis':
      return (
        <Text key={key} style={styles.emphasis}>
          {children()}
        </Text>
      )
    case 'delete':
      return (
        <Text key={key} style={styles.delete}>
          {children()}
        </Text>
      )
    case 'inlineCode':
      return (
        <Text key={key} style={[styles.inlineCode, { backgroundColor: context.tint }]}>
          {node.value}
        </Text>
      )
    case 'break':
      return '\n'
    case 'link':
      return (
        <Text key={key} accessibilityRole="link" style={styles.link} onPress={() => context.link(node.url)}>
          {children()}
        </Text>
      )
    case 'linkReference': {
      const definition = context.definitions.get(node.identifier)
      if (!definition) return <Text key={key}>{children()}</Text>
      return (
        <Text key={key} accessibilityRole="link" style={styles.link} onPress={() => context.link(definition.url)}>
          {children()}
        </Text>
      )
    }
    case 'image':
    case 'imageReference': {
      // Shown as a link to the picture: the phone doesn't load pictures from elsewhere into a message.
      const url = node.type === 'image' ? node.url : context.definitions.get(node.identifier)?.url
      const label = `🖼 ${node.alt || 'Image'}`
      if (!url) return label
      return (
        <Text key={key} accessibilityRole="link" style={styles.link} onPress={() => context.link(url)}>
          {label}
        </Text>
      )
    }
    case 'footnoteReference':
      return `[${node.label ?? node.identifier}]`
    case 'html':
      // Dropped, as on the web.
      return null
    default:
      return null
  }
}

function block(node: RootContent, context: Context, key: number): ReactNode {
  const text = (style?: TextStyle | TextStyle[]) =>
    'children' in node ? (
      <Text key={key} style={[messageText, { color: context.color }, style]}>
        {(node.children as PhrasingContent[]).map((child, index) => inline(child, context, index))}
      </Text>
    ) : null
  switch (node.type) {
    case 'paragraph':
      return text()
    case 'heading':
      return text(node.depth <= 2 ? [styles.strong, styles.headingLarge] : styles.strong)
    case 'blockquote':
      return (
        <View key={key} style={[styles.quote, { borderLeftColor: context.border }]}>
          {blocks(node.children, { ...context, color: context.muted })}
        </View>
      )
    case 'list':
      return (
        <View key={key} style={styles.list}>
          {node.children.map((item, index) => (
            <ListRow key={index} item={item} marker={node.ordered ? `${(node.start ?? 1) + index}.` : '•'} context={context} />
          ))}
        </View>
      )
    case 'thematicBreak':
      return <View key={key} style={[styles.rule, { backgroundColor: context.border }]} />
    case 'code':
      return (
        <ScrollView key={key} horizontal style={[styles.codeBlock, { backgroundColor: context.tint }]} contentContainerStyle={styles.codeContent}>
          <Text selectable style={[styles.code, { color: context.color }]}>
            {node.value}
          </Text>
        </ScrollView>
      )
    case 'table':
      return <TableBlock key={key} table={node} context={context} />
    case 'footnoteDefinition':
      return (
        <Text key={key} style={[styles.footnote, { color: context.muted }]}>
          [{node.label ?? node.identifier}] {node.children.map(plain).join(' ')}
        </Text>
      )
    case 'html':
    case 'definition':
      return null
    default:
      return null
  }
}

function blocks(nodes: RootContent[], context: Context): ReactNode[] {
  return nodes.map((node, index) => block(node, context, index)).filter((element) => element !== null)
}

function ListRow({ item, marker, context }: { item: ListItem; marker: string; context: Context }) {
  const shown = item.checked === true ? '☑' : item.checked === false ? '☐' : marker
  return (
    <View style={styles.listRow}>
      <Text style={[messageText, styles.marker, { color: context.color }]}>{shown}</Text>
      <View style={styles.listBody}>{blocks(item.children, context)}</View>
    </View>
  )
}

/** A table in a sideways scroller, each column as wide as its longest cell needs (within bounds). */
function TableBlock({ table, context }: { table: Table; context: Context }) {
  const columns = Math.max(...table.children.map((row) => row.children.length))
  const widths = Array.from({ length: columns }, (_, column) => {
    const longest = Math.max(...table.children.map((row) => (row.children[column] ? plain(row.children[column]) : '').length))
    return Math.min(240, Math.max(56, longest * 8 + 18))
  })
  return (
    <ScrollView horizontal style={styles.table} contentContainerStyle={styles.tableContent}>
      <View style={[styles.tableBox, { borderColor: context.border }]}>
        {table.children.map((row, rowIndex) => (
          <View key={rowIndex} style={[styles.tableRow, rowIndex > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: context.border }]}>
            {widths.map((width, column) => {
              const cell = row.children[column]
              const align = table.align?.[column]
              return (
                <View
                  key={column}
                  style={[styles.cell, { width }, column > 0 && { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: context.border }]}
                >
                  <Text style={[styles.cellText, { color: context.color, textAlign: align ?? 'left' }, rowIndex === 0 && styles.strong]}>
                    {cell?.children.map((child, index) => inline(child, context, index))}
                  </Text>
                </View>
              )
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

/**
 * A message's Markdown, drawn natively from the syntax tree remark and remark-gfm make (the web's parser): paragraphs,
 * headings, emphasis, strikethrough, code, lists and task lists, quotes, rules, tables and links, which open in the
 * browser. `onColor` is for text on the owner's dark bubbles. Takes the text, or its tree when the caller parsed it already.
 */
export function Markdown({ onColor = false, muted = false, ...source }: ({ text: string } | { root: Root }) & { onColor?: boolean; muted?: boolean }) {
  const colors = useColors()
  const { url } = useInstance()
  const text = 'text' in source ? source.text : undefined
  const parsed = useMemo(() => (text === undefined ? undefined : parseMarkdown(text)), [text])
  const root = 'root' in source ? source.root : parsed!
  const dark = useColorScheme() === 'dark'
  const color = onColor ? colors.onColor : muted ? colors.mutedForeground : colors.foreground
  const context: Context = {
    color,
    muted: onColor ? colors.onColor : colors.mutedForeground,
    border: onColor ? '#ffffff40' : colors.borderStrong,
    tint: onColor ? '#ffffff26' : dark ? '#ffffff1a' : '#0000000f',
    // A relative link (a bot pointing at /settings/…) is on the instance.
    link: (href) => void Linking.openURL(new URL(href, url).href).catch(() => {}),
    definitions: new Map(root.children.filter((node): node is Definition => node.type === 'definition').map((node) => [node.identifier, node])),
  }
  return <View style={styles.root}>{blocks(root.children, context)}</View>
}

const styles = StyleSheet.create({
  root: { gap: 6 },
  strong: { fontWeight: '600' },
  emphasis: { fontStyle: 'italic' },
  delete: { textDecorationLine: 'line-through' },
  headingLarge: { fontSize: 18, lineHeight: 24 },
  inlineCode: { fontFamily: mono, fontSize: 14 },
  link: { textDecorationLine: 'underline' },
  quote: { borderLeftWidth: 2, paddingLeft: 10, gap: 6 },
  list: { gap: 2 },
  listRow: { flexDirection: 'row', gap: 6 },
  marker: { minWidth: 14, textAlign: 'right', fontVariant: ['tabular-nums'] },
  listBody: { flexShrink: 1, gap: 4 },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
  codeBlock: { borderRadius: 8, flexGrow: 0 },
  codeContent: { padding: 10 },
  code: { fontFamily: mono, fontSize: 13, lineHeight: 19 },
  table: { flexGrow: 0 },
  // Room for the box's border, which the scroller would clip.
  tableContent: { paddingBottom: 1, paddingRight: 1 },
  tableBox: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, overflow: 'hidden' },
  tableRow: { flexDirection: 'row' },
  cell: { paddingHorizontal: 8, paddingVertical: 5 },
  cellText: { fontSize: 14, lineHeight: 19 },
  footnote: { fontSize: 13, lineHeight: 18 },
})
