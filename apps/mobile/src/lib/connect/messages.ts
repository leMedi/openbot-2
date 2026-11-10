import type { Failure } from './check.ts'

/**
 * What Connect and the banner's diagnosis say for a failure at `url` (copy from the Connect flow, #88). Tailscale is
 * mentioned only for a Tailscale address: a `*.ts.net` name or a `100.x` IP.
 */
export function failureMessage(failure: Failure, url: string): string {
  const { hostname: host, port, protocol } = new URL(url)
  switch (failure.kind) {
    case 'notFound':
      return isTailscale(host) ? `Can't find ${host}. Is Tailscale on on this phone?` : `Can't find ${host}.`
    case 'timeout':
      return `No answer from ${host}. Is this phone on the same network or VPN as OpenBot?`
    case 'refused':
      return `${host} is up but nothing is listening on port ${port || (protocol === 'https:' ? '443' : '80')}.`
    case 'certificate':
      return `${host}'s certificate isn't trusted.`
    case 'notOpenBot':
      return "That address answered, but it isn't OpenBot."
    case 'localNetwork':
      return "OpenBot isn't allowed on your local network."
    case 'offline':
      return "This phone isn't connected to a network."
    case 'other':
      return `Couldn't reach ${host}: ${failure.detail}`
  }
}

function isTailscale(host: string): boolean {
  return host.endsWith('.ts.net') || /^100\.\d+\.\d+\.\d+$/.test(host)
}
