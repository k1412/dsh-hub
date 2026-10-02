import { randomUUID } from 'node:crypto'
import type { ControlRPC } from '@k1412/dsh-gateway-transport'
export const capabilities = ['discover', 'task.start', 'task.read', 'task.cancel'] as const
export interface Grant { id: string; source: string; target: string; sourceRuntime: string; targetRuntime: string; workspace: string; capabilities: string[]; expiresAt: number }
export interface ControlPeer { control?: ControlRPC; capabilities: string[]; generation: string; runtimeId: string }
export class ControlRouter {
  private tasks = new Map<string, { grant: string; source: string; target: string; input: Record<string, unknown>; expiresAt: number }>()
  async reconcile(): Promise<void> {
    for (const [key, task] of this.tasks) {
      if (task.expiresAt > Date.now() && this.enabled(task.source) && this.enabled(task.target) && this.grants().some(g => g.id === task.grant)) continue
      const peer = this.peers.get(task.target)
      if (!peer?.control) continue
      try { await peer.control.call('task.cancel', task.input); this.tasks.delete(key) } catch { /* retry when target reconnects */ }
    }
  }

  constructor(private grants: () => Grant[], private peers: Map<string, ControlPeer>, private enabled: (id: string) => boolean) {}
  async dispatch(source: string, generation: string, method: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const current = this.peers.get(source)
    if (!current || !current.capabilities.includes('delegation') || current.generation !== generation || !this.enabled(source)) throw new Error('stale-source')
    const allowed = () => this.grants().filter(g => g.source === source && g.sourceRuntime === current.runtimeId && g.expiresAt > Date.now() && this.enabled(g.target))
    if (method === 'peer.discover') return allowed().filter(g => g.capabilities.includes('discover')).map(g => ({ nodeId: g.target, runtimeId: g.targetRuntime, workspace: g.workspace, capabilities: g.capabilities, online: !!this.peers.get(g.target)?.control }))
    if (!['task.start','task.read','task.cancel'].includes(method)) throw new Error('denied')
    const target = String(input.targetNode ?? ''), runtime = String(input.targetRuntime ?? '')
    const workspace = String(input.workspace ?? '')
    const grant = allowed().find(g => g.target === target && g.targetRuntime === runtime && g.workspace === workspace && g.capabilities.includes(method))
    const peer = this.peers.get(target)
    if (!grant || target === source || !peer?.control || !peer.capabilities.includes('delegation') || peer.runtimeId !== runtime) throw new Error('denied-or-unsupported')
    if (typeof input.sourceSession !== 'string' || !input.sourceSession || input.sourceSession.length > 256) throw new Error('source-session-required')
    const valid = () => !signal.aborted && this.peers.get(source) === current && this.peers.get(target) === peer && allowed().some(g => g.id === grant.id && g.capabilities.includes(method))
    if (!valid()) throw new Error('revoked')
    if (method === 'task.start' && this.tasks.size >= 4096) throw new Error('delegation-capacity')
    const forwarded = { sourceNode: source, sourceRuntime: current.runtimeId, sourceSession: input.sourceSession, targetRuntime: runtime, workspace, ...(method === 'task.start' ? { authorizationExpiresAt: grant.expiresAt } : {}), requestId: input.requestId ?? randomUUID(), ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}), ...(typeof input.taskId === 'string' ? { taskId: input.taskId } : {}) }
    const result = await peer.control.call(method, forwarded)
    if (result && typeof result === 'object' && 'taskId' in result && typeof result.taskId === 'string') {
      const key = `${target}:${result.taskId}`
      if (method === 'task.start') this.tasks.set(key, { grant: grant.id, source, target, input: { sourceNode: source, sourceRuntime: current.runtimeId, sourceSession: input.sourceSession, targetRuntime: runtime, workspace, requestId: randomUUID(), taskId: result.taskId }, expiresAt: grant.expiresAt })
      if ('status' in result && ['completed','cancelled','failed','timed-out','interrupted'].includes(String(result.status))) this.tasks.delete(key)
    }
    if (!valid()) { await this.reconcile(); throw new Error('revoked') }
    return result
  }
}
