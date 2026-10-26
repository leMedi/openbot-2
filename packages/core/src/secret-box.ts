import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM encryption under a key derived from `OPENBOT_SECRET_KEY`, for system credentials (and later the vault).
 * Each value is bound to `context` (e.g. its row key), so a sealed value moved to another row fails to open.
 */
export class SecretBox {
  readonly #key: Buffer

  constructor(secret: string) {
    if (!secret) throw new Error('A secret key is required')
    this.#key = Buffer.from(hkdfSync('sha256', secret, 'openbot', 'secret-box v1', 32))
  }

  /** `v1.<iv>.<tag>.<ciphertext>`, base64url. */
  seal(plaintext: string, context: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv).setAAD(Buffer.from(context))
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return ['v1', iv, cipher.getAuthTag(), ciphertext].map((part) => (typeof part === 'string' ? part : part.toString('base64url'))).join('.')
  }

  /** Throws if `sealed` was tampered with, sealed under another key, or for another context. */
  open(sealed: string, context: string): string {
    const [version, iv, tag, ciphertext] = sealed.split('.')
    if (version !== 'v1' || !iv || !tag || ciphertext === undefined) throw new Error('Unrecognised sealed value')
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64url'))
      .setAAD(Buffer.from(context))
      .setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8')
  }
}
