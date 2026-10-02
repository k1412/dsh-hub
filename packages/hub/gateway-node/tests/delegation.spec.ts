import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDelegation, delegationLimits, type DelegationContext, type DelegationTool } from '../src/delegation.ts'

type TestAgent = Awaited<ReturnType<DelegationContext['agents']['create']>>['agent']
type Event = { type: string; data: unknown }
type Result = { taskId: string; status: string; result: string }
const roots: string[] = []
const closers: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closers.splice(0)) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(runtimeId = 'runtime-b') {
  const root = await mkdtemp(join(tmpdir(), 'delegation-test-')); roots.push(root)
  const tools = new Map<string, DelegationTool>()
  const jobs = new Map<string, { finish(text?: string, reason?: string): void; agent: TestAgent; events: Event[] }>()
  const ctx: DelegationContext = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => { tools.delete(tool.name) } } },
    agents: { create: vi.fn(async (options) => {
      let resolve!: () => void
      const idle = new Promise<void>((done) => { resolve = done })
      const events: Event[] = []
      const job = { events, agent: undefined as unknown as TestAgent, finish(text = 'real answer', reason = 'completed') {
        events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text }] } } }, { type: 'turn/end', data: { reason: { kind: reason } } }); resolve()
      } }
      const agent = { id: options.sessionId, session: { header: options.meta }, send: vi.fn(), cancel: vi.fn(() => job.finish('partial', 'aborted')), whenIdle: () => idle }
      job.agent = agent; jobs.set(options.sessionId, job)
      return { agent, dispose: vi.fn(async () => {}) }
    }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'target-provider', model: 'target-model' }) },
    sessions: { flush: vi.fn(async () => true) },
    sessionController: { inspect: vi.fn(async (id) => ({ events: jobs.get(id)?.events ?? [] })) },
  }
  const call = vi.fn(async (_method: string, _input: Record<string, unknown>): Promise<unknown> => ({ ok: true }))
  const options = { stateDirectory: join(root, 'state'), workspace: root, runtimeId, call }
  const native = await createDelegation(ctx, options); closers.push(native.close)
  const adapter = { ...native, handle: (method: string, input: Record<string, unknown>) => native.handle(method, input) as Promise<Result> }
  const input = { sourceNode: 'node-a', sourceRuntime: 'runtime-a', sourceSession: 'session-a', targetRuntime: runtimeId, workspace: root, requestId: 'req-1', prompt: 'do work', authorizationLeaseMs: 30_000 }
  const read = (taskId: string, overrides = {}) => { const { prompt: _, authorizationLeaseMs: _lease, ...owner } = input; return adapter.handle('task.read', { ...owner, taskId, ...overrides }) }
  return { root, tools, ctx, adapter, input, read, jobs, options, call }
}

