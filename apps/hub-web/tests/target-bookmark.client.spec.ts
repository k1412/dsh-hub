// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { adoptLegacyHubTarget, fetchWithHubCompatibility } from '../src/target-bridge.ts'
import { readRuntimeTarget, replaceRuntimeTarget } from '../../../packages/hub/hub-client-ui/src/client/runtime-target.ts'
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); history.replaceState({}, '', '/') })
describe('one Hub page for legacy bookmarks and new selections', () => {
  it('imports a valid bookmark hint and retains unrelated navigation state', () => {
    history.replaceState({ panel: 'conversation' }, '', '/?nodeId=desktop-node&runtimeId=web&sessionId=hub-session-owned#message-7')
    adoptLegacyHubTarget()
    expect(location.search).toBe('?sessionId=hub-session-owned')
    expect(location.hash).toBe('#message-7'); expect(history.state).toEqual({ panel: 'conversation' })
    expect(readRuntimeTarget()).toEqual({ nodeId: 'desktop-node', runtimeId: 'web' })
    replaceRuntimeTarget({ nodeId: 'nas-node', runtimeId: 'default' })
    expect(location.search).toBe('?sessionId=hub-session-owned')
    expect(readRuntimeTarget()).toEqual({ nodeId: 'nas-node', runtimeId: 'default' })
  })
  it('drops invalid legacy hints without persisting them', () => {
    history.replaceState({}, '', '/?nodeId=bad%2Fnode&runtimeId=web'); adoptLegacyHubTarget()
    expect(location.search).toBe(''); expect(readRuntimeTarget()).toBeUndefined()
  })
})

describe('legacy Web notice on current node settings', () => {
  const target = '?nodeId=current-node&runtimeId=default'
  const description = new URL(`http://localhost/api/settings.describe${target}`)
  const mutation = new URL(`http://localhost/api/settings.mutate${target}`)
  function native(namespaces: unknown[]) { return Response.json({ type: 'server-response', rpcId: 'describe',
    result: { ok: true, value: { writable: true, hasDocument: true, namespaces } } }) }
  it('unblocks a missing namespace using only tab state, while preserving native settings', async () => {
    const fetchImpl = vi.fn(async () => native([{ ns: 'models', value: { unchanged: true } }]))
    const described = await fetchWithHubCompatibility(description, description, undefined, fetchImpl)
    const body = await described.json()
    expect(body.result.value.namespaces).toContainEqual({ ns: 'models', value: { unchanged: true } })
    expect(body.result.value.namespaces).toContainEqual(expect.objectContaining({ ns: 'ui-onboarding', value: {} }))
    const init = { method: 'POST', body: JSON.stringify({ rpcId: 'ack', payload: { ns: 'ui-onboarding',
      ops: [{ op: 'set', path: ['welcomeNoticeVersion'], value: '2026-08-13.1' }] } }) }
    const ack = await fetchWithHubCompatibility(mutation, mutation, init, fetchImpl)
    expect((await ack.json()).result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledOnce()
    const refreshed = await fetchWithHubCompatibility(description, description, undefined, fetchImpl)
    expect((await refreshed.json()).result.value.namespaces).toContainEqual(expect.objectContaining({
      ns: 'ui-onboarding', value: { welcomeNoticeVersion: '2026-08-13.1' },
    }))
  })
  it('keeps an existing native onboarding namespace and its mutations authoritative', async () => {
    const response = native([{ ns: 'ui-onboarding', value: { welcomeNoticeVersion: 'native' } }])
    const fetchImpl = vi.fn(async () => response)
    expect(await fetchWithHubCompatibility(description, description, undefined, fetchImpl)).toBe(response)
    await fetchWithHubCompatibility(mutation, mutation, { method: 'POST', body: '{}' }, fetchImpl)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('does not hide a failed node settings request', async () => {
    const response = Response.json({ result: { ok: false, error: { code: 'internal', message: 'node unavailable' } } })
    expect(await fetchWithHubCompatibility(description, description, undefined, async () => response)).toBe(response)
  })
})
