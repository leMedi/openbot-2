import { type ApiClient, type Contract, createApiClient } from '@openbot/api-contract'
import { watchStalls } from '@openbot/client'

/**
 * The API of the instance at `address` (e.g. `http://192.168.1.20:3000`), over the global `fetch`, which Expo makes
 * `expo/fetch` on iOS and Android so the live stream streams (never set `EXPO_PUBLIC_USE_RN_FETCH`, which turns that
 * off). The live stream is watched for stalls, so a connection that died silently is dropped and reopened.
 */
/** The live event stream's procedure, typed so a rename fails here instead of silently dropping the watch. */
const liveStream: keyof Contract = 'events'

export function instanceApi(address: string): ApiClient {
  const watched = watchStalls((request, init) => fetch(request, init))
  return createApiClient(new URL('/api', address).href, {
    fetch: (request, init, path) => (path[0] === liveStream ? watched(request, init) : fetch(request, init)),
  })
}
