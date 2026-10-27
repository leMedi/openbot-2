import type { Db, Message } from '@openbot/db'
import { groupRoundRules } from './group-rules.ts'
import { describeTurn, getGroup, mentionedMembers, postedSince, setTurnCursor, turnMessages } from './groups.ts'
import type { AgentRuntime } from './ports/agent-runtime.ts'

export type GroupRoundsOptions = {
  db: Db
  /** Queues a member's turn and resolves once it has ended (`AgentRuntime.takeTurn`). */
  takeTurn: AgentRuntime['takeTurn']
  /** The member taking its turn in a group chat changed: a bot's id, or null between turns. */
  onSpeaking(chatId: string, botId: string | null): void
}

/** `items` rotated left by `by`: round 2 starts with round 1's second speaker. */
const rotate = <T>(items: readonly T[], by: number): T[] => {
  if (!items.length) return []
  const at = by % items.length
  return [...items.slice(at), ...items.slice(0, at)]
}

/**
 * Plays group chats in Grok's rounds. A message in a group (the owner's, or a member's post) starts rounds of member
 * turns, one member at a time, each reading what was said since its last turn. At most 3 rounds and 10
 * member turns; the order rotates each round; a round in which nobody posts ends it. Mentions choose who answers:
 * `@name` restricts the rounds to the members named (and those they then mention), `@everyone` or no mention lets
 * every member answer. A newer message ends the rounds going on after the turn in progress, and starts its own.
 */
export class GroupRounds {
  readonly #options: GroupRoundsOptions
  /** Each chat's latest rounds, which the next message's wait for. */
  readonly #playing = new Map<string, { generation: number; done: Promise<void> }>()
  /** The member taking its turn, by chat. */
  readonly #speaking = new Map<string, string>()
  #closed = false

  constructor(options: GroupRoundsOptions) {
    this.#options = options
  }

  /** The member taking its turn in the chat, if any. */
  speaking(chatId: string): string | null {
    return this.#speaking.get(chatId) ?? null
  }

  /** Starts the rounds answering `trigger`, posted in group chat `chatId`; resolves when it ends. */
  start(chatId: string, trigger: Message): Promise<void> {
    const previous = this.#playing.get(chatId)
    const generation = (previous?.generation ?? 0) + 1
    const done = (previous?.done ?? Promise.resolve()).then(() =>
      this.#play(chatId, trigger, generation).catch((error) => console.error(`[groups] The rounds in ${chatId} failed:`, error)),
    )
    this.#playing.set(chatId, { generation, done })
    void done.then(() => this.#playing.get(chatId)?.done === done && this.#playing.delete(chatId))
    return done
  }

  /** Resolves once the chat's rounds, those started so far, have ended. */
  async idle(chatId: string): Promise<void> {
    for (let playing; (playing = this.#playing.get(chatId)); ) await playing.done
  }

  /**
   * Starts rounds answering a member's post, `trigger`, unless the chat's rounds are going on: then the members read it
   * on their next turn, and the rounds answering the owner (and their mentions) go on.
   */
  startUnlessPlaying(chatId: string, trigger: Message): Promise<void> {
    return this.#playing.has(chatId) ? this.idle(chatId) : this.start(chatId, trigger)
  }

  /** Ends the chat's rounds after the turn in progress, e.g. as the group is deleted; resolves once they have ended. */
  end(chatId: string): Promise<void> {
    const playing = this.#playing.get(chatId)
    // A newer generation with nothing to play: the rounds going on are superseded.
    if (playing) this.#playing.set(chatId, { generation: playing.generation + 1, done: playing.done })
    return this.idle(chatId)
  }

  /** Ends every chat's rounds after the turn in progress. */
  close() {
    this.#closed = true
  }

  /** Whether a newer message (or closing) ended these rounds. */
  #superseded(chatId: string, generation: number) {
    return this.#closed || this.#playing.get(chatId)?.generation !== generation
  }

  async #play(chatId: string, trigger: Message, generation: number) {
    const { db } = this.#options
    const { maxRounds, maxMemberTurns } = groupRoundRules
    const group = await getGroup(db, chatId)
    if (!group) return
    const mentions = mentionedMembers(trigger.text, group.roster.filter((member) => member.id !== trigger.authorBotId))
    const restricted = !mentions.everyone && mentions.ids.length > 0
    // Who may answer this round: the members mentioned, or everyone but the poster.
    let answering = new Set(restricted ? mentions.ids : group.members.filter((id) => id !== trigger.authorBotId))
    let turns = 0
    for (let round = 0; round < maxRounds; round++) {
      let posted = false
      const mentionedNow = new Set<string>()
      const current = await getGroup(db, chatId)
      if (!current) return
      for (const botId of rotate(current.members.filter((id) => answering.has(id)), round)) {
        if (this.#superseded(chatId, generation) || turns >= maxMemberTurns) return
        // Read afresh: an earlier turn may have taken a while, and members come and go.
        const group = await getGroup(db, chatId)
        if (!group?.members.includes(botId)) continue
        const since = await turnMessages(db, group, botId)
        // Nothing new from anyone else: nothing to answer.
        if (!since.messages.length || !since.cursor) continue
        await setTurnCursor(db, chatId, botId, since.cursor)
        turns++
        const said = await this.#turn(group.id, botId, describeTurn(group, botId, since), since.cursor)
        if (!said.length) continue
        posted = true
        const others = group.roster.filter((member) => member.id !== botId)
        for (const message of said) for (const id of mentionedMembers(message.text, others).ids) mentionedNow.add(id)
      }
      if (!posted) return
      const members = (await getGroup(db, chatId))?.members ?? []
      answering = new Set(restricted ? [...mentions.ids, ...mentionedNow] : members)
    }
  }

  /** One member's turn: queued in its owner lane, awaited to its end. Returns what it posted in the group. */
  async #turn(chatId: string, botId: string, text: string, cursor: string): Promise<Message[]> {
    const { db, takeTurn, onSpeaking } = this.#options
    this.#speaking.set(chatId, botId)
    onSpeaking(chatId, botId)
    try {
      await takeTurn(botId, { lane: 'owner', groupChatId: chatId, text, id: `group:${chatId}:${botId}:${cursor}` })
    } catch (error) {
      // E.g. no model to run it on: the member misses its turn.
      console.error(`[groups] Bot ${botId} couldn't take its turn in ${chatId}:`, error)
    } finally {
      this.#speaking.delete(chatId)
      onSpeaking(chatId, null)
    }
    return postedSince(db, chatId, botId, cursor)
  }
}
