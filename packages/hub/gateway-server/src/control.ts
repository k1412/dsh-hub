import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import type { ControlRPC } from '@k1412/dsh-gateway-transport'
export const capabilities = ['discover', 'task.start', 'task.read', 'task.cancel'] as const
export interface Grant { id: string; source: string; target: string; sourceRuntime: string; targetRuntime: string; workspace: string; capabilities: string[]; expiresAt: number }
export interface ControlPeer { control?: ControlRPC; capabilities: string[]; generation: string; runtimeId: string }
export class ControlRouter {
  private tasks = new Map<string, { grant: string; source: string; target: string; sourcePeer: ControlPeer; targetPeer: ControlPeer; sourceGeneration: string; targetGeneration: string; sourceRuntime: string; targetRuntime: string; input: Record<string, unknown>; expiresAt: number; renewAt: number; invalidated?: boolean }>()
  private reconciling = false
  async reconcile(): Promise<void> {
    if (this.reconciling) return
    this.reconciling = true
    try {
      await Promise.all([...this.tasks].map(async ([key, task]) => {
        const source = this.peers.get(task.source), target = this.peers.get(task.target)
        const authorized = !task.invalidated && source === task.sourcePeer && target === task.targetPeer
          && !!source?.control && !!target?.control
          && source.generation === task.sourceGeneration && target.generation === task.targetGeneration
          && source.runtimeId === task.sourceRuntime && target.runtimeId === task.targetRuntime
          && source.capabilities.includes('delegation') && target.capabilities.includes('delegation')
          && this.enabled(task.source) && this.enabled(task.target) && task.expiresAt > Date.now()
          && this.grants().some(g => g.id === task.grant && g.source === task.source && g.target === task.target
            && g.sourceRuntime === task.sourceRuntime && g.targetRuntime === task.targetRuntime
            && g.workspace === task.input.workspace && g.expiresAt > Date.now() && g.capabilities.includes('task.start'))
        if (!authorized) {
          task.invalidated = true
          // Never route an old task into a replacement authenticated generation.
          if (target === task.targetPeer && target?.generation === task.targetGeneration && target.runtimeId === task.targetRuntime) {
            try { await target.control?.call('task.cancel', task.input) } catch { /* local lease remains the backstop */ }
          }
          this.tasks.delete(key)
          return
        }
        if (performance.now() < task.renewAt) return
        task.renewAt = performance.now() + 10_000
        try {
          const result = await target.control?.call('task.renew', { ...task.input, authorizationLeaseMs: 30_000 })
          if (result && typeof result === 'object' && 'status' in result && ['completed','cancelled','failed','timed-out','interrupted'].includes(String(result.status))) this.tasks.delete(key)
        } catch { task.invalidated = true } // A failed renewal never restores authority.
      }))
    } finally { this.reconciling = false }
  }

  constructor(private grants: () => Grant[], private peers: Map<string, ControlPeer>, private enabled: (id: string) => boolean) {}
  async dispatch(source: string, generation: string, method: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const current = this.peers.get(source)
    if (!current?.control || !current.capabilities.includes('delegation') || current.generation !== generation || !this.enabled(source)) throw new Error('stale-source')
    const allowed = () => this.grants().filter(g => g.source === source && g.sourceRuntime === current.runtimeId && g.expiresAt > Date.now() && this.enabled(g.target))
    if (method === 'peer.discover') return allowed().filter(g => g.capabilities.includes('discover')).map(g => ({ nodeId: g.target, runtimeId: g.targetRuntime, workspace: g.workspace, capabilities: g.capabilities, online: !!this.peers.get(g.target)?.control }))
    if (!['task.start','task.read','task.cancel'].includes(method)) throw new Error('denied')
    const target = String(input.targetNode ?? ''), runtime = String(input.targetRuntime ?? '')
    const workspace = String(input.workspace ?? '')
    const grant = allowed().find(g => g.target === target && g.targetRuntime === runtime && g.workspace === workspace && g.capabilities.includes(method))
    const peer = this.peers.get(target)
    if (!grant || target === source || !peer?.control || !peer.capabilities.includes('delegation') || peer.runtimeId !== runtime) throw new Error('denied-or-unsupported')
    if (typeof input.sourceSession !== 'string' || !input.sourceSession || input.sourceSession.length > 256) throw new Error('source-session-required')
    const sourceRuntime = current.runtimeId, targetGeneration = peer.generation
    const valid = () => !signal.aborted && this.peers.get(source) === current && this.peers.get(target) === peer && current.generation === generation && current.runtimeId === sourceRuntime && peer.generation === targetGeneration && peer.runtimeId === runtime && allowed().some(g => g.id === grant.id && g.target === target && g.targetRuntime === runtime && g.workspace === workspace && g.capabilities.includes(method))
    if (!valid()) throw new Error('revoked')
    if (method === 'task.start' && this.tasks.size >= 4096) throw new Error('delegation-capacity')
    const forwarded = { sourceNode: source, sourceRuntime: current.runtimeId, sourceSession: input.sourceSession, targetRuntime: runtime, workspace, ...(method === 'task.start' ? { authorizationExpiresAt: grant.expiresAt, authorizationLeaseMs: 30_000, leaseAdmissionId: randomUUID() } : {}), requestId: input.requestId ?? randomUUID(), ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}), ...(typeof input.taskId === 'string' ? { taskId: input.taskId } : {}) }
    const result = await peer.control.call(method, forwarded)
    if (result && typeof result === 'object' && 'taskId' in result && typeof result.taskId === 'string') {
      const key = `${target}:${result.taskId}`
      if (method === 'task.start' && !this.tasks.has(key) && result && typeof result === 'object' && 'leaseAdmissionId' in result && result.leaseAdmissionId === forwarded.leaseAdmissionId) this.tasks.set(key, { grant: grant.id, source, target, sourcePeer: current, targetPeer: peer, sourceGeneration: generation, targetGeneration, sourceRuntime, targetRuntime: runtime, renewAt: performance.now() + 10_000, input: { sourceNode: source, sourceRuntime: current.runtimeId, sourceSession: input.sourceSession, targetRuntime: runtime, workspace, requestId: randomUUID(), taskId: result.taskId }, expiresAt: grant.expiresAt })
      if ('status' in result && ['completed','cancelled','failed','timed-out','interrupted'].includes(String(result.status))) this.tasks.delete(key)
    }
    if (!valid()) { await this.reconcile(); throw new Error('revoked') }
    return result
  }
}
