import type { ExpoPushMessage } from '../push.ts'

/** Expo's error for a token whose app was uninstalled or whose push permission was revoked. */
type ExpoTokenError = 'DeviceNotRegistered'

/**
 * A fake Expo Push Service, as the push sender's `fetch`: records every send and receipt request and answers with
 * tickets and receipts, so tests never reach exp.host. Tokens can be made to fail at send (a ticket error) or later, in
 * their receipts.
 */
export function createFakeExpoPush() {
  /** Each send request's messages, in order. */
  const requests: ExpoPushMessage[][] = []
  /** Each receipt request's ticket ids, in order. */
  const receiptRequests: string[][] = []
  /** The headers of every request, e.g. to check the access token. */
  const headers: Headers[] = []
  const failAtSend = new Map<string, ExpoTokenError>()
  const failInReceipt = new Map<string, ExpoTokenError>()
  /** Which token each ticket was for. */
  const tickets = new Map<string, string>()
  let nextTicket = 0

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    headers.push(new Headers(init?.headers))
    const body = JSON.parse(String(init?.body))
    if (url.endsWith('/push/send')) {
      const messages = body as ExpoPushMessage[]
      requests.push(messages)
      const data = messages.map((message) => {
        const error = failAtSend.get(message.to)
        if (error) return { status: 'error', message: `"${message.to}" is not a registered push notification recipient`, details: { error } }
        const id = `ticket-${++nextTicket}`
        tickets.set(id, message.to)
        return { status: 'ok', id }
      })
      return Response.json({ data })
    }
    if (url.endsWith('/push/getReceipts')) {
      const ids = (body as { ids: string[] }).ids
      receiptRequests.push(ids)
      const data = Object.fromEntries(
        ids.map((id) => {
          const error = failInReceipt.get(tickets.get(id) ?? '')
          return [id, error ? { status: 'error', message: 'The device is not registered', details: { error } } : { status: 'ok' }]
        }),
      )
      return Response.json({ data })
    }
    return new Response('Not found', { status: 404 })
  }

  return {
    fetch,
    requests,
    receiptRequests,
    headers,
    /** Every message sent, across requests, in order. */
    get messages(): ExpoPushMessage[] {
      return requests.flat()
    },
    /** The token's sends fail at once, with a ticket error. */
    failAtSend: (token: string, error: ExpoTokenError = 'DeviceNotRegistered') => void failAtSend.set(token, error),
    /** The token's sends are accepted, but their receipts report the error. */
    failInReceipt: (token: string, error: ExpoTokenError = 'DeviceNotRegistered') => void failInReceipt.set(token, error),
  }
}

export type FakeExpoPush = ReturnType<typeof createFakeExpoPush>
