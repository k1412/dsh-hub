import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// Production assembly stays plain ESM so it can run directly under Node.
// @ts-expect-error -- the intentionally untyped build script exposes this helper.
import { renderBootScript } from '../../../scripts/build-hub-web.mjs'

const root = resolve(import.meta.dirname, '..', '..', '..')

describe('reviewed official Web snapshot', () => {
  it('contains one unique browser bundle for every reviewed official entry', async () => {
    const snapshot = JSON.parse(await readFile(resolve(root, 'third_party/official-web/snapshot.json'), 'utf8')) as {
      entries: Array<{ id: string }>
    }
    expect(snapshot.entries).toHaveLength(38)
    expect(new Set(snapshot.entries.map(entry => entry.id)).size).toBe(snapshot.entries.length)
    expect(snapshot.entries.at(-1)?.id).toBe('@deepseek-ai/dsh-client-ui-directory-picker-browse')
    for (const entry of snapshot.entries) {
      expect(entry.id).toMatch(/^@deepseek-ai\/dsh-/)
      await expect(readFile(resolve(root, 'third_party/official-web/dist/plugins', entry.id, 'client.js')))
        .resolves.not.toHaveLength(0)
    }
  })

  it('keeps Hub code outside the official snapshot', async () => {
    await expect(readFile(resolve(
      root,
      'third_party/official-web/dist/plugins/@k1412/dsh-hub-client-ui/client.js',
    ))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('disables Zod code generation before exposing the immutable boot graph', () => {
    const script = renderBootScript({ rev: 'revision', entries: [] })
    expect(script.indexOf('jitless: true')).toBeLessThan(script.indexOf('window.__DSH_BOOT__'))
    expect(script).toContain('window.__DSH_BOOT__ = {"rev":"revision","entries":[]};')
  })
})
