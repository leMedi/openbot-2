import { isMuted, type PushData, type PushKind, previewText } from '@openbot/api-contract'
import {
  type ChatSummary,
  type Clock,
  type ClockTimer,
  getChatSummary,
  isPluginReconnectCard,
  isPluginRequestCard,
  isQuestionCard,
  isTakeOverCard,
  listChatSummaries,
  listDevices,
  unregisterDevice,
} from '@openbot/core'
import type { Attachment, Db, Message } from '@openbot/db'
import type { ViewedChats } from './viewed-chats.ts'
import { toChatInfo } from './views.ts'

/** The Expo Push Service's API: `/send` and `/getReceipts` under it. */
export const expoPushUrl = 'https://exp.host/--/api/v2/push'

/** Expo takes at most 100 messages in one send request, and 1000 ticket ids in one receipt request. */
const maxMessagesPerRequest = 100
const maxReceiptsPerRequest = 1000

/** The most a notification's payload may weigh, as Apple and Google get it. */
export const maxPushBytes = 4096

/** About how long a push's body runs, in characters, before it is cut with an ellipsis. */
export const maxPushBodyLength = 200

/** Expo's receipts are ready about 15 minutes after sending (and kept for a day). */
export const receiptDelay = 15 * 60_000

/** One notification to one phone, as Expo's send API takes it. */
export type ExpoPushMessage = {
  to: string
  title: string
  body: string
  data: PushData
  /** The chats unread or with a card waiting. */
  badge: number
  /** One line per chat: a later push replaces the chat's line. */
  collapseId: string
  /** `default` plays the sound; absent, a replacement arrives quietly. */
  sound?: 'default'
  priority: 'high'
}

/** Expo's answer for a notification it couldn't take or deliver; `details.error` is e.g. `DeviceNotRegistered`. */
type ExpoError = { status: 'error'; message: string; details?: { error?: string } }
type ExpoTicket = { status: 'ok'; id: string } | ExpoError
type ExpoReceipt = { status: 'ok' } | ExpoError
/** A notification Expo took, by its ticket id, and the phone's token it went to. */
type SentTicket = { id: string; to: string }

/**
 * Sends notifications to the owner's registered phones through the Expo Push Service, with push security off, or with
 * `accessToken` (`EXPO_ACCESS_TOKEN`) when a self-builder turns it on. Notifies of a bot's message (the first of its
 * turn with a sound, later ones replacing it quietly) and of each card that starts waiting, except for a chat the owner
 * is viewing; a muted or hidden chat's messages don't notify, its cards still do. Checks receipts about 15 minutes
 * later, dropping the phones Expo no longer knows.
 */
export class PushSender {
  readonly #db: Db
  readonly #clock: Clock
  readonly #viewedChats: ViewedChats
  readonly #fetch: typeof globalThis.fetch
  readonly #accessToken: string | undefined
  /** Each chat's turn that last notified, `botId:inputId`, so its later messages replace the line quietly. */
  readonly #turns = new Map<string, string>()
  readonly #timers = new Set<ClockTimer>()
  /** Pushes go out one at a time, in the order they were asked: a turn's first message before its replacements. */
  #queue: Promise<void> = Promise.resolve()
  #closed = false

  constructor({
    db,
    clock,
    viewedChats,
    fetch = globalThis.fetch,
    accessToken,
  }: {
    db: Db
    clock: Clock
    viewedChats: ViewedChats
    /** Reaches the Expo Push Service; a fake in tests. */
    fetch?: typeof globalThis.fetch
    /** Expo's access token, for a project with push security on. */
    accessToken?: string
  }) {
    this.#db = db
    this.#clock = clock
    this.#viewedChats = viewedChats
    this.#fetch = fetch
    this.#accessToken = accessToken
  }

  /**
   * A bot posted `message` for the owner (not to another bot), in its run of input `inputId` when it has one. The first
   * message of a bot's turn in a chat notifies with a sound; its later ones replace the chat's line quietly.
   */
  messagePosted(message: Message, inputId?: string) {
    const turn = inputId ? `${message.authorBotId}:${inputId}` : undefined
    this.#enqueue(() => this.#notify(message, 'message', turn))
  }

  /** A bot's card started waiting for the owner: a question, a take-over, a plugin request or reconnect. */
  cardPosted(message: Message) {
    const kind = cardKind(message.card)
    if (kind) this.#enqueue(() => this.#notify(message, kind))
  }

  /** Settles once every push asked so far has been sent (or failed). */
  idle(): Promise<void> {
    return this.#queue
  }

  /** Stops sending, and the receipt checks still to come; when the server stops. */
  close() {
    this.#closed = true
    for (const timer of this.#timers) this.#clock.clearTimer(timer)
    this.#timers.clear()
  }

  #enqueue(push: () => Promise<void>) {
    this.#queue = this.#queue.then(push).catch((error) => console.error("[push] Couldn't notify the owner:", error))
  }

