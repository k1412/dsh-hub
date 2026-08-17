import { createHash } from 'node:crypto'
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

  it('pins the reproducible compatibility patch and every selected-target carrier', async () => {
    const snapshot = JSON.parse(await readFile(
      resolve(root, 'third_party/official-web/snapshot.json'), 'utf8',
    )) as { compatibilityPatchSha256: string }
    const patch = await readFile(resolve(root, 'third_party/official-web/hub-compat.patch'))
    expect(createHash('sha256').update(patch).digest('hex')).toBe(snapshot.compatibilityPatchSha256)

    const connection = await readFile(resolve(
      root,
      'third_party/official-web/dist/plugins/@deepseek-ai/dsh-client-connection/client.js',
    ), 'utf8')
    expect(connection).toContain('function withHubTarget(input)')
    expect(connection).toContain('return globalThis.fetch(withHubTarget(input), init)')
    expect(connection).toContain('const url = withHubTarget(new URL(path, this.resolveBase()))')
    expect(connection).toContain('withHubTarget(new URL(`${channel}/${endpoint}`, resolveBase()))')

    const agentPreset = await readFile(resolve(
      root,
      'third_party/official-web/dist/plugins/@deepseek-ai/dsh-client-ui-agent-preset/client.js',
    ), 'utf8')
    expect(agentPreset.match(/generation !== this\.generation/gu)?.length).toBeGreaterThanOrEqual(8)

    const settings = await readFile(resolve(
      root,
      'third_party/official-web/dist/plugins/@deepseek-ai/dsh-client-ui-settings/client.js',
    ), 'utf8')
    expect(settings).toContain('spec.browserLocal === true && !connection.isLoopback')
    expect(settings).toContain('`dsh.settings.${this.spec.namespace}`')

    for (const plugin of ['locale', 'ui-theme']) {
      const browserPreference = await readFile(resolve(
        root,
        `third_party/official-web/dist/plugins/@deepseek-ai/dsh-client-${plugin}/client.js`,
      ), 'utf8')
      expect(browserPreference).toContain('browserLocal: true')
    }

    const pluginInventory = await readFile(resolve(
      root,
      'third_party/official-web/dist/plugins/@deepseek-ai/dsh-client-ui-settings-plugin-inventory/client.js',
    ), 'utf8')
    expect(pluginInventory).toContain('subscribeTarget')
    expect(pluginInventory).toContain('ctx.on("connection/reset", listener)')
  })

  it('disables Zod code generation before exposing the immutable boot graph', () => {
    const script = renderBootScript({ rev: 'revision', entries: [] })
    expect(script.indexOf('jitless: true')).toBeLessThan(script.indexOf('window.__DSH_BOOT__'))
    expect(script).toContain('window.__DSH_BOOT__ = {"rev":"revision","entries":[]};')
  })
})