describe('native delegation adapter', () => {
  it('uses target model, independent native session, trusted execution identity and registered tool contracts', async () => {
    const f = await fixture()
    expect([...f.tools.keys()]).toEqual(['peer_discover', 'peer_task_start', 'peer_task_read', 'peer_task_cancel'])
    const tool = f.tools.get('peer_task_start')!
    const args = { targetNode: 'node-b', targetRuntime: 'runtime-b', workspace: f.root, requestId: 'req', prompt: 'hello' }
    const exec = { agent: { id: 'trusted-session', session: { header: {} } } as TestAgent, signal: new AbortController().signal }
    await tool.execute(args, exec)
    expect(f.call).toHaveBeenCalledWith('task.start', { ...args, sourceRuntime: 'runtime-b', sourceSession: 'trusted-session' })
    await expect(tool.execute({ ...args, sourceSession: 'forged' }, exec)).rejects.toThrow('Unsupported')
    await expect(tool.execute(args, { signal: exec.signal })).rejects.toThrow('trusted')
    const task: Result = await f.adapter.handle('task.start', f.input)
    const created = vi.mocked(f.ctx.agents.create).mock.calls[0]![0]
    expect(created.agentOptions).toEqual({ provider: 'target-provider', model: 'target-model', maxTokens: 8192 })
    expect(created.meta).toEqual({ cwd: f.root, origin: 'subagent', delegationDepth: 1 })
    expect(created.sessionId).not.toBe(f.input.sourceSession)
    const job = f.jobs.get(created.sessionId)!
    await expect(tool.execute(args, { agent: job.agent, signal: exec.signal })).rejects.toThrow('Recursive')
    job.finish('actual result')
    await vi.waitFor(async () => expect(await f.read(task.taskId)).toMatchObject({ status: 'completed', result: 'actual result', truncated: false }))
    expect(f.ctx.sessions.flush).toHaveBeenCalledOnce()
    expect(JSON.stringify(await f.read(task.taskId))).not.toContain('private reasoning')
  })

  it('binds ownership across simultaneous nodes/runtimes and serializes identical start requests', async () => {
    const f = await fixture()
    const tasks: Result[] = await Promise.all([f.adapter.handle('task.start', f.input), f.adapter.handle('task.start', f.input), f.adapter.handle('task.start', { ...f.input, sourceNode: 'node-c', sourceRuntime: 'runtime-c' })])
    expect(tasks[0].taskId).toBe(tasks[1].taskId)
    expect(tasks[0].taskId).not.toBe(tasks[2].taskId)
    expect(f.ctx.agents.create).toHaveBeenCalledTimes(2)
    for (const key of ['sourceNode', 'sourceRuntime', 'sourceSession']) await expect(f.read(tasks[0].taskId, { [key]: 'other' })).rejects.toThrow('owner')
    await expect(f.read(tasks[0].taskId, { targetRuntime: 'other' })).rejects.toThrow('Runtime mismatch')
    await expect(f.adapter.handle('task.start', { ...f.input, prompt: 'changed' })).rejects.toThrow('conflicts')
    const jobs = [...f.jobs.values()]; jobs[0]!.finish('node a result'); jobs[1]!.finish('node c result')
    await vi.waitFor(async () => expect(await f.read(tasks[0].taskId)).toMatchObject({ status: 'completed', result: 'node a result' }))
    expect(await f.read(tasks[2].taskId, { sourceNode: 'node-c', sourceRuntime: 'runtime-c' })).toMatchObject({ result: 'node c result' })
  })

  it('isolates simultaneous target Runtime instances and rejects cross-target task reads', async () => {
    const b = await fixture('runtime-b')
    const c = await fixture('runtime-c')
    const [taskB, taskC] = await Promise.all([b.adapter.handle('task.start', b.input), c.adapter.handle('task.start', c.input)])
    expect(taskB.taskId).not.toBe(taskC.taskId)
    expect([...b.jobs.keys()][0]).not.toBe([...c.jobs.keys()][0])
    ;[...b.jobs.values()][0]!.finish('B owns this result')
    ;[...c.jobs.values()][0]!.finish('C owns this result')
    await vi.waitFor(async () => {
      expect(await b.read(taskB.taskId)).toMatchObject({ status: 'completed', result: 'B owns this result' })
      expect(await c.read(taskC.taskId)).toMatchObject({ status: 'completed', result: 'C owns this result' })
    })
    await expect(b.read(taskC.taskId)).rejects.toThrow('owner')
    await expect(c.read(taskB.taskId)).rejects.toThrow('owner')
    await expect(b.adapter.handle('task.start', { ...b.input, targetRuntime: 'runtime-c' })).rejects.toThrow('Runtime mismatch')
  })

  it('enforces explicit canonical workspace and rejects config/model injection', async () => {
    const f = await fixture()
    await expect(f.adapter.handle('task.start', { ...f.input, workspace: '/tmp' })).rejects.toThrow('workspace policy')
    await expect(f.adapter.handle('task.start', { ...f.input, workspace: '.' })).rejects.toThrow('workspace policy')
    for (const key of ['model', 'provider', 'config', 'sessionId']) await expect(f.adapter.handle('task.start', { ...f.input, [key]: 'injected' })).rejects.toThrow('Unsupported')
    const alias = join(f.root, 'alias'); await symlink(f.root, alias)
    const task: Result = await f.adapter.handle('task.start', { ...f.input, workspace: alias })
    expect(await f.read(task.taskId)).toMatchObject({ taskId: task.taskId })
  })

  it('bounds concurrency, prompts and actual result text; cancel remains owner-bound', async () => {
    const f = await fixture()
    await expect(f.adapter.handle('task.start', { ...f.input, prompt: 'x'.repeat(delegationLimits.promptChars + 1) })).rejects.toThrow('prompt')
    const tasks: Result[] = []
    for (let n = 0; n < delegationLimits.active; n++) tasks.push(await f.adapter.handle('task.start', { ...f.input, requestId: String(n) }))
    await expect(f.adapter.handle('task.start', f.input)).rejects.toThrow('limit')
    const { prompt: _, authorizationLeaseMs: _lease, ...owner } = f.input
    await expect(f.adapter.handle('task.cancel', { ...owner, taskId: tasks[0].taskId, sourceSession: 'other' })).rejects.toThrow('owner')
    expect(await f.adapter.handle('task.cancel', { ...owner, taskId: tasks[0].taskId })).toMatchObject({ cancelRequested: true })
    await vi.waitFor(async () => expect(await f.read(tasks[0].taskId)).toMatchObject({ status: 'cancelled' }))
    ;[...f.jobs.values()][1]!.finish('x'.repeat(delegationLimits.resultChars + 10))
    await vi.waitFor(async () => expect(await f.read(tasks[1].taskId)).toMatchObject({ status: 'completed', truncated: true }))
    expect((await f.read(tasks[1].taskId) as Result).result.length).toBe(delegationLimits.resultChars)
  })

  it('persists idempotency across restart without re-running tasks and fails closed on corrupt state', async () => {
    const f = await fixture()
    const task: Result = await f.adapter.handle('task.start', f.input)
    ;[...f.jobs.values()][0]!.finish('persisted result')
    await vi.waitFor(async () => expect(await f.read(task.taskId)).toMatchObject({ status: 'completed' }))
    await f.adapter.close()
    expect(f.tools.size).toBe(0)
    const second = await createDelegation(f.ctx, f.options); closers.push(second.close)
    expect(await second.handle('task.start', f.input)).toMatchObject({ taskId: task.taskId, status: 'completed', result: 'persisted result' })
    expect(f.ctx.agents.create).toHaveBeenCalledOnce()
    await second.close()
    const path = join(f.options.stateDirectory, (await readdir(f.options.stateDirectory))[0]!)
    const state = JSON.parse(await readFile(path, 'utf8')); state.tasks[0].status = 'running'
    await writeFile(path, JSON.stringify(state))
    const third = await createDelegation(f.ctx, f.options); closers.push(third.close)
    expect(await third.handle('task.start', f.input)).toMatchObject({ status: 'interrupted' })
    expect(f.ctx.agents.create).toHaveBeenCalledOnce()
    await third.close(); await writeFile(path, '{}')
    await expect(createDelegation(f.ctx, f.options)).rejects.toThrow('metadata')
  })

  it('rejects unsupported runtime services and redacts native failure details', async () => {
    const f = await fixture()
    await expect(createDelegation({ ...f.ctx, agents: {} } as unknown as DelegationContext, f.options)).rejects.toThrow('rc.2')
    vi.mocked(f.ctx.agents.create).mockRejectedValueOnce(new Error('secret-api-key=do-not-leak'))
    expect(await f.adapter.handle('task.start', f.input)).toMatchObject({ status: 'failed', result: '' })
    expect(JSON.stringify(await f.adapter.handle('task.start', f.input))).not.toContain('secret')
    await expect(f.adapter.handle('task.fake', f.input)).rejects.toThrow('Unsupported')
    await f.adapter.close()
    await expect(f.adapter.handle('task.start', f.input)).rejects.toThrow('closed')
  })
})

