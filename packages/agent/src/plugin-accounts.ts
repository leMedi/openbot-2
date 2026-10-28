import { authorizeMcp, McpOAuthProvider, type McpOAuthState, type McpOAuthStateStore, MemoryOAuthStateStore } from '@earendil-works/pi-mcp/oauth'
import type { SecretBox } from '@openbot/core'
import { type Db, type PluginAccount, pluginAccounts } from '@openbot/db'
import { and, asc, count, eq, isNull } from 'drizzle-orm'
import { SealedCredentials } from './credential-store.ts'
import { SignInNotFoundError, type SignInStep, stepQueue } from './sign-in.ts'

/** A connected account of a plugin, as Settings → Plugins lists it. Never carries its tokens. */
export type PluginAccountSummary = { plugin: string; slug: string; displayName: string; connectedAt: Date }

/** The plugin to connect: its catalog name and display name, and the hosted MCP server an account signs in to. */
export type ConnectablePlugin = { name: string; displayName: string; serverUrl: string }

export class PluginAccountNotFoundError extends Error {}
export class InvalidAccountNameError extends Error {}
/** A pasted URL that isn't where this sign-in ended: another sign-in's, or no sign-in's. */
export class InvalidRedirectError extends Error {}

/**
 * Where a sign-in returns when the instance's own callback can't be reached by the authorization server's rules
 * (plain HTTP off loopback, design §5.5): nothing listens there, so the owner pastes the URL the browser ends on.
 */
const loopbackRedirect = 'http://127.0.0.1:8976/callback'

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The instance's callback when the catalog's servers accept it: over https, or on this machine's loopback. */
const reachable = (callbackUrl: URL) => callbackUrl.protocol === 'https:' || (callbackUrl.protocol === 'http:' && loopbackHosts.has(callbackUrl.hostname))

const toSummary = ({ plugin, slug, displayName, connectedAt }: PluginAccount): PluginAccountSummary => ({ plugin, slug, displayName, connectedAt })

const credentialKey = (plugin: string, slug: string) => `plugin:${plugin}:${slug}`

/** An account's OAuth state (client, tokens, discovery), sealed in `system_credentials` (ADR 0006). */
class AccountCredentials implements McpOAuthStateStore {
  readonly #sealed: SealedCredentials
  readonly #key: string

  /** `db` may be a transaction, e.g. one saving the account's row. */
  constructor(db: ConstructorParameters<typeof SealedCredentials>[0], box: SecretBox, plugin: string, slug: string) {
    this.#sealed = new SealedCredentials(db, box)
    this.#key = credentialKey(plugin, slug)
  }

  load(): Promise<McpOAuthState | undefined> {
    return this.#sealed.read(this.#key)
  }

  save(state: McpOAuthState): Promise<void> {
    return this.#sealed.write(this.#key, state)
  }

  delete(): Promise<void> {
    return this.#sealed.delete(this.#key)
  }
}

/** A sign-in waiting for the authorization response, from the callback route or a pasted URL. */
type PendingSignIn = { plugin: string; state: string; promptId?: string; respond(response: URLSearchParams): void }

/**
 * The owner's plugin accounts (design §5.5): OAuth sign-ins through `pi-mcp/oauth` (discovery, dynamic client
 * registration, PKCE) on the server, several accounts per plugin, each with a slug never given again, and their
 * tokens encrypted in `system_credentials`, never returned.
 */
export class PluginAccounts {
  readonly #db: Db
  readonly #box: SecretBox
  readonly #signIns = new Map<string, PendingSignIn>()
  /** New accounts are saved one at a time, so two sign-ins finishing together get different slugs. */
  #saving: Promise<unknown> = Promise.resolve()

  constructor({ db, box }: { db: Db; box: SecretBox }) {
    this.#db = db
    this.#box = box
  }

  /** Connected accounts, oldest first; of `plugin` only, when given. */
  async list(plugin?: string): Promise<PluginAccountSummary[]> {
    const rows = await this.#db
      .select()
      .from(pluginAccounts)
      .where(and(isNull(pluginAccounts.disconnectedAt), plugin === undefined ? undefined : eq(pluginAccounts.plugin, plugin)))
      .orderBy(asc(pluginAccounts.id))
    return rows.map(toSummary)
  }

  /**
   * Connects a new account of `plugin`, yielding each step for the wizard. The sign-in returns to `callbackUrl` (the
   * instance's callback route, as the owner's browser reaches it) when it is https or loopback; otherwise to a loopback
   * URL, and a `manual_code` prompt asks for the URL the browser ends on. Ending the iteration early (or aborting
   * `signal`) cancels the sign-in.
   */
  async *connect(plugin: ConnectablePlugin, callbackUrl: URL, signal?: AbortSignal): AsyncGenerator<SignInStep> {
    const signInId = crypto.randomUUID()
    const steps = stepQueue()
    const cancel = new AbortController()
    const onAbort = () => cancel.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort)

