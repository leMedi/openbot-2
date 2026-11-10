/** The port an OpenBot instance listens on by default (the installer's). */
export const defaultPort = '3000'

/**
 * The instance addresses to try, best first, for what the owner typed on Connect: a name or IP, with or without a port,
 * or a full `http(s)://` URL (spec: Connect flow, #88). Without a scheme, https is tried, then http; http without a port
 * gets the default `:3000`. A typed path is ignored, as the app adds `/api` itself. Each is an origin, e.g.
 * `http://192.168.1.20:3000`, the field showing the one that answered. Empty when the input isn't an address.
 */
export function candidateUrls(input: string): string[] {
  const typed = input.trim()
  const scheme = /^([a-z][a-z\d+.-]*):\/\//i.exec(typed)?.[1]?.toLowerCase()
  if (scheme && scheme !== 'http' && scheme !== 'https') return []
  let url: URL
  try {
    url = new URL(scheme ? typed : `http://${typed}`)
  } catch {
    return []
  }
  if (!url.hostname) return []
  const host = url.hostname
  const http = `http://${host}:${url.port || defaultPort}`
  if (scheme === 'https') return [url.origin]
  if (scheme === 'http') return [http]
  return [url.port ? `https://${host}:${url.port}` : `https://${host}`, http]
}
