// What every sign-in shares, a model provider's or a plugin account's: its steps, as the web wizard shows them.

/** One step of a sign-in, as shown by the web wizard. Never carries a credential. */
export type SignInStep =
  | { type: 'started'; signInId: string }
  | { type: 'info'; message: string; links: { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { type: 'progress'; message: string }
  | {
      type: 'prompt'
      promptId: string
      /** `manual_code` asks for the final redirect URL (or code) when the loopback callback can't be reached. */
      kind: 'text' | 'secret' | 'select' | 'manual_code'
      message: string
      placeholder?: string
      options?: { id: string; label: string; description?: string }[]
    }
  /** The sign-in no longer needs an answer to that prompt, e.g. the loopback callback arrived first. */
  | { type: 'prompt_closed'; promptId: string }
  | { type: 'connected' }
  | { type: 'failed'; message: string }

export class SignInNotFoundError extends Error {}

/** A single-reader queue of steps that ends after `close()`. */
export function stepQueue() {
  const queue: SignInStep[] = []
  let closed = false
  let wakeUp: (() => void) | undefined
  return {
    push(step: SignInStep) {
      queue.push(step)
      wakeUp?.()
    },
    close() {
      closed = true
      wakeUp?.()
    },
    async *drain() {
      while (true) {
        const next = queue.shift()
        if (next) yield next
        else if (closed) return
        else await new Promise<void>((resolve) => (wakeUp = resolve))
      }
    },
  }
}
