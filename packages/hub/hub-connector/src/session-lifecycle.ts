/** Node-local archive and trash metadata, with lock-protected JSONL erasure. */
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'

const summarySchema = z.strictObject({
  sessionId: z.string().min(1).max(256), title: z.string().max(1_024).optional(),
  workspacePath: z.string().max(16_384).optional(), updatedAt: z.number().int().nonnegative(),
  running: z.boolean(), eventSequence: z.number().int().nonnegative(),
})
export type LifecycleSummary = z.infer<typeof summarySchema>
const recordSchema = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('trash'), summary: summarySchema, wasArchived: z.boolean(), deletedAt: z.number().int().positive() }),
  z.strictObject({ phase: z.literal('purging'), summary: summarySchema, wasArchived: z.boolean(), deletedAt: z.number().int().positive(),
    directory: z.string().min(1).max(16_384), header: z.strictObject({ id: z.string().min(1).max(256), cwd: z.string().max(16_384).optional() }) }),
  z.strictObject({ phase: z.literal('purged'), sessionId: z.string().min(1).max(256), deletedAt: z.number().int().positive() }),
])
type TrashRecord = z.infer<typeof recordSchema>
const manifestSchema = z.strictObject({ version: z.literal(1), records: z.array(recordSchema).max(100_000) })
interface Header { id: string; cwd?: string | undefined; origin?: string | undefined }
/** Backend-specific operations verified against DSH's JSONL write-lock contract. */
export interface LifecyclePersistence {
  name: string
  config: { root: string }
  stat(id: string): Promise<{ header: Header } | undefined>
  resolveCurrentLog(id: string): Promise<string | undefined>
  acquireWriteLease(header: Header): Promise<{ release(): Promise<void> }>
}
export interface LifecycleHost {
  persistence: LifecyclePersistence
  list(): Promise<LifecycleSummary[]>
  archived(): readonly string[]
  archive(id: string): Promise<void>
  unarchive(id: string): Promise<void>
  detach(id: string): Promise<void>
  live(id: string): boolean
  active(id: string): Promise<boolean>
}

