import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ModelSync, type ModelSyncCredentials, type ModelSyncSettings } from '../src/model-sync.ts'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function node(providers: Record<string, Record<string, unknown>>, initial: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'model-sync-')); roots.push(root)
  let revision = 0
  const values = new Map(Object.entries(initial)); let refuse = false
  const settings: ModelSyncSettings = { describe: () => [{ ns: 'llm-pi-ai', value: { providers: structuredClone(providers) }, revision }],
    update: async (_ns, patch, expected) => {
      if (refuse || expected !== revision) throw new Error('stale edit')
      Object.assign(providers, (patch as { providers: Record<string, Record<string, unknown>> }).providers); revision += 1
    } }
  const credentials: ModelSyncCredentials = { resolve: async ref => values.has(ref) ? { value: values.get(ref) as string } : undefined,
    set: async (ref, value) => { values.set(ref, value) }, unset: async ref => { values.delete(ref) } }
  return { sync: new ModelSync(settings, credentials, root), providers, values, root, refuse: () => { refuse = true } }
}
const profile = { displayName: 'Source', api: 'openai-completions', baseURL: 'https://models.example.com/v1',
  apiKeyEnv: 'SOURCE_API_KEY', models: [{ id: 'private-model-name', name: 'Private model', maxTokens: 2048 }] }
describe('node-owned model sync', () => {
  it('sends only sealed content to two distinct receivers and preserves their unrelated routes', async () => {
    const source = await node({ shared: profile }, { SOURCE_API_KEY: 'private-model-secret' })
    const targets = await Promise.all(['a', 'b'].map(route => node({ [route]: { models: [{ id: `${route}-local` }] } })))
    await Promise.all(targets.map(async (target, index) => {
      const recipient = target.sync.prepare(); const bundle = await source.sync.export(recipient)
      expect(JSON.stringify(bundle)).not.toContain('private-model-name'); expect(JSON.stringify(bundle)).not.toContain('private-model-secret')
      await expect(targets[1 - index]?.sync.apply({ bundle, replaceExisting: false })).rejects.toThrow('expired or already used')
      const receipt = await target.sync.apply({ bundle, replaceExisting: false })
      expect(receipt).toMatchObject({ providers: 1, models: 1, skipped: 0 })
      expect(target.providers.shared?.models).toEqual(profile.models)
      expect(Object.keys(target.providers)).toHaveLength(2)
      expect(target.values.get(target.providers.shared?.apiKeyEnv as string)).toBe('private-model-secret')
      expect((await stat(receipt.backup as string)).mode & 0o777).toBe(0o600)
      expect(JSON.parse(await readFile(receipt.backup as string, 'utf8')).previous.providers.shared).toBeUndefined()
      await expect(target.sync.apply({ bundle, replaceExisting: false })).rejects.toThrow('already used')
    }))
    expect(source.values.get('SOURCE_API_KEY')).toBe('private-model-secret')
  })
  it('skips conflicts by default and replaces the whole model list only when requested', async () => {
    const source = await node({ shared: profile }, { SOURCE_API_KEY: 'private-model-secret' })
    const target = await node({ shared: { models: [{ id: 'existing' }] } })
    const first = await source.sync.export(target.sync.prepare())
    await expect(target.sync.apply({ bundle: first, replaceExisting: false })).resolves.toEqual({ providers: 0, models: 0, skipped: 1 })
    expect(target.values.size).toBe(0)
    const second = await source.sync.export(target.sync.prepare())
    await target.sync.apply({ bundle: second, replaceExisting: true })
    expect(target.providers.shared?.models).toEqual(profile.models)
  })
  it('rejects tampering and restores credentials if the native configuration editor refuses the write', async () => {
    const source = await node({ shared: profile }, { SOURCE_API_KEY: 'private-model-secret' })
    const target = await node({ other: { models: [{ id: 'local' }] } })
    const bundle = await source.sync.export(target.sync.prepare())
    await expect(target.sync.apply({ bundle: { ...bundle, tag: Buffer.alloc(16).toString('base64') }, replaceExisting: false })).rejects.toThrow('authenticated')
    expect(target.values.size).toBe(0)
    target.refuse()
    const second = await source.sync.export(target.sync.prepare())
    await expect(target.sync.apply({ bundle: second, replaceExisting: false })).rejects.toThrow('configuration was preserved')
    expect(Object.keys(target.providers)).toEqual(['other']); expect(target.values.size).toBe(0)
  })
})
