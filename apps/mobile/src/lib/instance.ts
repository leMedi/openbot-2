/**
 * The instance's address, from `EXPO_PUBLIC_OPENBOT_URL` (see .env.example) until the Connect screen asks for it: a
 * full URL, http or https, without the `/api` the app adds itself. Undefined when unset or not a URL.
 */
export function devInstanceAddress(): string | undefined {
  const value = process.env.EXPO_PUBLIC_OPENBOT_URL?.trim()
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined
  } catch {
    return undefined
  }
}
