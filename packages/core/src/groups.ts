import { type Chat, type Db, type Message, bots, chats, messages } from '@openbot/db'
import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { ChatNotFoundError } from './chats.ts'
import { groupRoundRules } from './group-rules.ts'

/** Members a group chat can't have: unknown bots, too few or too many. */
export class GroupMembersError extends Error {}

/** A group chat's name: the owner's title, or its members' names until they rename it. */
export function groupName(title: string | null, memberNames: readonly string[]): string {
  if (title?.trim()) return title.trim()
  return memberNames.length ? memberNames.join(', ') : 'Empty group'
}

/** Bot names by id. */
async function botNames(db: Pick<Db, 'select'>, ids?: readonly string[]): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: bots.id, name: bots.name })
    .from(bots)
    .where(ids ? inArray(bots.id, [...ids]) : undefined)
  return new Map(rows.map((row) => [row.id, row.name]))
}

/** A group chat with its name and its members, in member order. */
export type Group = Chat & { name: string; roster: { id: string; name: string }[] }

function withNames(chat: Chat, names: ReadonlyMap<string, string>): Group {
  const roster = chat.members.flatMap((id) => (names.has(id) ? [{ id, name: names.get(id)! }] : []))
  return { ...chat, name: groupName(chat.title, roster.map((member) => member.name)), roster }
}

/** Distinct member ids, each an existing bot, within the size limits; else `GroupMembersError`. */
async function checkMembers(db: Pick<Db, 'select'>, memberIds: readonly string[]): Promise<string[]> {
  const members = [...new Set(memberIds)]
  const { minMembers, maxMembers } = groupRoundRules
  if (members.length < minMembers) throw new GroupMembersError(`A group chat needs at least ${minMembers} bots`)
  if (members.length > maxMembers) throw new GroupMembersError(`Groups can have up to ${maxMembers} members`)
  const names = await botNames(db, members)
  const unknown = members.find((id) => !names.has(id))
  if (unknown) throw new GroupMembersError(`No such bot: ${unknown}`)
  return members
}

/** A group chat of `memberIds` (2–6 bots), named after them unless `title` is given. */
export async function createGroup(db: Db, { memberIds, title = null }: { memberIds: readonly string[]; title?: string | null }): Promise<Chat> {
  return db.transaction(async (tx) => {
    const members = await checkMembers(tx, memberIds)
    const [chat] = await tx
      .insert(chats)
      .values({ kind: 'group', members, title: title?.trim() || null })
      .returning()
    return chat!
  })
}

/**
 * Renames a group chat (a null or blank title names it after its members again) or changes its members (2–6 bots).
 * Throws `ChatNotFoundError` when there is no such group chat, `GroupMembersError` for members it can't have.
 */
export async function updateGroup(
  db: Db,
  chatId: string,
  changes: { title?: string | null; memberIds?: readonly string[] },
): Promise<Chat> {
  return db.transaction(async (tx) => {
    const [chat] = await tx.select().from(chats).where(and(eq(chats.id, chatId), eq(chats.kind, 'group')))
    if (!chat) throw new ChatNotFoundError('No such group chat')
    const set: Partial<Chat> = {}
    if (changes.title !== undefined) set.title = changes.title?.trim() || null
    if (changes.memberIds) set.members = await checkMembers(tx, changes.memberIds)
    if (!Object.keys(set).length) return chat
    const [updated] = await tx.update(chats).set(set).where(eq(chats.id, chatId)).returning()
    return updated!
  })
}

/** The group chat with its name and members' names, or undefined when there is no such group chat. */
export async function getGroup(db: Db, chatId: string): Promise<Group | undefined> {
  const [chat] = await db.select().from(chats).where(and(eq(chats.id, chatId), eq(chats.kind, 'group')))
  return chat && withNames(chat, await botNames(db, chat.members))
}

/** Every group chat, oldest first, or those `botId` is a member of. */
export async function listGroups(db: Db, botId?: string): Promise<Group[]> {
  const rows = await db
    .select()
    .from(chats)
    .where(
      and(
        eq(chats.kind, 'group'),
        botId ? sql`exists (select 1 from json_each(${chats.members}) where value = ${botId})` : undefined,
      ),
    )
    .orderBy(asc(chats.id))
  const names = await botNames(db)
  return rows.map((chat) => withNames(chat, names))
}

