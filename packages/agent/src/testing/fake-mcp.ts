import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** A tool the fake MCP server offers; `call` answers it in text. */
export type FakeMcpTool = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  call?(args: Record<string, unknown>): string | Promise<string>
}

/** A client registered through the fake authorization server's dynamic client registration. */
export type FakeOAuthClient = { clientId: string; redirectUris: string[]; applicationType: string | undefined; clientName: string | undefined }

/** A tool call the fake MCP server answered, with the account (access token's user) it was made as. */
export type FakeMcpCall = { tool: string; args: Record<string, unknown>; user: string }

export type FakeMcpServer = {
  /** The hosted MCP server's URL, as a plugin's `.mcp.json` lists it. */
  url: string
  /** Clients registered so far. */
  clients: FakeOAuthClient[]
  /** Every access and refresh token issued so far, e.g. to check none reaches the API. */
  issuedTokens: string[]
  /** Tool calls answered so far. */
  calls: FakeMcpCall[]
  /**
   * Plays the owner's browser on the authorization URL: signs in as `user` (the account) and approves, or denies with
   * `deny`; returns the URL the browser ends on, the client's redirect URI with the code (or error) and state.
   */
  authorize(authorizationUrl: string, options?: { user?: string; deny?: boolean }): Promise<string>
  close(): Promise<void>
}

type Code = { clientId: string; redirectUri: string; challenge: string; user: string }

/**
 * A hosted MCP server (Streamable HTTP, JSON responses) behind its own OAuth authorization server (discovery, dynamic
 * client registration, PKCE, refresh tokens), in process over real HTTP on 127.0.0.1, as Notion's or Linear's are.
 */
export async function startFakeMcpServer({ tools = [] }: { tools?: FakeMcpTool[] } = {}): Promise<FakeMcpServer> {
  const clients: FakeOAuthClient[] = []
  const issuedTokens: string[] = []
  const calls: FakeMcpCall[] = []
  const codes = new Map<string, Code>()
  const accessTokens = new Map<string, string>()
  const refreshTokens = new Map<string, { clientId: string; user: string }>()
  let origin = ''

  function issue(clientId: string, user: string) {
    const access = `fake-access-${randomBytes(12).toString('hex')}`
    const refresh = `fake-refresh-${randomBytes(12).toString('hex')}`
    accessTokens.set(access, user)
    refreshTokens.set(refresh, { clientId, user })
    issuedTokens.push(access, refresh)
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600 }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', origin)
    const body = await new Promise<string>((resolve) => {
      let text = ''
      req.on('data', (chunk) => (text += chunk))
      req.on('end', () => resolve(text))
    })
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
      res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(value))

    switch (url.pathname) {
      case '/.well-known/oauth-protected-resource/mcp':
        return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] })
      case '/.well-known/oauth-authorization-server':
        return json(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        })
      case '/register': {
        const metadata = JSON.parse(body) as { redirect_uris?: string[]; application_type?: string; client_name?: string }
        const clientId = `client-${clients.length + 1}`
        clients.push({ clientId, redirectUris: metadata.redirect_uris ?? [], applicationType: metadata.application_type, clientName: metadata.client_name })
        return json(201, { ...metadata, client_id: clientId, token_endpoint_auth_method: 'none' })
      }
      case '/authorize': {
        const client = clients.find((entry) => entry.clientId === url.searchParams.get('client_id'))
        const redirectUri = url.searchParams.get('redirect_uri') ?? ''
        if (!client || !client.redirectUris.includes(redirectUri)) return json(400, { error: 'invalid_request' })
        const back = new URL(redirectUri)
        const state = url.searchParams.get('state')
        if (state) back.searchParams.set('state', state)
        if (url.searchParams.get('deny')) {
          back.searchParams.set('error', 'access_denied')
        } else {
          const code = `code-${randomBytes(8).toString('hex')}`
          codes.set(code, { clientId: client.clientId, redirectUri, challenge: url.searchParams.get('code_challenge') ?? '', user: url.searchParams.get('user') ?? 'owner' })
          back.searchParams.set('code', code)
        }
        return res.writeHead(302, { location: back.href }).end()
      }
      case '/token': {
        const params = new URLSearchParams(body)
        if (params.get('grant_type') === 'authorization_code') {
          const code = codes.get(params.get('code') ?? '')
          codes.delete(params.get('code') ?? '')
          const challenge = createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url')
          if (!code || code.clientId !== params.get('client_id') || code.redirectUri !== params.get('redirect_uri') || code.challenge !== challenge) {
            return json(400, { error: 'invalid_grant' })
          }
          return json(200, issue(code.clientId, code.user))
        }
        if (params.get('grant_type') === 'refresh_token') {
          const grant = refreshTokens.get(params.get('refresh_token') ?? '')
          if (!grant || grant.clientId !== params.get('client_id')) return json(400, { error: 'invalid_grant' })
          refreshTokens.delete(params.get('refresh_token')!)
          return json(200, issue(grant.clientId, grant.user))
        }
        return json(400, { error: 'unsupported_grant_type' })
      }
      case '/mcp': {
        const user = accessTokens.get(req.headers.authorization?.replace(/^Bearer /, '') ?? '')
        if (!user) {
          return json(401, { error: 'invalid_token' }, {
            'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          })
        }
        if (req.method !== 'POST') return res.writeHead(405).end()
        const message = JSON.parse(body) as { id?: number | string; method: string; params?: Record<string, unknown> }
        if (message.id === undefined) return res.writeHead(202).end()
        const reply = (result: unknown) => json(200, { jsonrpc: '2.0', id: message.id, result })
        switch (message.method) {
          case 'initialize':
            return reply({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1.0.0' } })
          case 'ping':
            return reply({})
          case 'tools/list':
            return reply({
              tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema: inputSchema ?? { type: 'object', properties: {} } })),
            })
          case 'tools/call': {
            const name = String(message.params?.name)
            const args = (message.params?.arguments ?? {}) as Record<string, unknown>
            const tool = tools.find((entry) => entry.name === name)
            if (!tool) return json(200, { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool ${name}` } })
            calls.push({ tool: name, args, user })
            return reply({ content: [{ type: 'text', text: (await tool.call?.(args)) ?? '' }] })
          }
          default:
            return json(200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } })
        }
      }
      default:
        return json(404, { error: 'not_found' })
    }
  }

  const http = createServer((req, res) => void handle(req, res).catch((error) => res.writeHead(500).end(String(error))))
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`

  return {
    url: `${origin}/mcp`,
    clients,
    issuedTokens,
    calls,
    async authorize(authorizationUrl, { user = 'owner', deny = false } = {}) {
      const url = new URL(authorizationUrl)
      url.searchParams.set('user', user)
      if (deny) url.searchParams.set('deny', '1')
      const response = await fetch(url, { redirect: 'manual' })
      const location = response.headers.get('location')
      if (response.status !== 302 || !location) throw new Error(`The sign-in page answered ${response.status}: ${await response.text()}`)
      return location
    },
    close: () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve())
        http.closeAllConnections()
      }),
  }
}
