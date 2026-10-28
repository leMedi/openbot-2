import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import type { SecretBox } from '@openbot/core'
import { type Db, systemCredentials } from '@openbot/db'
import { eq, like } from 'drizzle-orm'

/**
 * JSON values sealed in the `system_credentials` table (ADR 0006), each bound to its row key. A value that no longer
 * opens (sealed under a lost `OPENBOT_SECRET_KEY`, or corrupt) is unusable, so it reads as absent: whatever it was for
 * shows as disconnected, and connecting it again overwrites the row.
 */
export class SealedCredentials {
  readonly #db: Pick<Db, 'select' | 'insert' | 'delete'>
  readonly #box: SecretBox

  /** `db` may be a transaction, e.g. one saving an account's row with its tokens. */
  constructor(db: Pick<Db, 'select' | 'insert' | 'delete'>, box: SecretBox) {
    this.#db = db
    this.#box = box
  }

  async read<T>(key: string): Promise<T | undefined> {
    const [row] = await this.#db.select().from(systemCredentials).where(eq(systemCredentials.key, key))
    return row && this.#open<T>(row)
  }

  /** Every value whose key starts with `prefix`, that opens. */
  async list<T>(prefix: string): Promise<{ key: string; value: T }[]> {
    const rows = await this.#db.select().from(systemCredentials).where(like(systemCredentials.key, `${prefix}%`))
    return rows.flatMap((row) => {
      const value = this.#open<T>(row)
      return value === undefined ? [] : [{ key: row.key, value }]
    })
  }

  async write(key: string, value: unknown): Promise<void> {
    const ciphertext = this.#box.seal(JSON.stringify(value), key)
    await this.#db
      .insert(systemCredentials)
      .values({ key, ciphertext })
      .onConflictDoUpdate({ target: systemCredentials.key, set: { ciphertext, updatedAt: new Date() } })
  }

  async delete(key: string): Promise<void> {
    await this.#db.delete(systemCredentials).where(eq(systemCredentials.key, key))
  }

  #open<T>(row: { key: string; ciphertext: string }): T | undefined {
    try {
      return JSON.parse(this.#box.open(row.ciphertext, row.key)) as T
    } catch (error) {
      console.warn(`Ignoring system credential ${row.key}: it can't be decrypted with the current secret key`, error)
      return undefined
    }
  }
}

const prefix = 'provider:'
const rowKey = (providerId: string) => `${prefix}${providerId}`

/**
 * pi-ai's credential store on the encrypted `system_credentials` table (ADR 0006). pi refreshes OAuth tokens
 * through `modify`, so refreshed tokens are persisted here. Writes are serialised per provider within this process,
 * which is the only one that opens the database.
 */
export class SystemCredentialStore implements CredentialStore {
  readonly #sealed: SealedCredentials
  readonly #chains = new Map<string, Promise<unknown>>()

  constructor(db: Db, box: SecretBox) {
    this.#sealed = new SealedCredentials(db, box)
  }

  read(providerId: string): Promise<Credential | undefined> {
    return this.#sealed.read<Credential>(rowKey(providerId))
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return (await this.#sealed.list<Credential>(prefix)).map(({ key, value }) => ({ providerId: key.slice(prefix.length), type: value.type }))
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
      await this.#sealed.write(rowKey(providerId), next)
      return next
    })
  }

  delete(providerId: string): Promise<void> {
    return this.#serialise(providerId, () => this.#sealed.delete(rowKey(providerId)))
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