/** The group chat named `name`, ignoring case and a leading `@` or `#`, as bots address it; the oldest on a tie. */
export async function findGroupByName(db: Db, name: string): Promise<Group | undefined> {
  const wanted = name.trim().replace(/^[@#]/, '').trim().toLowerCase()
  return (await listGroups(db)).find((group) => group.name.toLowerCase() === wanted)
}

/** The names of the group's members other than `botId`, as a bot reads them: "Ana, Rex", or "no one else". */
export function othersIn(group: Group, botId: string): string {
  const others = group.roster.filter((member) => member.id !== botId).map((member) => member.name)
  return others.length ? others.join(', ') : 'no one else'
}

/** Whom a message mentions among `members`: `@everyone`, or each member named with an `@`, ignoring case. */
export function mentionedMembers(text: string, members: readonly { id: string; name: string }[]): { everyone: boolean; ids: string[] } {
  const lower = text.toLowerCase()
  const mentions = (name: string) => {
    const tag = `@${name.toLowerCase()}`
    for (let at = lower.indexOf(tag); at !== -1; at = lower.indexOf(tag, at + 1)) {
      const before = lower[at - 1]
      const after = lower[at + tag.length]
      // Not inside an email address or a longer name: "a@rex.dev", "@Rexford".
      if ((before === undefined || !/[\p{L}\p{N}_]/u.test(before)) && (after === undefined || !/[\p{L}\p{N}_]/u.test(after))) return true
    }
    return false
  }
  return {
    everyone: mentions('everyone'),
    ids: members.filter((member) => mentions(member.name)).map((member) => member.id),
  }
}

/** What a member's turn shows it: the messages others posted since its last turn, the newest few of them. */
export type TurnMessages = {
  /** Oldest first, at most `maxMessagesPerTurn`. */
  messages: Message[]
  /** Messages since its last turn that are too old to show. */
  omitted: number
  /** The newest message in the chat when read; its next turn starts after it. */
  cursor: string | null
}

/** The messages `botId` hasn't had a turn on yet in the group chat: others' since its cursor, newest `limit`. */
export async function turnMessages(db: Db, chat: Chat, botId: string, limit: number = groupRoundRules.maxMessagesPerTurn): Promise<TurnMessages> {
  const [last] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.chatId, chat.id))
    .orderBy(desc(messages.id))
    .limit(1)
  if (!last) return { messages: [], omitted: 0, cursor: null }
  const since = chat.turnCursors[botId]
  // Up to the newest message read first: one posted meanwhile is after the cursor, so the next turn shows it.
  const unseen = and(
    eq(messages.chatId, chat.id),
    since ? gt(messages.id, since) : undefined,
    lte(messages.id, last.id),
    or(isNull(messages.authorBotId), ne(messages.authorBotId, botId)),
  )
  const newest = await db.select().from(messages).where(unseen).orderBy(desc(messages.id)).limit(limit)
  const [count] = await db.select({ count: sql<number>`count(*)` }).from(messages).where(unseen)
  return { messages: newest.reverse(), omitted: (count?.count ?? 0) - newest.length, cursor: last.id }
}

/** Remembers that `botId`'s turn showed it the group chat up to message `cursor`. */
export async function setTurnCursor(db: Db, chatId: string, botId: string, cursor: string): Promise<void> {
  await db
    .update(chats)
    .set({ turnCursors: sql`json_set(${chats.turnCursors}, ${`$."${botId}"`}, ${cursor})` })
    .where(eq(chats.id, chatId))
}

/** The messages `botId` posted in the chat after message `after` (or ever), oldest first. */
export async function postedSince(db: Db, chatId: string, botId: string, after: string | null): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.authorBotId, botId), after ? gt(messages.id, after) : undefined))
    .orderBy(asc(messages.id))
}

/** One message as a member's turn shows it: who posted it, its text and where its files are. */
function describeGroupMessage(message: Message): string {
  const author = message.author === 'owner' ? 'The owner' : message.authorName
  const files = message.attachments.map((file) => `- ${file.path} (${file.mimeType})`)
  const text = message.text.trim() || '(files only)'
  return files.length ? `${author}: ${text}\n[attached, on the computer:\n${files.join('\n')}]` : `${author}: ${text}`
}

/**
 * What a member reads when its turn comes: Grok's group tag (`[Group chat: "Launch" - with Ana, Rex]`), the rules of a
 * turn, then the messages since its last turn.
 */
export function describeTurn(group: Group, botId: string, since: TurnMessages): string {
  const { maxMessagesPerMemberTurn } = groupRoundRules
  const lines = [
    `[Group chat: "${group.name}" - with ${othersIn(group, botId)}]`,
    `[Your turn in the group chat. The owner and every member read what you send here. Reply with sendMessage, at most ${maxMessagesPerMemberTurn} messages, ` +
      'or pass by ending your turn without sending anything. Pass unless you have something useful to add, and never repeat what someone already said. ' +
      'Answer when you are mentioned (@name or @everyone). Never reveal anything from your private chat with the owner or other private context.]',
    '',
  ]
  if (since.omitted > 0) lines.push(`(${since.omitted} earlier message${since.omitted === 1 ? '' : 's'} not shown)`)
  lines.push(...since.messages.map(describeGroupMessage))
  return lines.join('\n')
}