    steps.push({ type: 'started', signInId })
    this.#signIn(signInId, plugin, reachable(callbackUrl) ? callbackUrl.href : loopbackRedirect, steps.push, cancel.signal).then(
      () => steps.push({ type: 'connected' }),
      (error: unknown) => {
        if (!cancel.signal.aborted) steps.push({ type: 'failed', message: error instanceof Error ? error.message : String(error) })
      },
    ).finally(steps.close)

    try {
      yield* steps.drain()
    } finally {
      cancel.abort()
      signal?.removeEventListener('abort', onAbort)
      this.#signIns.delete(signInId)
    }
  }

  /** Answers the paste prompt of a running sign-in with the URL the owner's browser ended on. */
  answer(signInId: string, promptId: string, value: string) {
    const signIn = this.#signIns.get(signInId)
    if (!signIn || signIn.promptId !== promptId) throw new SignInNotFoundError(`No open prompt ${promptId} in sign-in ${signInId}`)
    let response: URLSearchParams
    try {
      response = new URL(value.trim()).searchParams
    } catch {
      throw new InvalidRedirectError('Paste the whole address the sign-in page ended on, starting with http')
    }
    if (response.get('state') !== signIn.state || (!response.get('code') && !response.get('error'))) {
      throw new InvalidRedirectError("That address isn't where this sign-in ended; paste the address from the last sign-in page")
    }
    signIn.respond(response)
  }

  /**
   * Completes the sign-in an authorization response returned to the callback route for; returns its plugin, or
   * undefined when no running sign-in has that state (it ended, or never was).
   */
  callback(response: URLSearchParams): string | undefined {
    const state = response.get('state')
    const signIn = state ? [...this.#signIns.values()].find((entry) => entry.state === state) : undefined
    signIn?.respond(response)
    return signIn?.plugin
  }

  async rename(plugin: string, slug: string, displayName: string): Promise<PluginAccountSummary> {
    const name = displayName.trim()
    if (!name) throw new InvalidAccountNameError('An account needs a name')
    const [account] = await this.#db
      .update(pluginAccounts)
      .set({ displayName: name })
      .where(and(eq(pluginAccounts.plugin, plugin), eq(pluginAccounts.slug, slug), isNull(pluginAccounts.disconnectedAt)))
      .returning()
    if (!account) throw new PluginAccountNotFoundError(`No ${plugin} account ${slug}`)
    return toSummary(account)
  }

  /** Deletes the account's tokens; its row stays, so its slug isn't given again. */
  async disconnect(plugin: string, slug: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const [account] = await tx
        .update(pluginAccounts)
        .set({ disconnectedAt: new Date() })
        .where(and(eq(pluginAccounts.plugin, plugin), eq(pluginAccounts.slug, slug), isNull(pluginAccounts.disconnectedAt)))
        .returning()
      if (!account) throw new PluginAccountNotFoundError(`No ${plugin} account ${slug}`)
      await new AccountCredentials(tx, this.#box, plugin, slug).delete()
    })
  }

  /** Signs in to `plugin`'s server through `redirectUrl`, then saves the new account with its tokens. */
  async #signIn(signInId: string, plugin: ConnectablePlugin, redirectUrl: string, push: (step: SignInStep) => void, signal: AbortSignal) {
    const store = new MemoryOAuthStateStore()
    let authorizationUrl: URL | undefined
    const provider = new McpOAuthProvider({
      serverUrl: plugin.serverUrl,
      redirectUrl,
      clientMetadata: { client_name: 'OpenBot' },
      store,
      onRedirect: (url) => void (authorizationUrl = url),
    })
    // Nothing is stored yet, so this registers a client and starts an authorization; it never refreshes.
    await authorizeMcp(provider, { serverUrl: plugin.serverUrl, signal })
    if (!authorizationUrl) throw new Error(`${plugin.displayName} didn't ask for a sign-in`)

    const state = store.load()?.oauthState
    if (!state) throw new Error(`The sign-in to ${plugin.displayName} has no state`)
    const promptId = redirectUrl === loopbackRedirect ? crypto.randomUUID() : undefined
    const response = new Promise<URLSearchParams>((resolve, reject) => {
      this.#signIns.set(signInId, { plugin: plugin.name, state, promptId, respond: resolve })
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    push({ type: 'auth_url', url: authorizationUrl.href, instructions: `Sign in to ${plugin.displayName} and allow OpenBot.` })
    if (promptId) {
      push({
        type: 'prompt',
        promptId,
        kind: 'manual_code',
        message: 'Paste the address the sign-in page ended on',
        placeholder: `${loopbackRedirect}?code=…`,
      })
    }
    const answer = await response
    this.#signIns.delete(signInId)

    const error = answer.get('error')
    if (error) throw new Error(`${plugin.displayName} didn't allow the sign-in: ${answer.get('error_description') || error}`)
    await authorizeMcp(provider, {
      serverUrl: plugin.serverUrl,
      authorizationCode: answer.get('code')!,
      iss: answer.get('iss') ?? undefined,
      signal,
    })
    // The client, tokens and discovery; the verifier and state were for this sign-in only.
    const { codeVerifier: _, oauthState: __, ...kept } = store.load()!
    const save = this.#saving.then(() =>
      this.#db.transaction(async (tx) => {
        // Every account ever connected, disconnected ones included: their rows stay so their slugs aren't given again.
        const [{ taken }] = (await tx.select({ taken: count() }).from(pluginAccounts).where(eq(pluginAccounts.plugin, plugin.name))) as [{ taken: number }]
        const number = taken + 1
        const slug = `account${number}`
        await tx.insert(pluginAccounts).values({ plugin: plugin.name, slug, displayName: `Account ${number}` })
        await new AccountCredentials(tx, this.#box, plugin.name, slug).save(kept)
      }),
    )
    this.#saving = save.catch(() => {})
    await save
  }
}
