import { maxAttachmentBytes, maxAttachments, type MessageInfo, type QuestionCardInfo, type ReplyToInfo, type RoutineChangeCardInfo, type TakeOverCardInfo } from '@openbot/api-contract'

/** What the composer needs to know of a file it holds: a browser `File`, or a file picked on the phone. */
export type ComposerFile = { name: string; size: number }

/** Adds `added` to `files`, up to Grok's 6; returns them and why any were left out. */
export function addFiles<F extends ComposerFile>(files: readonly F[], added: readonly F[]): { files: F[]; notice?: string } {
  const tooLarge = added.filter((file) => file.size > maxAttachmentBytes)
  const fitting = added.filter((file) => file.size <= maxAttachmentBytes)
  const next = [...files, ...fitting].slice(0, maxAttachments)
  if (tooLarge.length) return { files: next, notice: `${tooLarge[0]!.name} is larger than ${maxAttachmentBytes / 1024 / 1024} MB` }
  if (files.length + fitting.length > maxAttachments) return { files: next, notice: `You can attach up to ${maxAttachments} files` }
  return { files: next }
}

/** `size` bytes, for people: `512 B`, `12 KB`, `3.4 MB`. */
export function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/** How a message's file shows: images and videos in a gallery, audio as a player, every other file as a chip. */
export type AttachmentKind = 'image' | 'video' | 'audio' | 'file'

/** How a file of `mimeType` shows in a message. */
export function attachmentKind({ mimeType }: { mimeType: string }): AttachmentKind {
  // An SVG could carry scripts; it downloads as a file.
  if (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml') return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  return 'file'
}

/** A message the owner sent that the server hasn't returned yet, or that failed. */
export type Outgoing<F extends ComposerFile = ComposerFile> = {
  key: string
  text: string
  files: F[]
  /** What it replies to, shown on it until the server's copy is in. */
  replyTo?: ReplyToInfo
  /** The chat's last message id when it was sent; the server's copy sorts after it. */
  after: string | undefined
  error?: string
}

/** A transcript's row: a message of the server's, or one the owner is sending. */
export type TranscriptRow<F extends ComposerFile = ComposerFile> = {
  key: string
  /** `owner`, or `bot:<id>`: consecutive rows of one author group together. */
  author: string
  authorName: string
  mine: boolean
  text: string
  continuesPrevious: boolean
  continuesNext: boolean
  outgoing?: Outgoing<F>
  /** The server's message, when it has one; a card and attachments render from it. */
  message?: MessageInfo
}

/**
 * A chat's rows, oldest first: its loaded messages, then what the owner sent that the server hasn't returned. A sent
 * message goes once its copy is in, which the live stream can deliver before the send returns: the owner's, with the
 * same text and file sizes, newer than the chat's last message when it was sent.
 */
export function transcript<F extends ComposerFile>(messages: readonly MessageInfo[], outgoing: readonly Outgoing<F>[]): TranscriptRow<F>[] {
  const rows: Omit<TranscriptRow<F>, 'continuesPrevious' | 'continuesNext'>[] = [
    ...messages.map((message) => ({
      key: message.id,
      author: message.author === 'owner' ? 'owner' : `bot:${message.botId}`,
      authorName: message.authorName,
      mine: message.author === 'owner',
      text: message.text,
      message,
    })),
    ...outgoing
      .filter(
        (entry) =>
          !messages.some(
            (message) =>
              message.author === 'owner' &&
              message.text === entry.text &&
              message.attachments.map((file) => file.size).join() === entry.files.map((file) => file.size).join() &&
              (!entry.after || message.id > entry.after),
          ),
      )
      .map((entry) => ({ key: entry.key, author: 'owner', authorName: 'You', mine: true, text: entry.text, outgoing: entry })),
  ]
  return rows.map((row, index) => ({
    ...row,
    continuesPrevious: rows[index - 1]?.author === row.author,
    continuesNext: rows[index + 1]?.author === row.author,
  }))
}

/** A question's option letter: A, B, C… */
export const optionLetter = (index: number) => String.fromCharCode(65 + index)

/** An answered question's answer as it shows: the option with its letter, or the owner's own text. */
export function shownAnswer(card: QuestionCardInfo): string | undefined {
  if (!card.answer) return undefined
  return 'option' in card.answer ? `${optionLetter(card.answer.option)}. ${card.options[card.answer.option]?.label}` : card.answer.text
}

/** A routine change row's verb: "Rex created routine". */
export const routineChangeVerbs: Record<RoutineChangeCardInfo['change'], string> = {
  created: 'created',
  updated: 'changed',
  paused: 'paused',
  resumed: 'resumed',
  deleted: 'deleted',
}

/**
 * The take-over card a bot's Screen shows, while it waits for the owner: `messageId`'s, or else the latest waiting
 * among `messages` (its chat's, as loaded).
 */
export function waitingTakeOver(messages: readonly MessageInfo[], messageId?: string): { message: MessageInfo; card: TakeOverCardInfo } | undefined {
  const message = messageId ? messages.find((each) => each.id === messageId) : [...messages].reverse().find((each) => each.card?.type === 'take_over' && !each.card.outcome)
  const card = message?.card
  return message && card?.type === 'take_over' && !card.outcome ? { message, card } : undefined
}
