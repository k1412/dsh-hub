/** Node-only provider transfer. Plaintext never leaves either DSH Context. */
import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { modelSyncBundleSchema, modelSyncRecipientSchema } from '@k1412/dsh-hub-capabilities'

interface SettingsEntry { ns: string; value: unknown; revision: number }
export interface ModelSyncSettings {
  describe(): SettingsEntry[]
  update(ns: string, patch: unknown, revision?: number): Promise<void>
  mutate?(ns: string, ops: Array<{ op: 'set'; path: string[]; value: unknown }>, revision?: number): Promise<void>
}
export interface ModelSyncCredentials {
  resolve(ref: string): Promise<{ value: string } | undefined>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
  readRecord?(key: string): Promise<{ kind: string; key?: string } | undefined>
}
type Recipient = z.infer<typeof modelSyncRecipientSchema>
type Bundle = z.infer<typeof modelSyncBundleSchema>
const namespace = 'llm-pi-ai'
const profileSchema = z.record(z.string(), z.json())
const plaintextSchema = z.strictObject({ version: z.literal(1), providers: z.record(z.string().min(1).max(128),
  z.strictObject({ profile: profileSchema, credential: z.string().min(1).max(65_536).optional() })) })
const ttl = 120_000
function pub(key: KeyObject): string { return key.export({ type: 'spki', format: 'der' }).toString('base64') }
function keyOf(privateKey: KeyObject, publicKey: string, transferId: string): Buffer {
  const other = createPublicKey({ key: Buffer.from(publicKey, 'base64'), type: 'spki', format: 'der' })
  if (other.asymmetricKeyType !== 'x25519') throw new Error('model transfer requires X25519')
  const shared = diffieHellman({ privateKey, publicKey: other })
  try { return Buffer.from(hkdfSync('sha256', shared, transferId, 'dsh-model-sync-v1', 32)) }
  finally { shared.fill(0) }
}
function aad(recipient: Recipient): Buffer { return Buffer.from(JSON.stringify(recipient)) }

/** Short-lived, one-use receiver keys and a serialized node-local configuration writer. */
export class ModelSync {
  private readonly receivers = new Map<string, { recipient: Recipient; privateKey: KeyObject; timeout: NodeJS.Timeout }>()
  private writing = Promise.resolve()
  public constructor(private readonly settings: ModelSyncSettings, private readonly credentials: ModelSyncCredentials,
    private readonly backupRoot: string, private readonly now = Date.now) {}

  public prepare(): Recipient {
    for (const [id, row] of this.receivers) if (row.recipient.expiresAt <= this.now()) this.cancel(id)
    if (this.receivers.size >= 16) throw new Error('too many model transfers')
    const pair = generateKeyPairSync('x25519')
    const recipient = { transferId: randomBytes(18).toString('base64url'), publicKey: pub(pair.publicKey), expiresAt: this.now() + ttl }
    const timeout = setTimeout(() => this.cancel(recipient.transferId), ttl); timeout.unref()
    this.receivers.set(recipient.transferId, { recipient, privateKey: pair.privateKey, timeout })
    return recipient
  }
  public cancel(transferId: string): { ok: true } {
    const row = this.receivers.get(transferId); if (row !== undefined) clearTimeout(row.timeout)
    this.receivers.delete(transferId); return { ok: true }
  }
  public close(): void { for (const id of this.receivers.keys()) this.cancel(id) }

