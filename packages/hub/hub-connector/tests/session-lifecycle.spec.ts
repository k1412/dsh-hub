import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionLifecycle, type LifecycleHost, type LifecycleSummary } from '../src/session-lifecycle.ts'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(id = 'same-session') {
  const root = await mkdtemp(join(tmpdir(), 'hub-lifecycle-')); roots.push(root)
  const storageRoot = join(root, 'logs')
  const directory = join(storageRoot, 'project', id)
  const log = join(directory, 'session.v4.jsonl')
  const metadata = join(root, 'state', 'default.json')
  await mkdir(directory, { recursive: true })
  await writeFile(log, 'private transcript\n')
  await writeFile(join(directory, 'session.v3.jsonl'), 'historical transcript\n')
  await writeFile(join(directory, 'session.lock'), '')
  const summary: LifecycleSummary = { sessionId: id, title: 'A conversation', workspacePath: '/project', updatedAt: 10, running: false, eventSequence: 2 }
  const archived = new Set<string>()
  let live = false
  let active = false
  let writerHeld = false
  const release = vi.fn(async () => undefined)
  const host: LifecycleHost = {
    list: async () => await lstat(log).then(() => [summary], () => []),
    archived: () => [...archived],
    archive: vi.fn(async sessionId => { archived.add(sessionId) }),
    unarchive: vi.fn(async sessionId => { archived.delete(sessionId) }),
    detach: vi.fn(async () => undefined),
    live: () => live,
    active: async () => active,
    persistence: {
      name: 'session-persistence-jsonl', config: { root: storageRoot },
      stat: async sessionId => await lstat(log).then(() => ({ header: { id: sessionId, cwd: '/project' } }), () => undefined),
      resolveCurrentLog: async () => log,
      acquireWriteLease: vi.fn(async () => {
        if (writerHeld) throw new Error('writer-held')
        return { release }
      }),
    },
  }
  const lifecycle = new SessionLifecycle(metadata, host); await lifecycle.ready()
  return { lifecycle, host, log, directory, metadata, root, id, archived, release,
    setLive(value: boolean) { live = value }, setActive(value: boolean) { active = value }, setWriter(value: boolean) { writerHeld = value } }
}
const inventory = { status: 'all', query: '', limit: 100 }
async function trash(lifecycle: SessionLifecycle, sessionId: string) {
  return await lifecycle.mutate('trash', { sessionId }) as { sessionId: string; deletedAt: number; status: string }
}

