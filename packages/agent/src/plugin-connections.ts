import { type CallToolResult, McpClient, StreamableHttpTransport, type Tool } from '@earendil-works/pi-mcp'
import { adaptOAuthProvider, McpOAuthProvider, type McpOAuthState, type McpOAuthStateStore } from '@earendil-works/pi-mcp/oauth'
import type { SecretBox } from '@openbot/core'
import type { Db } from '@openbot/db'
import { SealedCredentials } from './credential-store.ts'

const credentialKey = (plugin: string, slug: string) => `plugin:${plugin}:${slug}`

/** An account's OAuth state (client, tokens, discovery), sealed in `system_credentials` (ADR 0006). */
export class AccountCredentials implements McpOAuthStateStore {
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

/** A plugin account's MCP server: `<plugin>_<accountN>`, as its tools' names and audit entries name it. */
export const serverName = (plugin: string, slug: string) => `${plugin}_${slug}`

/** A plugin account, and the hosted MCP server its connection signs in to. */
export type AccountServer = { plugin: string; slug: string; serverUrl: string }

/** One live MCP client. */
type Connection = { client: McpClient }

/**
 * One MCP client per plugin account (design §5.5), shared by every bot granted it: connected on first use, signed in
 * with the account's stored tokens (refreshed when the server rejects them), and dropped once its connection closes
 * or a call fails short of an answer (the server restarted, the network went), so the next call connects again.
 */
export class PluginConnections {
  readonly #db: Db
  readonly #box: SecretBox
  readonly #connections = new Map<string, Promise<Connection>>()
  /** The tools each account's server listed when it last connected. */
  readonly #listed = new Map<string, Tool[]>()

  constructor({ db, box }: { db: Db; box: SecretBox }) {
    this.#db = db
    this.#box = box
  }

  /**
   * The tools the account's server listed when it last connected; it connects for them only the first time, so a
   * server that went away doesn't slow down every call of the bots granted it.
   */
  async tools(account: AccountServer): Promise<Tool[]> {
    const listed = this.#listed.get(serverName(account.plugin, account.slug))
    if (listed) return listed
    await this.#connection(account)
    return this.#listed.get(serverName(account.plugin, account.slug)) ?? []
  }

  async call(account: AccountServer, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const connection = this.#connection(account)
    try {
      return await (await connection).client.callTool(tool, args, { signal })
    } catch (error) {
      // MCP answers a tool's own failure in its result: this one never reached an answer. Unless the bot's run was
      // interrupted, the connection is suspect, and the next call connects anew.
      if (!signal?.aborted) await this.#drop(serverName(account.plugin, account.slug), connection)
      throw error
    }
  }

  /** Closes the account's connection and forgets its tools, e.g. once it is disconnected. */
  async close(plugin: string, slug: string): Promise<void> {
    const key = serverName(plugin, slug)
    this.#listed.delete(key)
    const connection = this.#connections.get(key)
    if (connection) await this.#drop(key, connection)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#connections].map(([key, connection]) => this.#drop(key, connection)))
  }

  #connection(account: AccountServer): Promise<Connection> {
    const key = serverName(account.plugin, account.slug)
    const existing = this.#connections.get(key)
    if (existing) return existing
    const connecting = this.#connect(account)
    this.#connections.set(key, connecting)
    const forget = () => {
      if (this.#connections.get(key) === connecting) this.#connections.delete(key)
    }
    connecting.then(({ client }) => client.onClose(forget), forget)
    return connecting
  }

  async #drop(key: string, connection: Promise<Connection>) {
    if (this.#connections.get(key) === connection) this.#connections.delete(key)
    await connection.then(({ client }) => client.close()).catch(() => {})
  }

  async #connect({ plugin, slug, serverUrl }: AccountServer): Promise<Connection> {
    const provider = new McpOAuthProvider({
      serverUrl,
      // Only a new sign-in redirects, and this connection never starts one: an account whose tokens can't be refreshed
      // must be connected again by the owner.
      redirectUrl: 'http://127.0.0.1:8976/callback',
      clientMetadata: { client_name: 'OpenBot' },
      store: new AccountCredentials(this.#db, this.#box, plugin, slug),
      onRedirect: () => {},
    })
    const client = new McpClient({ name: 'openbot', version: '1.0.0' })
    try {
      await client.connect(new StreamableHttpTransport({ url: serverUrl, authProvider: adaptOAuthProvider(provider), openGetStream: false }))
      this.#listed.set(serverName(plugin, slug), await client.listTools())
      return { client }
    } catch (error) {
      await client.close().catch(() => {})
      throw error
    }
  }
}