describe('local authorization lease and retained tasks', () => {
  it('requires a bounded lease and never registers renewal or cleanup as model tools', async () => {
    const f = await fixture()
    for (const authorizationLeaseMs of [undefined, 0, -1, 30_001, Infinity, NaN, '30000']) {
      await expect(f.adapter.handle('task.start', { ...f.input, authorizationLeaseMs })).rejects.toThrow('lease')
    }
    expect([...f.tools.keys()]).not.toContain('task.renew')
    expect([...f.tools.keys()]).not.toContain('task.cleanup')
  })

  it('expires independently of long grant and wall clock and exposes cooperative pending cancellation', async () => {
    const f = await fixture()
    const task = await f.adapter.handle('task.start', { ...f.input, authorizationLeaseMs: 50, authorizationExpiresAt: Date.now() + 600_000 })
    const job = [...f.jobs.values()][0]!
    vi.mocked(job.agent.cancel).mockImplementation(() => {})
    const now = vi.spyOn(Date, 'now').mockReturnValue(0)
    try {
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(await f.read(task.taskId)).toMatchObject({ status: 'running', cancelRequested: true, cancellationReason: 'authorization-lease-expired' })
      const { prompt: _, ...owner } = f.input
      delete (owner as Partial<typeof owner>).authorizationLeaseMs
      await f.adapter.handle('task.renew', { ...owner, taskId: task.taskId, authorizationLeaseMs: 30_000 })
      expect(job.agent.send).toHaveBeenCalledOnce()
      job.finish('partial', 'aborted')
      await vi.waitFor(async () => expect(await f.read(task.taskId)).toMatchObject({ status: 'cancelled', cancellationReason: 'authorization-lease-expired' }))
    } finally { now.mockRestore(); job.finish() }
  })

  it('renews a live lease without replaying the prompt and rejects cross-owner renewal', async () => {
    const f = await fixture()
    const task = await f.adapter.handle('task.start', { ...f.input, authorizationLeaseMs: 100 })
    const { prompt: _, ...owner } = f.input
    await expect(f.adapter.handle('task.renew', { ...owner, taskId: task.taskId, sourceSession: 'wrong' })).rejects.toThrow('owner')
    await f.adapter.handle('task.renew', { ...owner, taskId: task.taskId, authorizationLeaseMs: 250 })
    await new Promise(resolve => setTimeout(resolve, 130))
    expect(await f.read(task.taskId)).toMatchObject({ status: 'running' })
    expect([...f.jobs.values()][0]!.agent.send).toHaveBeenCalledOnce()
    await vi.waitFor(async () => expect(await f.read(task.taskId)).toMatchObject({ status: 'cancelled', cancellationReason: 'authorization-lease-expired' }))
  })

  it('cleans only terminal tasks older than the immutable replay window and automatically reclaims seven-day records', async () => {
    const f = await fixture()
    const first = await f.adapter.handle('task.start', f.input)
    ;[...f.jobs.values()][0]!.finish()
    await vi.waitFor(async () => expect(await f.read(first.taskId)).toMatchObject({ status: 'completed' }))
    await f.adapter.close()
    const path = join(f.options.stateDirectory, (await readdir(f.options.stateDirectory)).find(name => name.endsWith('.json'))!)
    const state = JSON.parse(await readFile(path, 'utf8'))
    const old = { ...state.tasks[0], taskId: 'old', requestId: 'old', terminalAt: new Date(Date.now() - 8 * 86400_000).toISOString() }
    const dayOld = { ...state.tasks[0], taskId: 'day-old', requestId: 'day-old', terminalAt: new Date(Date.now() - 2 * 86400_000).toISOString() }
    state.tasks.push(old, dayOld)
    await writeFile(path, JSON.stringify(state))
    const next = await createDelegation(f.ctx, f.options); closers.push(next.close)
    const running = await next.handle('task.start', { ...f.input, requestId: 'active' }) as Result
    expect(await next.handle('task.cleanup', {})).toMatchObject({ removed: 0, retained: 3, active: 1 })
    await expect(next.handle('task.cleanup', { retentionMs: delegationLimits.minimumRetentionMs - 1 })).rejects.toThrow('retention')
    expect(await next.handle('task.cleanup', { retentionMs: delegationLimits.minimumRetentionMs })).toMatchObject({ removed: 1, retained: 2, active: 1 })
    expect(await next.handle('task.start', f.input)).toMatchObject({ taskId: first.taskId, status: 'completed' })
    expect(await next.handle('task.start', { ...f.input, requestId: 'active' })).toMatchObject({ taskId: running.taskId, status: 'running' })
    expect(f.ctx.agents.create).toHaveBeenCalledTimes(2)
  })
})


