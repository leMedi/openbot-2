import { getNetworkStateAsync } from 'expo-network'
import { Platform } from 'react-native'
import { type CheckResult, checkInstance } from './check.ts'

export const platform = Platform.OS === 'ios' ? 'ios' : 'android'

/** Checks instance addresses from the phone, over the global `fetch` (`expo/fetch`). */
export function checkFromPhone(candidates: readonly string[]): Promise<CheckResult> {
  return checkInstance(candidates, {
    platform,
    offline: async () => (await getNetworkStateAsync()).isConnected === false,
    fetch: (url, init) => fetch(url, init),
  })
}
