import { type ApiClient, createApiClient } from '@openbot/api-contract'

let client: ApiClient | undefined

/** The API client for this origin; browser only. */
export function api(): ApiClient {
  client ??= createApiClient(new URL('/api', window.location.origin).href)
  return client
}

/** The message of an API or network error, for display. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
