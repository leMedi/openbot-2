import { searchTabs } from '@openbot/client'

/** The palette's tabs, in order: the search tabs both apps show, then the web's Actions. */
export const paletteTabs = [...searchTabs, 'actions'] as const
export type PaletteTab = (typeof paletteTabs)[number]
