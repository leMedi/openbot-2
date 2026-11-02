/** Grok Bot's rules for group chats and for answering one message in one. */
export const groupRoundRules = {
  /** Rounds of member turns after one message, at most. */
  maxRounds: 3,
  /**
   * Messages members post after one message, across its rounds: no turn starts once they have (Grok's
   * `GROUP_MAX_MEMBER_TURNS`, which counts messages, not the turns members pass).
   */
  maxMessages: 10,
  /** Messages one member posts in one turn, at most. */
  maxMessagesPerMemberTurn: 2,
  /** The newest messages a member's turn shows it; older ones since its last turn are counted, not shown. */
  maxMessagesPerTurn: 24,
  /** A group chat is the owner and this many bots, at least. */
  minMembers: 2,
  /** Grok's cap on a group's members. */
  maxMembers: 6,
} as const
