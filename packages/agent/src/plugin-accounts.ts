import { type JsonObject, Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-durable'
import { type Tool, toLlmContent } from '@earendil-works/pi-mcp'
import { authorizeMcp, McpOAuthProvider, MemoryOAuthStateStore } from '@earendil-works/pi-mcp/oauth'
import type { SecretBox } from '@openbot/core'
import { type Db, type PluginAccount, pluginAccounts, pluginGrants } from '@openbot/db'
import { and, asc, count, eq, isNull } from 'drizzle-orm'
import { AccountCredentials, type AccountServer, PluginConnections, serverName } from './plugin-connections.ts'
import type { BotTool } from './runtime.ts'
import { SignInNotFoundError, type SignInStep, stepQueue } from './sign-in.ts'

/** A connected account of a plugin, as Settings → Plugins lists it, with the bots granted it. Never carries its tokens. */
export type PluginAccountSummary = { plugin: string; slug: string; displayName: string; connectedAt: Date; grantedTo: string[] }

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

/** The account of a grant without one: a plugin of skills only, granted as (bot, plugin, none). */
const noAccount = ''

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The instance's callback when the catalog's servers accept it: over https, or on this machine's loopback. */
const reachable = (callbackUrl: URL) => callbackUrl.protocol === 'https:' || (callbackUrl.protocol === 'http:' && loopbackHosts.has(callbackUrl.hostname))

const toSummary = ({ plugin, slug, displayName, connectedAt }: PluginAccount, grantedTo: string[]): PluginAccountSummary => ({
  plugin,
  slug,
  displayName,
  connectedAt,
  grantedTo,
})

/** The prefix of an account's tools' names: `mcp__<plugin>_<accountN>__`. */
const toolPrefix = (plugin: string, slug: string) => `mcp__${serverName(plugin, slug)}__`

/** Providers allow tool names of at most 64 characters of `[A-Za-z0-9_-]`. */
const toolName = (plugin: string, slug: string, tool: string) => `${toolPrefix(plugin, slug)}${tool.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64)

/** How bots and notes name an account: its plugin's display name, then its own, e.g. "Notion (Work)". */
const accountLabel = (plugin: { displayName: string }, displayName: string) => `${plugin.displayName} (${displayName})`

/** What each bot granted a disconnected account reads in its history, e.g. "Notion (Work) was disconnected". */
export const disconnectedNote = (plugin: { displayName: string }, account: { plugin: string; slug: string; displayName: string }) =>
  `[${accountLabel(plugin, account.displayName)} was disconnected by the owner: its tools (${toolPrefix(account.plugin, account.slug)}…) are gone.]`

/** An account's tool as a bot calls it: `mcp__<plugin>_<accountN>__<tool>`, under the `mcp` surface. */
function pluginTool(connections: PluginConnections, account: AccountServer, label: string, tool: Tool): BotTool {
  return {
    surface: 'mcp',
    server: serverName(account.plugin, account.slug),
    tool: defineTool({
      name: toolName(account.plugin, account.slug, tool.name),
      description: `${label}: ${tool.description ?? tool.title ?? tool.name}`,
      // Providers require an object schema, and some reject one without `properties`.
      parameters: Type.Unsafe<JsonObject>({ ...tool.inputSchema, type: 'object', properties: tool.inputSchema.properties ?? {} }),
      execute: async (args, _api, context) => {
        const result = await connections.call(account, tool.name, args, context.abortSignal)
        // MCP reports a tool's failure in its result, not as an error.
        return { output: toLlmContent(result), isError: result.isError === true }
      },
    }),
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
  /** The catalog's plugins bots can call, by name. */
  readonly #plugins: Map<string, ConnectablePlugin>
  readonly #connections: PluginConnections
  readonly #signIns = new Map<string, PendingSignIn>()
  /** New accounts are saved one at a time, so two sign-ins finishing together get different slugs. */
  #saving: Promise<unknown> = Promise.resolve()

  constructor({ db, box, plugins = [] }: { db: Db; box: SecretBox; plugins?: readonly ConnectablePlugin[] }) {
    this.#db = db
    this.#box = box
    this.#plugins = new Map(plugins.map((plugin) => [plugin.name, plugin]))
    this.#connections = new PluginConnections({ db, box })
  }

  /** Connected accounts, oldest first, with the bots granted each; of `plugin` only, when given. */
  async list(plugin?: string): Promise<PluginAccountSummary[]> {
    const rows = await this.#db
      .select()
      .from(pluginAccounts)
      .where(and(isNull(pluginAccounts.disconnectedAt), plugin === undefined ? undefined : eq(pluginAccounts.plugin, plugin)))
      .orderBy(asc(pluginAccounts.id))
    const grants = await this.#db
      .select()
      .from(pluginGrants)
      .where(plugin === undefined ? undefined : eq(pluginGrants.plugin, plugin))
      .orderBy(asc(pluginGrants.id))
    return rows.map((row) =>
      toSummary(
        row,
        grants.filter((grant) => grant.plugin === row.plugin && grant.account === row.slug).map((grant) => grant.botId),
      ),
    )
  }

  /** Lets bot `botId` use the connected account; granting it again changes nothing. Returns the account. */
  async grant(botId: string, plugin: string, slug: string): Promise<PluginAccountSummary> {
    await this.#mustBeConnected(plugin, slug)
    await this.#db.insert(pluginGrants).values({ botId, plugin, account: slug }).onConflictDoNothing()
    return this.#summary(plugin, slug)
  }

  /** Takes the account back from bot `botId`, from its next call; a call in flight finishes. Returns the account. */
  async revoke(botId: string, plugin: string, slug: string): Promise<PluginAccountSummary> {
    await this.#mustBeConnected(plugin, slug)
    await this.#db
      .delete(pluginGrants)
      .where(and(eq(pluginGrants.botId, botId), eq(pluginGrants.plugin, plugin), eq(pluginGrants.account, slug)))
    return this.#summary(plugin, slug)
  }

  /** Lets bot `botId` use `plugin`, one of skills only, without an account; granting it again changes nothing. */
  async grantSkills(botId: string, plugin: string): Promise<void> {
    await this.#db.insert(pluginGrants).values({ botId, plugin, account: noAccount }).onConflictDoNothing()
  }

  /** Takes `plugin`, granted without an account, back from bot `botId`. */
  async revokeSkills(botId: string, plugin: string): Promise<void> {
    await this.#db
      .delete(pluginGrants)
      .where(and(eq(pluginGrants.botId, botId), eq(pluginGrants.plugin, plugin), eq(pluginGrants.account, noAccount)))
  }

  /** The bots granted each plugin without an account, oldest grant first, by plugin; of `plugin` only, when given. */
  async grantedWithoutAccount(plugin?: string): Promise<Map<string, string[]>> {
    const grants = await this.#db
      .select()
      .from(pluginGrants)
      .where(and(eq(pluginGrants.account, noAccount), plugin === undefined ? undefined : eq(pluginGrants.plugin, plugin)))
      .orderBy(asc(pluginGrants.id))
    const byPlugin = new Map<string, string[]>()
    for (const grant of grants) byPlugin.set(grant.plugin, [...(byPlugin.get(grant.plugin) ?? []), grant.botId])
    return byPlugin
  }

  /** The plugins bot `botId` holds a grant to, with an account or without, in the order first granted. */
  async grantedPlugins(botId: string): Promise<string[]> {
    const grants = await this.#db.select({ plugin: pluginGrants.plugin }).from(pluginGrants).where(eq(pluginGrants.botId, botId)).orderBy(asc(pluginGrants.id))
    return [...new Set(grants.map((grant) => grant.plugin))]
  }

  /**
   * The tools of every account bot `botId` is granted, each `mcp__<plugin>_<accountN>__<tool>`, as its server listed them
   * when it last connected (connecting it the first time). A tool whose name another took, once cut to fit, is left out.
   */
  async botTools(botId: string): Promise<BotTool[]> {
    const granted = await this.#db
      .select({ plugin: pluginAccounts.plugin, slug: pluginAccounts.slug, displayName: pluginAccounts.displayName })
      .from(pluginGrants)
      .innerJoin(pluginAccounts, and(eq(pluginAccounts.plugin, pluginGrants.plugin), eq(pluginAccounts.slug, pluginGrants.account)))
      .where(and(eq(pluginGrants.botId, botId), isNull(pluginAccounts.disconnectedAt)))
      .orderBy(asc(pluginGrants.id))
    const tools = await Promise.all(
      granted.map(async ({ plugin: name, slug, displayName }) => {
        const plugin = this.#plugins.get(name)
        // A plugin gone from the catalog with a release.
        if (!plugin) return []
        const account = { plugin: name, slug, serverUrl: plugin.serverUrl }
        const label = accountLabel(plugin, displayName)
        try {
          return (await this.#connections.tools(account)).map((tool) => pluginTool(this.#connections, account, label, tool))
        } catch (error) {
          console.error(`[plugins] Couldn't list the tools of ${label}:`, error)
          return []
        }
      }),
    )
    const names = new Set<string>()
    return tools.flat().filter(({ tool }) => !names.has(tool.name) && names.add(tool.name))
  }

  /** Closes every account's connection; when the server stops. */
  close(): Promise<void> {
    return this.#connections.closeAll()
  }

  async #mustBeConnected(plugin: string, slug: string): Promise<void> {
    const [account] = await this.#db
      .select({ id: pluginAccounts.id })
      .from(pluginAccounts)
      .where(and(eq(pluginAccounts.plugin, plugin), eq(pluginAccounts.slug, slug), isNull(pluginAccounts.disconnectedAt)))
    if (!account) throw new PluginAccountNotFoundError(`No ${plugin} account ${slug}`)
  }

  /** The connected account, as `list` gives it. */
  async #summary(plugin: string, slug: string): Promise<PluginAccountSummary> {
    const account = (await this.list(plugin)).find((summary) => summary.slug === slug)
    if (!account) throw new PluginAccountNotFoundError(`No ${plugin} account ${slug}`)
    return account
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
    return this.#summary(plugin, slug)
  }

  /**
   * Deletes the account's tokens and every grant to it, and closes its connection; its row stays, so its slug isn't
   * given again. Returns it as it was, with the bots that were granted it.
   */
  async disconnect(plugin: string, slug: string): Promise<PluginAccountSummary> {
    // First, so no call through it refreshes its tokens back after they are deleted.
    await this.#connections.close(plugin, slug)
    return this.#db.transaction(async (tx) => {
      const [account] = await tx
        .update(pluginAccounts)
        .set({ disconnectedAt: new Date() })
        .where(and(eq(pluginAccounts.plugin, plugin), eq(pluginAccounts.slug, slug), isNull(pluginAccounts.disconnectedAt)))
        .returning()
      if (!account) throw new PluginAccountNotFoundError(`No ${plugin} account ${slug}`)
      await new AccountCredentials(tx, this.#box, plugin, slug).delete()
      const grants = await tx
        .delete(pluginGrants)
        .where(and(eq(pluginGrants.plugin, plugin), eq(pluginGrants.account, slug)))
        .returning()
      return toSummary(account, grants.map((grant) => grant.botId))
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
