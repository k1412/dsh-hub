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
