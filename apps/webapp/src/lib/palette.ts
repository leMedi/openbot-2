/** The palette's tabs, in order: Grok's, with bots and groups as Chats, and without Links. */
export const paletteTabs = ['all', 'messages', 'chats', 'files', 'routines', 'actions'] as const
export type PaletteTab = (typeof paletteTabs)[number]