it('reclaims full retained capacity only after terminal replay retention expires', async () => {
  const f = await fixture()
  const task = await f.adapter.handle('task.start', f.input)
  ;[...f.jobs.values()][0]!.finish()
  await vi.waitFor(async () => expect(await f.read(task.taskId)).toMatchObject({ status: 'completed' }))
  await f.adapter.close()
  const path = join(f.options.stateDirectory, (await readdir(f.options.stateDirectory)).find(name => name.endsWith('.json'))!)
  const state = JSON.parse(await readFile(path, 'utf8'))
  state.tasks = Array.from({ length: delegationLimits.retained }, (_, index) => ({ ...state.tasks[0], taskId: `retained-${index}`, requestId: `retained-${index}` }))
  await writeFile(path, JSON.stringify(state))
  const full = await createDelegation(f.ctx, f.options); closers.push(full.close)
  await expect(full.handle('task.start', f.input)).rejects.toThrow('limit')
  expect(await full.handle('task.cleanup', { retentionMs: delegationLimits.minimumRetentionMs })).toMatchObject({ removed: 0, retained: 256 })
  await full.close()
  state.tasks[0].terminalAt = new Date(Date.now() - delegationLimits.retentionMs - 1000).toISOString()
  await writeFile(path, JSON.stringify(state))
  const available = await createDelegation(f.ctx, f.options); closers.push(available.close)
  expect(await available.handle('task.start', f.input)).toMatchObject({ status: 'running' })
  expect(await available.handle('task.cleanup', {})).toMatchObject({ removed: 0, retained: 256, active: 1 })
})

it('does not send a prompt when native admission outlasts its lease', async () => {
  const f = await fixture()
  const create = f.ctx.agents.create
  vi.mocked(f.ctx.agents.create).mockImplementationOnce(async options => {
    await new Promise(resolve => setTimeout(resolve, 40))
    return create(options)
  })
  expect(await f.adapter.handle('task.start', { ...f.input, authorizationLeaseMs: 10 })).toMatchObject({ status: 'failed' })
  expect([...f.jobs.values()][0]!.agent.send).not.toHaveBeenCalled()
})