  /**
   * Notifies the owner's phones of `message`, unless they shouldn't hear of it. A message of `turn` (`botId:inputId`)
   * replaces the chat's line quietly when an earlier one of the same turn notified; a card always plays the sound.
   */
  async #notify(message: Message, kind: PushKind, turn?: string) {
    if (this.#closed) return
    const chat = await getChatSummary(this.#db, message.chatId)
    if (!chat || this.#viewedChats.isViewed(chat.id)) return
    const now = this.#clock.now()
    if (kind === 'message' && isMuted(toChatInfo(chat, null, now), now)) return
    const phones = (await listDevices(this.#db)).filter((phone) => (kind === 'message' ? phone.notifyMessages : phone.notifyNeedsYou))
    if (!phones.length) return
    const badge = (await listChatSummaries(this.#db)).filter((each) => each.unread || each.waitingFor !== null).length
    const title = chat.kind === 'group' ? (chat.name ?? message.authorName) : message.authorName
    const body = bodyOf(message, kind, chat)
    const data: PushData = { chatId: chat.id, messageId: message.id, kind }
    // Only a push that went out makes the turn's next ones quiet: one the owner never got replaces nothing.
    const loud = kind !== 'message' || !turn || this.#turns.get(chat.id) !== turn
    // A card's line isn't replaced quietly: the turn's next message, after it, plays the sound again.
    if (kind === 'message' && turn) this.#turns.set(chat.id, turn)
    else this.#turns.delete(chat.id)
    await this.#send(
      phones.map(({ expoPushToken }) =>
        fit({ to: expoPushToken, title, body, data, badge, collapseId: chat.id, ...(loud && { sound: 'default' as const }), priority: 'high' }),
      ),
    )
  }

  /** Sends `messages`, 100 to a request, and checks the receipts of each request's accepted ones later. */
  async #send(messages: ExpoPushMessage[]) {
    for (let start = 0; start < messages.length; start += maxMessagesPerRequest) {
      const batch = messages.slice(start, start + maxMessagesPerRequest)
      const tickets = await this.#post<ExpoTicket[]>('/send', batch)
      const accepted: SentTicket[] = []
      for (const [index, ticket] of tickets.entries()) {
        const to = batch[index]!.to
        if (ticket.status === 'ok') accepted.push({ id: ticket.id, to })
        else await this.#failed(to, ticket)
      }
      this.#checkReceiptsLater(accepted)
    }
  }

  #checkReceiptsLater(accepted: SentTicket[]) {
    if (!accepted.length || this.#closed) return
    const timer = this.#clock.setTimer(async () => {
      this.#timers.delete(timer)
      await this.#checkReceipts(accepted).catch((error) => console.error("[push] Couldn't check notifications' receipts:", error))
    }, receiptDelay)
    this.#timers.add(timer)
  }

  async #checkReceipts(tickets: SentTicket[]) {
    if (this.#closed) return
    for (let start = 0; start < tickets.length; start += maxReceiptsPerRequest) {
      const batch = tickets.slice(start, start + maxReceiptsPerRequest)
      const receipts = await this.#post<Record<string, ExpoReceipt>>('/getReceipts', { ids: batch.map((ticket) => ticket.id) })
      for (const { id, to } of batch) {
        const receipt = receipts[id]
        if (receipt?.status === 'error') await this.#failed(to, receipt)
      }
    }
  }

  /** A notification to `to` failed: a token Expo no longer knows is dropped, other errors are logged. */
  async #failed(to: string, { message, details }: ExpoError) {
    if (details?.error === 'DeviceNotRegistered') await unregisterDevice(this.#db, to)
    else console.warn(`[push] A notification failed: ${details?.error ?? message}`)
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.#fetch(`${expoPushUrl}${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(this.#accessToken && { authorization: `Bearer ${this.#accessToken}` }),
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`Expo answered ${response.status}: ${await response.text()}`)
    const { data } = (await response.json()) as { data: T }
    return data
  }
}

/** What a card notifies as, or undefined for a card that doesn't notify (a routine change row). */
function cardKind(card: unknown): PushKind | undefined {
  if (isQuestionCard(card)) return 'question'
  if (isTakeOverCard(card)) return 'take_over'
  if (isPluginRequestCard(card)) return 'plugin_request'
  if (isPluginReconnectCard(card)) return 'plugin_reconnect'
  return undefined
}

/**
 * A notification's text: a card's prompt, instruction or request, or the message as plain text ("📎 report.pdf",
 * "📷 Photo" for files alone), after "Rex: " in a group; cut to about 200 characters.
 */
function bodyOf(message: Message, kind: PushKind, chat: ChatSummary): string {
  const card = message.card
  if (kind === 'question' && isQuestionCard(card)) return cut(previewText(card.prompt))
  if (kind === 'take_over' && isTakeOverCard(card)) return cut(previewText(card.instruction))
  if (kind === 'plugin_reconnect' && isPluginReconnectCard(card)) return cut(`Reconnect ${card.displayName}`)
  const text = previewText(message.text) || filesLine(message.attachments)
  return cut(chat.kind === 'group' ? `${message.authorName}: ${text}` : text)
}

/** A message that's only files: "📷 Photo", "📷 3 photos", "📎 report.pdf", "📎 3 files". */
function filesLine(files: readonly Attachment[]): string {
  if (!files.length) return ''
  const photos = files.every((file) => file.mimeType.startsWith('image/') && file.mimeType !== 'image/svg+xml')
  if (photos) return files.length === 1 ? '📷 Photo' : `📷 ${files.length} photos`
  return files.length === 1 ? `📎 ${files[0]!.name}` : `📎 ${files.length} files`
}

/** `text` cut to `max` characters (not splitting an emoji), ending in an ellipsis when cut. */
function cut(text: string, max = maxPushBodyLength): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`
}

/** The message, its body (then its title) cut further until its payload is within Expo's 4 KB. */
function fit(message: ExpoPushMessage): ExpoPushMessage {
  const bytes = (each: ExpoPushMessage) => Buffer.byteLength(JSON.stringify(each))
  let fitted = message
  for (let max = maxPushBodyLength; bytes(fitted) > maxPushBytes && max > 1; max = Math.floor(max / 2)) fitted = { ...fitted, body: cut(message.body, max) }
  for (let max = 100; bytes(fitted) > maxPushBytes && max > 1; max = Math.floor(max / 2)) fitted = { ...fitted, title: cut(message.title, max) }
  return fitted
}
