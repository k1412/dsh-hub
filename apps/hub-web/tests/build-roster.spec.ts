import { describe, expect, it } from 'vitest'
// The production composer is plain ESM because it also runs directly under Node.
// @ts-expect-error — this focused test imports that intentionally untyped build script.
import { composeRows, HUB_CLIENT_ROWS, renderBootScript } from '../../../scripts/build-hub-web.mjs'

describe('Hub official Web client roster', () => {
  it('applies official Cordis insert and update rows without inventing a second roster format', () => {
    expect(composeRows([
      [{ insert: [{ id: 'runtime', name: '@deepseek-ai/runtime' }, { id: 'settings', name: '@deepseek-ai/settings' }] }],
      [{ id: 'settings', disabled: true }],
    ])).toEqual([
      { id: 'runtime', name: '@deepseek-ai/runtime' },
      { id: 'settings', name: '@deepseek-ai/settings', disabled: true },
    ])
  })

  it('fails when an official patch refers to a row that was never inserted', () => {
    expect(() => { composeRows([[{ id: 'missing', disabled: true }]]) }).toThrow(/unknown row missing/)
  })

  it('disables Zod code generation before exposing the official boot graph', () => {
    const script = renderBootScript({ rev: 'revision', entries: [] })
    expect(script.indexOf('jitless: true')).toBeLessThan(script.indexOf('window.__DSH_BOOT__'))
    expect(script).toContain('window.__DSH_BOOT__ = {"rev":"revision","entries":[]};')
  })

  it('mounts the browser directory flow and Hub controls beside the official roster', () => {
    expect(HUB_CLIENT_ROWS).toEqual([
      {
        id: 'hub-directory-picker-browse',
        name: '@deepseek-ai/dsh-client-ui-directory-picker-browse',
      },
      { id: 'hub-client-ui', name: '@k1412/dsh-hub-client-ui' },
    ])
    expect(HUB_CLIENT_ROWS.some(row => row.name.endsWith('-directory-picker-native'))).toBe(false)
  })
})