  public async export(input: Recipient): Promise<Bundle> {
    const recipient = modelSyncRecipientSchema.parse(input)
    if (recipient.expiresAt <= this.now() || recipient.expiresAt > this.now() + ttl + 5_000) throw new Error('model transfer expired')
    const entry = this.settings.describe().find(row => row.ns === namespace)
    const profiles = (entry?.value as { providers?: Record<string, Record<string, unknown>> } | undefined)?.providers
    if (profiles === undefined || Object.keys(profiles).length === 0) throw new Error('source has no configurable pi-ai providers')
    const providers: z.infer<typeof plaintextSchema>['providers'] = {}
    for (const [route, raw] of Object.entries(profiles)) {
      const profile = profileSchema.parse(raw)
      let credential: string | undefined
      if (typeof profile.apiKeyEnv === 'string') {
        credential = (await this.credentials.resolve(profile.apiKeyEnv))?.value
        if (credential === undefined) throw new Error('source model credential is unavailable')
      } else {
        const record = /^[a-z][a-z0-9-]*$/.test(route) ? await this.credentials.readRecord?.(`${namespace}/${route}`) : undefined
        if (record !== undefined && record.kind !== 'api-key') throw new Error('device login grants require signing in on the target node')
        credential = record?.key
      }
      providers[route] = { profile, ...(credential === undefined ? {} : { credential }) }
    }
    const clear = Buffer.from(JSON.stringify(plaintextSchema.parse({ version: 1, providers })))
    if (clear.length > 1_000_000) { clear.fill(0); throw new Error('model transfer exceeds size limit') }
    const pair = generateKeyPairSync('x25519')
    const key = keyOf(pair.privateKey, recipient.publicKey, recipient.transferId)
    try {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad(recipient))
      const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()])
      return { ...recipient, senderKey: pub(pair.publicKey), nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
    } finally { key.fill(0); clear.fill(0) }
  }

  public apply(input: { bundle: Bundle; replaceExisting: boolean }): Promise<{ providers: number; models: number; skipped: number; backup?: string }> {
    const task = this.writing.then(() => this.applyOnce(input))
    this.writing = task.then(() => undefined, () => undefined)
    return task
  }
  private async applyOnce(input: { bundle: Bundle; replaceExisting: boolean }): Promise<{ providers: number; models: number; skipped: number; backup?: string }> {
    const bundle = modelSyncBundleSchema.parse(input.bundle)
    const receiver = this.receivers.get(bundle.transferId)
    this.cancel(bundle.transferId)
    if (receiver === undefined || receiver.recipient.expiresAt <= this.now()
      || bundle.publicKey !== receiver.recipient.publicKey || bundle.expiresAt !== receiver.recipient.expiresAt) throw new Error('model transfer expired or already used')
    const key = keyOf(receiver.privateKey, bundle.senderKey, bundle.transferId)
    let decoded: z.infer<typeof plaintextSchema>
    try {
      const nonce = Buffer.from(bundle.nonce, 'base64'); const tag = Buffer.from(bundle.tag, 'base64')
      if (nonce.length !== 12 || tag.length !== 16) throw new Error('invalid model transfer')
      const decipher = createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAAD(aad(receiver.recipient)); decipher.setAuthTag(tag)
      const clear = Buffer.concat([decipher.update(Buffer.from(bundle.ciphertext, 'base64')), decipher.final()])
      try { decoded = plaintextSchema.parse(JSON.parse(clear.toString('utf8'))) } finally { clear.fill(0) }
    } catch { throw new Error('model transfer could not be authenticated') }
    finally { key.fill(0) }
    const entry = this.settings.describe().find(row => row.ns === namespace)
    if (entry === undefined) throw new Error('target needs the pi-ai provider plugin')
    const existing = (entry.value as { providers?: Record<string, Record<string, unknown>> }).providers ?? {}
    const patch: Record<string, Record<string, unknown>> = {}
    const oldCredentials: Record<string, string | null> = {}
    const values: Record<string, string> = {}
    let models = 0; let skipped = 0
    for (const [route, row] of Object.entries(decoded.providers)) {
      if (['__proto__', 'constructor', 'prototype'].includes(route)) throw new Error('invalid provider route')
      const prior = existing[route]
      if (prior !== undefined && !input.replaceExisting) { skipped += 1; continue }
      const profile = structuredClone(row.profile)
      if (row.credential !== undefined) {
        const ref = `DSH_MODEL_SYNC_${createHash('sha256').update(route).digest('hex').slice(0, 24).toUpperCase()}`
        profile.apiKeyEnv = ref; values[ref] = row.credential
        oldCredentials[ref] = (await this.credentials.resolve(ref))?.value ?? null
      } else if (profile.apiKeyEnv !== undefined) throw new Error('model credential missing from transfer')
      patch[route] = profile
      models += Array.isArray(profile.models) ? profile.models.length : 0
    }
    const count = Object.keys(patch).length
    if (count === 0) return { providers: 0, models: 0, skipped }
    await mkdir(this.backupRoot, { recursive: true, mode: 0o700 })
    const backup = join(this.backupRoot, `${this.now()}-${bundle.transferId}.json`)
    await writeFile(backup, JSON.stringify({ namespace, previous: entry.value, credentials: oldCredentials }), { mode: 0o600, flag: 'wx' })
    const written: string[] = []
    try {
      for (const [ref, value] of Object.entries(values)) { await this.credentials.set(ref, value); written.push(ref) }
      if (this.settings.mutate !== undefined) await this.settings.mutate(namespace,
        Object.entries(patch).map(([route, value]) => ({ op: 'set', path: ['providers', route], value })), entry.revision)
      else await this.settings.update(namespace, { providers: patch }, entry.revision)
    } catch {
      for (const ref of written) {
        if ((await this.credentials.resolve(ref))?.value !== values[ref]) continue
        const before = oldCredentials[ref]
        if (before == null) await this.credentials.unset(ref)
        else await this.credentials.set(ref, before)
      }
      throw new Error('model sync was refused; target configuration was preserved')
    }
    // The native adapter applies this namespace live. Existing Session selections stay local.
    return { providers: count, models, skipped, backup }
  }
}
