/** Grok Bot's rules for answering one owner message in a group chat. */
export const groupRoundRules = {
  maxRounds: 3,
  maxMemberTurns: 10,
  maxMessagesPerMemberTurn: 2,
  /** Messages since a member last spoke that its turn receives. */
  maxCatchUpMessages: 24,
} as const
