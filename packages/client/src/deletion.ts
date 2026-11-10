/** What deleting something for good removes, as both apps ask before deleting it (ADR 0009). */
export const deleteWarnings = {
  bot: (name: string) =>
    `This permanently deletes ${name}, its DM and history, and removes it from group chats. Its messages in other chats stay, marked as deleted. This can't be undone.`,
  group:
    "This permanently deletes the group chat, its messages and the files sent in it, and stops its members answering. The members stay, and remember what they said in it. This can't be undone.",
  routine: "This permanently deletes the routine and its run history. Messages it sent stay in the chat. This can't be undone.",
  /** Several chats, `bots` of them DMs (deleted with their bots). */
  chats: (count: number, bots: number) =>
    [
      bots > 0 && `This permanently deletes ${bots === 1 ? 'a bot' : `${bots} bots`} with ${bots === 1 ? 'its DM' : 'their DMs'} and history.`,
      bots < count && 'Group chats lose their messages and files; their members stay.',
      "This can't be undone.",
    ]
      .filter(Boolean)
      .join(' '),
}