function idOf(record: TrashRecord): string { return record.phase === 'purged' ? record.sessionId : record.summary.sessionId }
function segment(raw: string): string {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  return raw.split('').map(character => /^[A-Za-z0-9._-]$/u.test(character)
    ? character : `~${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join('')
}
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

/** One Runtime owns its own durable trash set; no network or shared global ids. */
export class SessionLifecycle {
  private records = new Map<string, TrashRecord>()
  private tail = Promise.resolve()
  public constructor(private readonly path: string, private readonly host: LifecycleHost) {}

  /** Load fail-closed and reassert archive marks after an interrupted restore. */
  public async ready(): Promise<void> {
    let serialized: string
    try {
      const metadata = await lstat(this.path)
      if (!metadata.isFile() || metadata.isSymbolicLink()
        || (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)) throw new Error('Session trash metadata must be an owner-only regular file')
      serialized = await readFile(this.path, 'utf8')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const state = manifestSchema.parse(JSON.parse(serialized) as unknown)
    this.records = new Map(state.records.map(record => [idOf(record), record]))
    if (this.records.size !== state.records.length) throw new Error('Session trash contains duplicate ids')
    for (const record of this.records.values()) {
      if (record.phase === 'purging') {
        if (this.host.live(idOf(record))) throw new Error('Interrupted purge is still owned by a live Session')
        await this.quiet(idOf(record))
        await this.erase(idOf(record), record)
      }
    }
    const summaries = await this.host.list()
    for (const record of this.records.values()) {
      if (record.phase === 'trash' && summaries.some(summary => summary.sessionId === idOf(record))) {
        await this.host.archive(idOf(record))
      }
    }
  }
  public hidden(id: string): boolean { return this.records.has(id) }
  public assertAvailable(id: unknown): void {
    if (typeof id === 'string' && this.hidden(id)) throw new Error('会话已删除；请到设置 → 会话管理 → 回收站恢复。')
  }
  /** Paginate the node's full source baseline, including archives and trash. */
  public async inventory(input: { status: string; query: string; cursor?: string; limit: number }): Promise<unknown> {
    const archived = new Set(this.host.archived())
    const all = new Map((await this.host.list()).map(summary => [summary.sessionId, summary]))
    for (const record of this.records.values()) {
      if (record.phase !== 'purged') all.set(idOf(record), record.summary)
    }
    const query = input.query.trim().toLocaleLowerCase()
    const rows = [...all.values()].flatMap(summary => {
      const record = this.records.get(summary.sessionId)
      if (record?.phase === 'purged') return []
      const status = record === undefined ? archived.has(summary.sessionId) ? 'archived' : 'active' : 'trash'
      if (input.status !== 'all' && input.status !== status) return []
      if (query !== '' && ![summary.title, summary.workspacePath, summary.sessionId].some(value => value?.toLocaleLowerCase().includes(query))) return []
      return [{ ...summary, status, ...(record === undefined ? {} : { deletedAt: record.deletedAt }),
        purgeAvailable: status === 'trash' && !this.host.live(summary.sessionId) }]
    }).sort((left, right) => right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId))
    const after = input.cursor === undefined ? 0 : rows.findIndex(row => row.sessionId === input.cursor) + 1
    if (input.cursor !== undefined && after === 0) throw new Error('会话列表已变化，请刷新后重试。')
    const sessions = rows.slice(after, after + input.limit)
    return { sessions, ...(after + sessions.length < rows.length ? { nextCursor: sessions.at(-1)?.sessionId } : {}) }
  }
  /** Serialize journal mutations; permanent removal requires the exact trash generation. */
  public mutate(operation: string, input: { sessionId: string; deletedAt?: number }): Promise<unknown> {
    const task = this.tail.then(() => this.change(operation, input))
    this.tail = task.then(() => undefined, () => undefined)
    return task
  }
  private async save(records: Map<string, TrashRecord>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomBytes(8).toString('hex')}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify({ version: 1, records: [...records.values()] }), 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    try { await rename(temporary, this.path); await syncDirectory(dirname(this.path)) }
    catch (error) { await unlink(temporary).catch(() => undefined); throw error }
    this.records = records
  }
  private async quiet(id: string): Promise<void> {
    if (await this.host.active(id)) throw new Error('会话仍有运行中的任务；请先停止任务，再归档或删除。')
  }
  private async change(operation: string, input: { sessionId: string; deletedAt?: number }): Promise<unknown> {
    const id = input.sessionId
    const record = this.records.get(id)
    if (operation === 'purge' && record?.phase === 'purged' && record.deletedAt === input.deletedAt) {
      return { sessionId: id, status: 'purged', deletedAt: record.deletedAt }
    }
    if (operation === 'restore' || operation === 'purge') {
      if (record === undefined || record.phase === 'purged' || record.deletedAt !== input.deletedAt) {
        throw new Error('回收站记录已变化，请刷新后重试。')
      }
      if (operation === 'restore') {
        if (record.phase !== 'trash') throw new Error('永久删除已开始，无法恢复；请重试永久删除以完成清理。')
        if (!(await this.host.list()).some(summary => summary.sessionId === id)) throw new Error('源会话日志已不存在，无法恢复。')
        if (!record.wasArchived) await this.host.unarchive(id)
        const next = new Map(this.records); next.delete(id); await this.save(next)
        return { sessionId: id, status: record.wasArchived ? 'archived' : 'active' }
      }
      await this.quiet(id)
      if (this.host.live(id)) throw new Error('会话仍被 Runtime 打开，日志写锁尚未释放。回收站删除已生效；请在结束任务后重启该节点，再永久删除。')
      await this.erase(id, record)
      return { sessionId: id, status: 'purged', deletedAt: record.deletedAt }
    }
    if (record !== undefined) {
      if (operation === 'trash' && record.phase === 'trash') return { sessionId: id, status: 'trash', deletedAt: record.deletedAt }
      throw new Error('会话已在回收站或已永久删除，请刷新列表。')
    }
    const summary = (await this.host.list()).find(candidate => candidate.sessionId === id)
    if (summary === undefined) throw new Error('会话不存在。')
    if (operation === 'unarchive') {
      await this.host.unarchive(id)
      return { sessionId: id, status: 'active' }
    }
    if (operation !== 'archive' && operation !== 'trash') throw new Error('不支持的会话管理操作。')
    await this.quiet(id)
    const snapshot = await this.host.persistence.stat(id)
    if (snapshot?.header.origin === 'subagent') throw new Error('子会话由父会话管理，不能单独放入回收站。')
    const wasArchived = this.host.archived().includes(id)
    await this.host.archive(id)
    if (operation === 'archive') return { sessionId: id, status: 'archived' }
    const deletedAt = Date.now()
    const next = new Map(this.records)
    next.set(id, { phase: 'trash', summary, wasArchived, deletedAt }); await this.save(next)
    return { sessionId: id, status: 'trash', deletedAt }
  }
  private async erase(id: string, record: Exclude<TrashRecord, { phase: 'purged' }>): Promise<void> {
    const persistence = this.host.persistence
    const snapshot = record.phase === 'purging' ? { header: record.header } : await persistence.stat(id)
    if (snapshot === undefined) throw new Error('源会话日志已不存在，请检查节点数据后重试。')
    if (snapshot.header.id !== id) throw new Error('日志身份不匹配，拒绝删除。')
    const log = record.phase === 'purging' ? undefined : await persistence.resolveCurrentLog(id)
    if (log === undefined && record.phase !== 'purging') throw new Error('旧格式日志需要先在 DSH 中打开并完成迁移，再归档删除。')
    const root = resolve(persistence.config.root)
    const directory = record.phase === 'purging' ? record.directory : dirname(log as string)
    const parts = relative(root, directory).split(sep)
    if (parts.length !== 2 || parts.some(part => part === '' || part === '..') || basename(directory) !== segment(id)) {
      throw new Error('日志目录不属于目标会话，拒绝删除。')
    }
    for (const path of [root, join(root, parts[0] as string), directory, ...(log === undefined ? [] : [log])]) {
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error('日志路径含符号链接，拒绝删除。')
    }
    const lease = await persistence.acquireWriteLease(snapshot.header)
    try {
      if (this.host.live(id)) throw new Error('会话刚被打开，请关闭后重试。')
      const entries = await readdir(directory, { withFileTypes: true })
      if (entries.some(entry => !entry.isFile())) throw new Error('会话目录存在非普通文件，拒绝自动清理。')
      const next = new Map(this.records); next.set(id, { ...record, phase: 'purging', directory,
        header: { id, ...(snapshot.header.cwd === undefined ? {} : { cwd: snapshot.header.cwd }) } }); await this.save(next)
      await this.host.detach(id)
      await this.host.unarchive(id)
      for (const entry of entries) {
        // Never unlink the lock inode: a queued foreign writer must continue
        // contending on the same kernel lock after transcript erasure.
        if (entry.name !== 'session.lock') await unlink(join(directory, entry.name))
      }
      await syncDirectory(directory)
      await this.finishErasure(id, record.deletedAt)
    } finally { await lease.release() }
  }
  private async finishErasure(id: string, deletedAt: number): Promise<void> {
    await this.host.detach(id)
    await this.host.unarchive(id)
    const next = new Map(this.records); next.set(id, { phase: 'purged', sessionId: id, deletedAt }); await this.save(next)
  }
}
