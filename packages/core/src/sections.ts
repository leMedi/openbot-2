import { type Db, type Section, chats, sections, unassignedSectionId } from '@openbot/db'
import { asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { ChatNotFoundError } from './chats.ts'

/** The longest name a section can have. */
export const maxSectionNameLength = 40

/** There is no section with that id. */
export class NoSuchSectionError extends Error {}

/** A section change the sidebar can't make: a blank or long name, Unassigned renamed or deleted, an order missing sections. */
export class InvalidSectionError extends Error {}

/** The sidebar's sections, top first, Unassigned among them. */
export async function listSections(db: Db): Promise<Section[]> {
  return db.select().from(sections).orderBy(asc(sections.position))
}

function sectionName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new InvalidSectionError('A section needs a name')
  if (trimmed.length > maxSectionNameLength) throw new InvalidSectionError(`A section's name is at most ${maxSectionNameLength} characters`)
  return trimmed
}

/** Throws `InvalidSectionError` for Unassigned, which only keeps its place. */
function assertOwnSection(id: string) {
  if (id === unassignedSectionId) throw new InvalidSectionError("Unassigned can't be renamed or deleted")
}

/** Adds a section named `name` at the top, above every other one. */
export async function createSection(db: Db, name: string): Promise<Section> {
  const values = { name: sectionName(name), position: 0 }
  return db.transaction(async (tx) => {
    await tx.update(sections).set({ position: sql`${sections.position} + 1` })
    const [section] = await tx.insert(sections).values(values).returning()
    return section!
  })
}

/** Renames one of the owner's sections. */
export async function renameSection(db: Db, id: string, name: string): Promise<Section> {
  assertOwnSection(id)
  const [section] = await db.update(sections).set({ name: sectionName(name) }).where(eq(sections.id, id)).returning()
  if (!section) throw new NoSuchSectionError('No such section')
  return section
}

/** Puts the sections in the order of `ids`, which must name every section once, Unassigned included. */
export async function reorderSections(db: Db, ids: readonly string[]): Promise<Section[]> {
  return db.transaction(async (tx) => {
    const all = await tx.select({ id: sections.id }).from(sections)
    const known = new Set(all.map((section) => section.id))
    if (new Set(ids).size !== ids.length || ids.length !== known.size || ids.some((id) => !known.has(id))) {
      throw new InvalidSectionError('The order must name every section once')
    }
    for (const [position, id] of ids.entries()) await tx.update(sections).set({ position }).where(eq(sections.id, id))
    return tx.select().from(sections).orderBy(asc(sections.position))
  })
}

/** Deletes a section; its chats go to Unassigned. Returns their ids. */
export async function deleteSection(db: Db, id: string): Promise<string[]> {
  assertOwnSection(id)
  return db.transaction(async (tx) => {
    const moved = await tx.select({ id: chats.id }).from(chats).where(eq(chats.sectionId, id))
    const [deleted] = await tx.delete(sections).where(eq(sections.id, id)).returning({ position: sections.position })
    if (!deleted) throw new NoSuchSectionError('No such section')
    await tx
      .update(sections)
      .set({ position: sql`${sections.position} - 1` })
      .where(sql`${sections.position} > ${deleted.position}`)
    return moved.map((chat) => chat.id)
  })
}

/** Throws `ChatNotFoundError` unless every one of `chatIds` is a chat. */
async function assertChatsExist(db: Pick<Db, 'select'>, chatIds: readonly string[]) {
  const found = await db.select({ id: chats.id }).from(chats).where(inArray(chats.id, [...chatIds]))
  const known = new Set(found.map((chat) => chat.id))
  const missing = chatIds.find((id) => !known.has(id))
  if (missing) throw new ChatNotFoundError(`No such chat: ${missing}`)
}

/** Moves chats to section `sectionId` (Unassigned for none), showing any hidden among them. */
export async function moveChats(db: Db, chatIds: readonly string[], sectionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertChatsExist(tx, chatIds)
    const [section] = await tx.select({ id: sections.id }).from(sections).where(eq(sections.id, sectionId))
    if (!section) throw new NoSuchSectionError('No such section')
    await tx
      .update(chats)
      .set({ sectionId: sectionId === unassignedSectionId ? null : sectionId, hiddenAt: null })
      .where(inArray(chats.id, [...chatIds]))
  })
}

/**
 * Hides chats: moves them to the sidebar's Hidden section, keeping their own section for when they are shown again.
 * A pinned chat is unpinned, the other pinned chats keeping their order. Returns the ids of every chat that changed.
 */
export async function hideChats(db: Db, chatIds: readonly string[], now = new Date()): Promise<string[]> {
  return db.transaction(async (tx) => {
    await assertChatsExist(tx, chatIds)
    const hiding = await tx
      .update(chats)
      .set({ hiddenAt: now, pinnedPosition: null })
      .where(sql`${inArray(chats.id, [...chatIds])} and ${isNull(chats.hiddenAt)}`)
      .returning({ id: chats.id })
    const changed = hiding.map((chat) => chat.id)
    const pinned = await tx.select({ id: chats.id, pinnedPosition: chats.pinnedPosition }).from(chats).where(isNotNull(chats.pinnedPosition)).orderBy(asc(chats.pinnedPosition))
    for (const [position, chat] of pinned.entries()) {
      if (chat.pinnedPosition === position) continue
      await tx.update(chats).set({ pinnedPosition: position }).where(eq(chats.id, chat.id))
      changed.push(chat.id)
    }
    return changed
  })
}

/** Shows hidden chats again, each back in its own section. Returns the ids of those that were hidden. */
export async function showChats(db: Db, chatIds: readonly string[]): Promise<string[]> {
  return db.transaction(async (tx) => {
    await assertChatsExist(tx, chatIds)
    const shown = await tx
      .update(chats)
      .set({ hiddenAt: null })
      .where(sql`${inArray(chats.id, [...chatIds])} and ${isNotNull(chats.hiddenAt)}`)
      .returning({ id: chats.id })
    return shown.map((chat) => chat.id)
  })
}
