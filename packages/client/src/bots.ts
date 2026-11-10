import { avatarColors, avatarShapes, type BotInfo, type NewBot } from '@openbot/api-contract'

/** What each avatar style is called in the avatar picker. */
export const avatarStyleLabels: Record<BotInfo['avatarStyle'], string> = { critter: 'Critter', bauhaus: 'Bauhaus' }

/** A new bot's avatar until the owner picks another: a critter of a random shape and color. */
export function randomAvatar(): Pick<NewBot, 'avatarShape' | 'avatarColor'> & { avatarStyle: BotInfo['avatarStyle'] } {
  return {
    avatarStyle: 'critter',
    avatarShape: avatarShapes[Math.floor(Math.random() * avatarShapes.length)]!,
    avatarColor: avatarColors[Math.floor(Math.random() * avatarColors.length)]!,
  }
}
