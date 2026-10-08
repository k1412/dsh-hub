// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client.ts'

const cleanups: Array<() => void> = []
afterEach(() => { for (const close of cleanups.splice(0)) close(); document.body.replaceChildren(); vi.unstubAllGlobals() })
function fixture(archived = false, archiveAfterRetain = false) {
  vi.stubGlobal('location', new URL('https://node.invalid/?gatewayIntent=owned'))
  vi.stubGlobal('history', { replaceState: vi.fn() })
  const intent = { nodeId: 'node', runtimeId: 'runtime', generation: 'generation', sessionId: 'target' }
  const row = { id: 'target', retainedBy: {} as Record<string, number> }
  const store = <T>(get: () => T) => ({ getSnapshot: get, subscribe: () => () => {} })
  const release = vi.fn(), retain = vi.fn(() => ({ ready: Promise.resolve(), release }))
  const openSession = vi.fn(() => { row.retainedBy.mainView = 1 })
  let reads = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (++reads === 2 && archiveAfterRetain) archived = true
    return { ok: true, json: async () => intent }
  }))
  apply({ connection: { generation: store(() => ({ id: 1 })) }, sessions: {
    list: store(() => ({ phase:'ready',ids:['target'],byId:{target:row} })), refresh:async()=>{}, subagentAddress:()=>undefined, retain,
  }, workspaces: { list: store(() => ({ phase:'ready',archivedSessionIds:archived?['target']:[] })) },
    layout: { beginNavigation: () => new AbortController().signal }, uiWorkspace: { openSession },
    effect: callback => { cleanups.push(callback()) },
  })
  return { retain, release, openSession }
}
it('rejects an archived session before retention or native view selection', async () => {
  const f = fixture(true)
  await vi.waitFor(() => expect(document.querySelector('#gateway-session-intent')?.getAttribute('data-state')).toBe('error'))
  expect(document.body.textContent).toContain('This session is archived. Restore it')
  expect(f.retain).not.toHaveBeenCalled(); expect(f.openSession).not.toHaveBeenCalled()
})
it('rechecks a session archived during history loading without opening or changing it', async () => {
  const f = fixture(false, true)
  await vi.waitFor(() => expect(document.querySelector('#gateway-session-intent')?.getAttribute('data-state')).toBe('error'))
  expect(document.body.textContent).toContain('The archive has not been changed')
  expect(f.retain).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce(); expect(f.openSession).not.toHaveBeenCalled()
})
it('still opens the exact unarchived target through the native API', async () => {
  const f = fixture()
  await vi.waitFor(() => expect(document.querySelector('#gateway-session-intent')?.getAttribute('data-state')).toBe('opened'))
  expect(f.openSession).toHaveBeenCalledWith('target'); expect(f.release).toHaveBeenCalledOnce()
})
