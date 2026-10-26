import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import type { SecretBox } from '@openbot/core'
import { type Db, systemCredentials } from '@openbot/db'
import { eq, like } from 'drizzle-orm'

const prefix = 'provider:'
const rowKey = (providerId: string) => `${prefix}${providerId}`

/**
 * pi-ai's credential store on the encrypted `system_credentials` table (ADR 0006). pi refreshes OAuth tokens
 * through `modify`, so refreshed tokens are persisted here. Writes are serialised per provider within this process,
 * which is the only one that opens the database.
 */
export class SystemCredentialStore implements CredentialStore {
  readonly #db: Db
  readonly #box: SecretBox
  readonly #chains = new Map<string, Promise<unknown>>()

  constructor(db: Db, box: SecretBox) {
    this.#db = db
    this.#box = box
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const key = rowKey(providerId)
    const [row] = await this.#db.select().from(systemCredentials).where(eq(systemCredentials.key, key))
    return row && this.#open(row)
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const rows = await this.#db.select().from(systemCredentials).where(like(systemCredentials.key, `${prefix}%`))
    return rows.flatMap((row) => {
      const credential = this.#open(row)
      return credential ? [{ providerId: row.key.slice(prefix.length), type: credential.type }] : []
    })
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.#serialise(providerId, async () => {
      options?.signal?.throwIfAborted()
      const current = await this.read(providerId)
      const next = await fn(current)
      if (next === undefined) return current
      const key = rowKey(providerId)
      const ciphertext = this.#box.seal(JSON.stringify(next), key)
      await this.#db
        .insert(systemCredentials)
        .values({ key, ciphertext })
        .onConflictDoUpdate({ target: systemCredentials.key, set: { ciphertext, updatedAt: new Date() } })
      return next
    })
  }

  delete(providerId: string): Promise<void> {
    return this.#serialise(providerId, async () => {
      await this.#db.delete(systemCredentials).where(eq(systemCredentials.key, rowKey(providerId)))
    })
  }

  /**
   * A credential that no longer opens (sealed under a lost `OPENBOT_SECRET_KEY`, or corrupt) is unusable, so it reads
   * as absent: the provider shows as disconnected and connecting it again overwrites the row.
   */
  #open(row: { key: string; ciphertext: string }): Credential | undefined {
    try {
      return JSON.parse(this.#box.open(row.ciphertext, row.key)) as Credential
    } catch (error) {
      console.warn(`Ignoring system credential ${row.key}: it can't be decrypted with the current secret key`, error)
      return undefined
    }
  }

  #serialise<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const result = (this.#chains.get(providerId) ?? Promise.resolve()).then(task)
    const settled = result.catch(() => {})
    this.#chains.set(providerId, settled)
    void settled.then(() => {
      if (this.#chains.get(providerId) === settled) this.#chains.delete(providerId)
    })
    return result
  }
}
