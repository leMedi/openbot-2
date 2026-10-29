import { type Attachment, type Db, type Message, messages } from '@openbot/db'
import { desc, getTableColumns, sql } from 'drizzle-orm'

/** The most hits of each kind one search returns. */
export const maxSearchHits = 50

/** Part of a hit's text, matched by the query or not. */
export type SnippetPart = { text: string; match: boolean }

export type MessageMatch = { message: Message; snippet: SnippetPart[] }

export type FileMatch = { message: Message; attachment: Attachment }

/** Marks FTS5's snippet puts around matched words; neither appears in text people type. */
const matchStart = '\u0002'
const matchEnd = '\u0003'

/** The words of `query`, as the index splits text into words; quotes, operators and stars are no part of them. */
function words(query: string): string[] {
  return query.match(/[\p{L}\p{N}_]+/gu) ?? []
}

function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = []
  for (const [index, piece] of snippet.split(matchStart).entries()) {
    const [matched, rest] = index === 0 ? [undefined, piece] : piece.split(matchEnd, 2)
    if (matched) parts.push({ text: matched, match: true })
    if (rest) parts.push({ text: rest, match: false })
  }
  return parts
}

/**
 * Messages in every chat whose text has a word starting with each word of `query`, newest first, each with a snippet
 * of its text around the matches.
 */
export async function searchMessages(db: Db, query: string): Promise<MessageMatch[]> {
  const terms = words(query)
  if (!terms.length) return []
  // Each word quoted, so FTS5 reads none as an operator, and starred, to match by prefix; every one must match.
  const match = terms.map((word) => `"${word}"*`).join(' ')
  const rows = await db
    .select({
      message: getTableColumns(messages),
      snippet: sql<string>`snippet(messages_fts, 0, ${matchStart}, ${matchEnd}, '…', 24)`,
    })
    .from(sql`messages_fts`)
    .innerJoin(messages, sql`${messages}.rowid = messages_fts.rowid`)
    .where(sql`messages_fts match ${match}`)
    .orderBy(desc(messages.id))
    .limit(maxSearchHits)
  return rows.map((row) => ({ message: row.message, snippet: snippetParts(row.snippet) }))
}

/** Files posted in every chat whose name has each word of `query` in it, newest first. */
export async function searchFiles(db: Db, query: string): Promise<FileMatch[]> {
  const terms = words(query)
  if (!terms.length) return []
  const name = sql`json_extract(file.value, '$.name')`
  const nameHasEvery = sql.join(
    terms.map((word) => sql`instr(lower(${name}), lower(${word})) > 0`),
    sql` and `,
  )
  const rows = await db
    .select({ message: getTableColumns(messages), attachment: sql<string>`file.value` })
    .from(messages)
    .innerJoin(sql`json_each(${messages.attachments}) as file`, sql`true`)
    .where(nameHasEvery)
    .orderBy(desc(messages.id))
    .limit(maxSearchHits)
  return rows.map((row) => ({ message: row.message, attachment: JSON.parse(row.attachment) as Attachment }))
}
