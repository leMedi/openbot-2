import type { DeviceInfo } from '@openbot/api-contract'

export const platformNames: Record<DeviceInfo['platform'], string> = { ios: 'iOS', android: 'Android' }

/** What a phone's switches let through, e.g. "Messages and when a bot needs you". */
export function notifiedFor(device: Pick<DeviceInfo, 'messages' | 'needsYou'>): string {
  if (device.messages && device.needsYou) return 'Messages and when a bot needs you'
  if (device.messages) return 'Messages only'
  if (device.needsYou) return 'Only when a bot needs you'
  return 'Nothing'
}
