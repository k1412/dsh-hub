import { describe, expect, it } from 'vitest'
// The production composer is plain ESM because it also runs directly under Node.
// @ts-expect-error — this focused test imports that intentionally untyped build script.
import { composeRows } from '../../../scripts/build-hub-web.mjs'

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
})