describe('node-owned session lifecycle', () => {
  it('allows canonical aliases above the storage root but refuses a linked root itself', async () => {
    const f = await fixture()
    const alias = join(f.root, 'parent-alias'); await symlink(f.root, alias, 'junction')
    f.host.persistence.config.root = join(alias, 'logs')
    f.host.persistence.resolveCurrentLog = async () => join(alias, 'logs', 'project', f.id, 'session.v4.jsonl')
    const receipt = await trash(f.lifecycle, f.id)
    await expect(f.lifecycle.mutate('purge', receipt)).resolves.toMatchObject({ status: 'purged' })
    const other = await fixture()
    const linkedRoot = join(other.root, 'linked-logs'); await symlink(join(other.root, 'logs'), linkedRoot, 'junction')
    other.host.persistence.config.root = linkedRoot
    other.host.persistence.resolveCurrentLog = async () => join(linkedRoot, 'project', other.id, 'session.v4.jsonl')
    await expect(other.lifecycle.mutate('purge', await trash(other.lifecycle, other.id))).rejects.toThrow('符号链接')
    expect(await readFile(other.log, 'utf8')).toContain('private transcript')
  })
  it('fences stale confirmations after restore and restart even when the clock moves backwards', async () => {
    const f = await fixture()
    vi.spyOn(Date, 'now').mockReturnValue(100)
    const first = await trash(f.lifecycle, f.id)
    await f.lifecycle.mutate('restore', first)
    const restarted = new SessionLifecycle(f.metadata, f.host); await restarted.ready()
    vi.spyOn(Date, 'now').mockReturnValue(50)
    const second = await trash(restarted, f.id)
    expect(second.deletedAt).toBeGreaterThan(first.deletedAt)
    await expect(restarted.mutate('purge', first)).rejects.toThrow('回收站记录已变化')
    expect(await readFile(f.log, 'utf8')).toContain('private transcript')
  })
  it('archives, lists, and unarchives without deleting source data', async () => {
    const f = await fixture()
    await expect(f.lifecycle.mutate('archive', { sessionId: f.id })).resolves.toMatchObject({ status: 'archived' })
    await expect(f.lifecycle.inventory({ ...inventory, status: 'archived' })).resolves.toMatchObject({ sessions: [{ sessionId: f.id, status: 'archived' }] })
    await f.lifecycle.mutate('unarchive', { sessionId: f.id })
    expect(f.archived.has(f.id)).toBe(false)
    expect(await readFile(f.log, 'utf8')).toContain('private transcript')
  })
  it('persists recoverable trash across restart and restores the previous archive state', async () => {
    const f = await fixture()
    const receipt = await trash(f.lifecycle, f.id)
    expect(f.lifecycle.hidden(f.id)).toBe(true)
    expect(() => f.lifecycle.assertAvailable(f.id)).toThrow('会话已删除')
    expect(await readFile(f.log, 'utf8')).toContain('private transcript')
    const restarted = new SessionLifecycle(f.metadata, f.host); await restarted.ready()
    expect(restarted.hidden(f.id)).toBe(true)
    await restarted.mutate('restore', receipt)
    expect(f.archived.has(f.id)).toBe(false)
    expect(restarted.hidden(f.id)).toBe(false)
    f.archived.add(f.id)
    const again = await trash(restarted, f.id)
    await expect(restarted.mutate('restore', again)).resolves.toMatchObject({ status: 'archived' })
    expect(f.archived.has(f.id)).toBe(true)
    expect((await lstat(f.metadata)).mode & 0o077).toBe(0)
  })
  it('erases all session generations, keeps the lock inode, and retains only an id tombstone', async () => {
    const f = await fixture()
    const lockBefore = await lstat(join(f.directory, 'session.lock'))
    const other = join(f.directory, '..', 'other-session'); await mkdir(other)
    await writeFile(join(other, 'session.v4.jsonl'), 'other conversation')
    const receipt = await trash(f.lifecycle, f.id)
    await expect(f.lifecycle.mutate('purge', receipt)).resolves.toMatchObject({ status: 'purged' })
    expect(await readdir(f.directory)).toEqual(['session.lock'])
    expect((await lstat(join(f.directory, 'session.lock'))).ino).toBe(lockBefore.ino)
    expect(await readFile(join(other, 'session.v4.jsonl'), 'utf8')).toBe('other conversation')
    expect(f.archived.has(f.id)).toBe(false)
    expect(f.host.detach).toHaveBeenCalledWith(f.id)
    expect(f.release).toHaveBeenCalledOnce()
    const state = JSON.parse(await readFile(f.metadata, 'utf8')) as { records: unknown[] }
    expect(state.records).toEqual([{ phase: 'purged', sessionId: f.id, deletedAt: receipt.deletedAt }])
    await expect(f.lifecycle.mutate('purge', receipt)).resolves.toMatchObject({ status: 'purged' })
    await expect(f.lifecycle.mutate('restore', receipt)).rejects.toThrow('回收站记录已变化')
  })
  it('refuses running work, attached sessions, foreign writers, and stale trash generations', async () => {
    const f = await fixture(); f.setActive(true)
    await expect(trash(f.lifecycle, f.id)).rejects.toThrow('运行中的任务')
    expect(f.archived.size).toBe(0)
    f.setActive(false)
    const receipt = await trash(f.lifecycle, f.id)
    f.setLive(true)
    await expect(f.lifecycle.mutate('purge', receipt)).rejects.toThrow('写锁尚未释放')
    f.setLive(false); f.setWriter(true)
    await expect(f.lifecycle.mutate('purge', receipt)).rejects.toThrow('writer-held')
    f.setWriter(false)
    await expect(f.lifecycle.mutate('purge', { ...receipt, deletedAt: receipt.deletedAt + 1 })).rejects.toThrow('回收站记录已变化')
    expect(await readFile(f.log, 'utf8')).toContain('private transcript')
  })
  it('fails closed on corrupted metadata and refuses symlinked source artifacts', async () => {
    const f = await fixture()
    const receipt = await trash(f.lifecycle, f.id)
    await rm(f.log); await symlink(join(f.directory, 'session.v3.jsonl'), f.log)
    await expect(f.lifecycle.mutate('purge', receipt)).rejects.toThrow('符号链接')
    expect(f.host.detach).not.toHaveBeenCalled()
    await writeFile(f.metadata, '{bad state')
    const corrupt = new SessionLifecycle(f.metadata, f.host)
    await expect(corrupt.ready()).rejects.toThrow()
    await writeFile(f.metadata, '{"version":1,"records":[]}'); await chmod(f.metadata, 0o644)
    await expect(corrupt.ready()).rejects.toThrow('owner-only')
  })
  it('keeps identical session ids isolated between Runtime-owned stores', async () => {
    const left = await fixture(); const right = await fixture()
    const [first, retry] = await Promise.all([trash(left.lifecycle, left.id), trash(left.lifecycle, left.id)])
    expect(first.deletedAt).toBe(retry.deletedAt)
    await left.lifecycle.mutate('purge', first)
    expect(right.lifecycle.hidden(right.id)).toBe(false)
    expect(await readFile(right.log, 'utf8')).toContain('private transcript')
  })
  it('recovers an interrupted purge and cannot restore partly erased history', async () => {
    const f = await fixture()
    const receipt = await trash(f.lifecycle, f.id)
    const state = JSON.parse(await readFile(f.metadata, 'utf8')) as { records: Array<{ phase: string; directory?: string; header?: unknown }> }
    const entry = state.records[0]; if (entry === undefined) throw new Error('missing trash')
    entry.phase = 'purging'; entry.directory = f.directory; entry.header = { id: f.id, cwd: '/project' }
    await writeFile(f.metadata, JSON.stringify(state))
    await rm(f.log)
    const restarted = new SessionLifecycle(f.metadata, f.host); await restarted.ready()
    await expect(restarted.mutate('restore', receipt)).rejects.toThrow('回收站记录已变化')
    await expect(restarted.mutate('purge', receipt)).resolves.toMatchObject({ status: 'purged' })
    expect(await readdir(f.directory)).toEqual(['session.lock'])
    expect(f.host.detach).toHaveBeenCalledWith(f.id)
  })
})
