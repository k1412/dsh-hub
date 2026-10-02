import { describe, it, expect } from 'vitest'
import { ControlRouter, type Grant, type ControlPeer } from '../src/control.ts'
import type { ControlRPC } from '@k1412/dsh-gateway-transport'
describe('directional control routing', () => {
  it('binds simultaneous targets, runtime, source generation, session and rechecks revocation after response', async () => {
    let grants: Grant[] = []
    const received: unknown[] = []
    let release: (() => void) | undefined
    const peers = new Map<string, ControlPeer>(['a','b','c'].map(id => [id, { generation: id, capabilities: ['management','delegation'], runtimeId: id, control: { call: async (_method: string, input: unknown) => { received.push({ id, input }); if (id === 'c') await new Promise<void>(r => { release = r }); return id } } as unknown as ControlRPC }]))
    const router = new ControlRouter(() => grants, peers, () => true)
    const dispatch = (target: string) => router.dispatch('a','a','task.start',{ targetNode: target,targetRuntime:target,workspace:'/delegated',sourceSession:'session-a',prompt:'hello',requestId:'request1' },new AbortController().signal)
    await expect(dispatch('b')).rejects.toThrow()
    grants = ['b','c'].map(target => ({ id:target,source:'a',sourceRuntime:'a',target,targetRuntime:target,workspace:'/delegated',capabilities:['discover','task.start'],expiresAt:Date.now()+10000 }))
    expect(await dispatch('b')).toBe('b')
    const inflight = dispatch('c'); grants = grants.filter(g => g.target !== 'c'); release!()
    await expect(inflight).rejects.toThrow('revoked')
    expect(received).toMatchObject([{id:'b',input:{sourceNode:'a',sourceRuntime:'a',sourceSession:'session-a',targetRuntime:'b'}},{id:'c',input:{targetRuntime:'c'}}])
    await expect(router.dispatch('b','b','task.read',{targetNode:'a'},new AbortController().signal)).rejects.toThrow()
    await expect(router.dispatch('a','old','peer.discover',{},new AbortController().signal)).rejects.toThrow('stale')
    grants[0]!.expiresAt = 0; expect(await router.dispatch('a','a','peer.discover',{},new AbortController().signal)).toEqual([])
  })
})

describe('generation-bound authorization renewal', () => {
  async function setup() {
    const calls: { target: string; method: string; input: Record<string, unknown> }[] = []
    const grants: Grant[] = ['b', 'c'].map(target => ({ id: target, source: 'a', target, sourceRuntime: 'a', targetRuntime: target, workspace: '/work', capabilities: ['task.start'], expiresAt: Date.now() + 600_000 }))
    const peers = new Map<string, ControlPeer>(['a','b','c'].map(id => [id, { generation: id, runtimeId: id, capabilities: ['delegation'], control: { call: async (method: string, input: Record<string, unknown>) => { calls.push({ target: id, method, input }); return { taskId: id, status: 'running', leaseAdmissionId: input.leaseAdmissionId } } } as unknown as ControlRPC }]))
    const router = new ControlRouter(() => grants, peers, () => true)
    for (const target of ['b', 'c']) await router.dispatch('a', 'a', 'task.start', { targetNode: target, targetRuntime: target, workspace: '/work', sourceSession: 'session', prompt: 'wait' }, new AbortController().signal)
    return { calls, grants, peers, router }
  }
  it('renews every ten seconds, isolates simultaneous targets and keeps renew internal', async () => {
    const { calls, grants, router } = await setup()
    expect(calls.every(call => call.input.authorizationLeaseMs === 30_000)).toBe(true)
    await router.reconcile(); expect(calls).toHaveLength(2)
    // Exercise the scheduler deterministically without waiting ten seconds.
    for (const task of (router as unknown as { tasks: Map<string, { renewAt: number }> }).tasks.values()) task.renewAt = 0
    grants[0]!.capabilities = []
    await router.reconcile()
    expect(calls.slice(2).map(call => [call.target, call.method])).toEqual([['b', 'task.cancel'], ['c', 'task.renew']])
    await router.reconcile(); expect(calls).toHaveLength(4)
    await expect(router.dispatch('a', 'a', 'task.renew', {}, new AbortController().signal)).rejects.toThrow('denied')
  })
  it.each(['source-disconnect', 'source-generation', 'target-generation', 'target-runtime', 'revocation'] as const)('stops renewal on %s', async (change) => {
    const { calls, grants, peers, router } = await setup()
    if (change === 'source-disconnect') peers.delete('a')
    if (change === 'source-generation') peers.set('a', { ...peers.get('a')!, generation: 'new' })
    if (change === 'target-generation') peers.set('b', { ...peers.get('b')!, generation: 'new' })
    if (change === 'target-runtime') peers.get('b')!.runtimeId = 'replacement'
    if (change === 'revocation') grants.splice(0)
    for (const task of (router as unknown as { tasks: Map<string, { renewAt: number }> }).tasks.values()) task.renewAt = 0
    await router.reconcile()
    expect(calls.slice(2).filter(call => call.target === 'b' && call.method === 'task.renew')).toEqual([])
    if (change.startsWith('target-')) expect(calls.slice(2).filter(call => call.target === 'b')).toEqual([])
  })
  it('does not adopt a replayed task after Hub restart', async () => {
    const { calls, grants, peers } = await setup()
    peers.get('b')!.control = { call: async () => ({ taskId: 'b', status: 'running', leaseAdmissionId: 'original-admission' }) } as unknown as ControlRPC
    const restarted = new ControlRouter(() => grants, peers, () => true)
    await restarted.dispatch('a', 'a', 'task.start', { targetNode: 'b', targetRuntime: 'b', workspace: '/work', sourceSession: 'session', prompt: 'wait' }, new AbortController().signal)
    expect((restarted as unknown as { tasks: Map<string, unknown> }).tasks.size).toBe(0)
    expect(calls).toHaveLength(2)
  })
})
