/** Human-readable node plugin state, update rollback history, and explicit snapshots. */

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { invoke, readFleet, type HubRuntime } from './api.ts'
import css from './HubSettings.module.css'

/** Props supplied by the official Settings section outlet. */
export type HubPluginsSectionProps = PropsRuntime<'settings.section'>

interface PluginRecord {
  packageName: string
  version: string
  enabled: boolean
  healthy: boolean
}

interface PluginUpdate extends PluginRecord {
  latestVersion: string
  updateAvailable: boolean
}

interface PluginChange {
  changeId: string
  packageName: string
  fromVersion?: string
  toVersion: string
  createdAt: number
  status: 'applying' | 'applied' | 'failed-rolled-back' | 'rollback-failed' | 'rolled-back'
  rolledBackAt?: number
  error?: string
}

interface Inventory {
  plugins: PluginRecord[]
  lockHash: string
  checkedAt: number
}

interface UpdateInventory {
  plugins: PluginUpdate[]
  lockHash: string
  checkedAt: number
}

interface SnapshotRecord {
  snapshotId: string
  type: 'configuration' | 'dependency' | 'data' | 'fleet'
  createdAt: number
  label: string
  reason: 'manual' | 'pre-restore'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function keyOf(runtime: Pick<HubRuntime, 'nodeId' | 'runtimeId'>): string {
  return `${runtime.nodeId}\u0000${runtime.runtimeId}`
}

function supports(runtime: HubRuntime, capability: string): boolean {
  return runtime.online && runtime.capabilities.some(candidate => candidate.name === capability)
}

function changeLabel(change: PluginChange): string {
  switch (change.status) {
    case 'applying': return '更新进行中'
    case 'applied': return '可回退'
    case 'failed-rolled-back': return '更新失败，已自动恢复'
    case 'rollback-failed': return '恢复失败，需要检查'
    case 'rolled-back': return '已回退'
  }
}

function snapshotTypeLabel(type: SnapshotRecord['type']): string {
  switch (type) {
    case 'configuration': return '配置'
    case 'dependency': return '依赖'
    case 'data': return '获准数据目录'
    case 'fleet': return '全部受管路径'
  }
}

/** Render node plugin health, safe updates, automatic rollback points, and snapshots. */
export function HubPluginsSection(_props: HubPluginsSectionProps): ReactNode {
  const [runtimes, setRuntimes] = useState<HubRuntime[]>([])
  const [selected, setSelected] = useState('')
  const [inventory, setInventory] = useState<Inventory>()
  const [updates, setUpdates] = useState<UpdateInventory>()
  const [history, setHistory] = useState<PluginChange[]>([])
  const [snapshots, setSnapshots] = useState<SnapshotRecord[]>([])
  const [snapshotLabel, setSnapshotLabel] = useState('')
  const [snapshotType, setSnapshotType] = useState<SnapshotRecord['type']>('configuration')
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const runtime = runtimes.find(candidate => keyOf(candidate) === selected)

  const loadRuntime = async (target: HubRuntime): Promise<void> => {
    setBusy('load')
    setError(undefined)
    try {
      const [nextInventory, nextHistory, nextSnapshots] = await Promise.all([
        invoke<Inventory>(target, 'dsh.plugins', 'inventory', {}),
        invoke<{ changes: PluginChange[] }>(target, 'dsh.plugins', 'history', {}),
        supports(target, 'dsh.snapshots')
          ? invoke<{ snapshots: SnapshotRecord[] }>(target, 'dsh.snapshots', 'list', {})
          : Promise.resolve({ snapshots: [] }),
      ])
      setInventory(nextInventory)
      setUpdates(undefined)
      setHistory(nextHistory.changes)
      setSnapshots(nextSnapshots.snapshots)
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(undefined)
    }
  }

  useEffect(() => {
    void readFleet().then((fleet) => {
      const candidates = fleet.runtimes.filter(candidate => supports(candidate, 'dsh.plugins'))
      setRuntimes(candidates)
      const url = new URL(globalThis.location.href)
      const fromUrl = `${url.searchParams.get('nodeId') ?? ''}\u0000${url.searchParams.get('runtimeId') ?? ''}`
      const initial = candidates.find(candidate => keyOf(candidate) === fromUrl) ?? candidates[0]
      if (initial === undefined) return
      setSelected(keyOf(initial))
      void loadRuntime(initial)
    }).catch((reason: unknown) => { setError(messageOf(reason)) })
  }, [])

  const updatesByPackage = useMemo(
    () => new Map((updates?.plugins ?? []).map(plugin => [plugin.packageName, plugin])),
    [updates],
  )

  const selectRuntime = (value: string): void => {
    setSelected(value)
    setInventory(undefined)
    setUpdates(undefined)
    setHistory([])
    setSnapshots([])
    const target = runtimes.find(candidate => keyOf(candidate) === value)
    if (target !== undefined) void loadRuntime(target)
  }

  const checkUpdates = (): void => {
    if (runtime === undefined) return
    setBusy('check')
    setError(undefined)
    void invoke<UpdateInventory>(runtime, 'dsh.plugins', 'check-updates', {})
      .then(setUpdates)
      .catch((reason: unknown) => { setError(messageOf(reason)) })
      .finally(() => { setBusy(undefined) })
  }

  const applyUpdate = (plugin: PluginUpdate): void => {
    if (runtime === undefined || inventory === undefined) return
    setBusy(`update:${plugin.packageName}`)
    setError(undefined)
    void invoke(runtime, 'dsh.plugins', 'apply', {
      clientMutationId: crypto.randomUUID(),
      packageName: plugin.packageName,
      version: plugin.latestVersion,
      expectedLockHash: inventory.lockHash,
    }).then(() => loadRuntime(runtime))
      .catch((reason: unknown) => { setError(messageOf(reason)) })
      .finally(() => { setBusy(undefined) })
  }

  const rollback = (change: PluginChange): void => {
    if (runtime === undefined || inventory === undefined) return
    if (!globalThis.confirm(`把 ${change.packageName} 恢复到更新前的 ${change.fromVersion ?? '未安装'} 状态？恢复前还会自动创建保护点。`)) return
    setBusy(`rollback:${change.changeId}`)
    setError(undefined)
    void invoke(runtime, 'dsh.plugins', 'rollback', {
      clientMutationId: crypto.randomUUID(),
      changeId: change.changeId,
      expectedLockHash: inventory.lockHash,
    }).then(() => loadRuntime(runtime))
      .catch((reason: unknown) => { setError(messageOf(reason)) })
      .finally(() => { setBusy(undefined) })
  }

  const createSnapshot = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (runtime === undefined) return
    setBusy('snapshot')
    setError(undefined)
    void invoke(runtime, 'dsh.snapshots', 'create', {
      clientMutationId: crypto.randomUUID(),
      type: snapshotType,
      ...(snapshotLabel.trim() === '' ? {} : { label: snapshotLabel.trim() }),
      includeSecretValues: false,
    }).then(() => {
      setSnapshotLabel('')
      return loadRuntime(runtime)
    }).catch((reason: unknown) => { setError(messageOf(reason)) })
      .finally(() => { setBusy(undefined) })
  }

  const restoreSnapshot = (snapshot: SnapshotRecord): void => {
    if (runtime === undefined) return
    if (!globalThis.confirm(`恢复快照“${snapshot.label}”？Hub 会先自动保存当前状态，以便撤销本次恢复。`)) return
    setBusy(`restore:${snapshot.snapshotId}`)
    setError(undefined)
    void invoke(runtime, 'dsh.snapshots', 'restore', {
      clientMutationId: crypto.randomUUID(),
      snapshotId: snapshot.snapshotId,
    }).then(() => loadRuntime(runtime))
      .catch((reason: unknown) => { setError(messageOf(reason)) })
      .finally(() => { setBusy(undefined) })
  }

  return (
    <div className={css.section}>
      <header className={css.pageHeader}>
        <div><h2>节点插件</h2><p>查看实际安装状态；每次更新会自动保存更新前版本，失败时自动恢复，也可从历史一键回退。</p></div>
      </header>
      {error === undefined ? null : <p className={css.error} role="alert">{error}</p>}
      <label className={css.runtimePicker}>管理目标
        <select value={selected} disabled={busy !== undefined} onChange={(event) => { selectRuntime(event.currentTarget.value) }}>
          {runtimes.map(candidate => (
            <option value={keyOf(candidate)} key={keyOf(candidate)}>
              {candidate.nodeId} / {candidate.runtimeId}
            </option>
          ))}
        </select>
      </label>
      {runtimes.length === 0 ? <p className={css.empty}>当前没有在线且支持插件管理的节点。</p> : null}

      {runtime === undefined ? null : (
        <>
          <section className={css.block}>
            <div className={css.blockHeader}>
              <div><h3>当前插件</h3><p>{inventory === undefined ? '正在读取…' : `${String(inventory.plugins.length)} 个插件 · ${new Date(inventory.checkedAt).toLocaleString()} 检查`}</p></div>
              <button className={css.secondaryButton} type="button" disabled={busy !== undefined} onClick={checkUpdates}>{busy === 'check' ? '检查中…' : '检查更新'}</button>
            </div>
            <div className={css.pluginList}>
              {inventory?.plugins.length === 0 ? <p className={css.empty}>该 Profile 没有识别到 DSH 插件。</p> : null}
              {inventory?.plugins.map((plugin) => {
                const update = updatesByPackage.get(plugin.packageName)
                return (
                  <article className={css.pluginRow} key={plugin.packageName}>
                    <div className={css.pluginIdentity}>
                      <strong>{plugin.packageName}</strong>
                      <span>当前 {plugin.version}{update === undefined ? '' : ` · 最新 ${update.latestVersion}`}</span>
                    </div>
                    <span className={css.status} data-tone={plugin.enabled && plugin.healthy ? 'success' : 'danger'}>{plugin.enabled ? plugin.healthy ? '运行正常' : '状态异常' : '已停用'}</span>
                    {update?.updateAvailable === true ? <button className={css.primaryButton} type="button" disabled={busy !== undefined} onClick={() => { applyUpdate(update) }}>{busy === `update:${plugin.packageName}` ? '更新中…' : `更新到 ${update.latestVersion}`}</button> : updates === undefined ? null : <span className={css.upToDate}>已是最新</span>}
                  </article>
                )
              })}
            </div>
          </section>

          <section className={css.block}>
            <div className={css.blockHeader}><div><h3>更新与回退历史</h3><p>更新前版本由节点自动保存，不需要手工记录任何内部标识。</p></div></div>
            {history.length === 0 ? <p className={css.empty}>还没有插件更新记录。</p> : (
              <ul className={css.historyList}>
                {history.map(change => (
                  <li key={change.changeId}>
                    <div><strong>{change.packageName}</strong><span>{change.fromVersion ?? '未安装'} → {change.toVersion}</span><small>{new Date(change.createdAt).toLocaleString()} · {changeLabel(change)}</small>{change.error === undefined ? null : <small className={css.errorText}>{change.error}</small>}</div>
                    {change.status === 'applied' ? <button className={css.secondaryButton} disabled={busy !== undefined} type="button" onClick={() => { rollback(change) }}>{busy === `rollback:${change.changeId}` ? '回退中…' : '回退到更新前'}</button> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {supports(runtime, 'dsh.snapshots') ? (
            <details className={css.advanced}>
              <summary>整机快照与恢复</summary>
              <div className={css.advancedBody}>
                <p>用于配置、依赖或数据的显式恢复点。插件更新不需要在这里手工建快照，它已经自动保留更新前版本。</p>
                <form className={css.formGrid} onSubmit={createSnapshot}>
                  <label>范围<select value={snapshotType} onChange={(event) => { setSnapshotType(event.currentTarget.value as SnapshotRecord['type']) }}><option value="configuration">配置</option><option value="dependency">依赖</option><option value="data">数据</option><option value="fleet">全部受管路径</option></select></label>
                  <label>名称<input value={snapshotLabel} onChange={(event) => { setSnapshotLabel(event.currentTarget.value) }} placeholder="例如：升级 DSH 前" /></label>
                  <button className={css.primaryButton} disabled={busy !== undefined} type="submit">{busy === 'snapshot' ? '创建中…' : '创建快照'}</button>
                </form>
                {snapshots.length === 0 ? <p className={css.empty}>尚未创建显式快照。</p> : (
                  <ul className={css.historyList}>{snapshots.map(snapshot => <li key={snapshot.snapshotId}><div><strong>{snapshot.label}</strong><span>{snapshotTypeLabel(snapshot.type)} · {snapshot.reason === 'pre-restore' ? '恢复前自动保护' : '手工创建'}</span><small>{new Date(snapshot.createdAt).toLocaleString()}</small></div><button className={css.secondaryButton} disabled={busy !== undefined} type="button" onClick={() => { restoreSnapshot(snapshot) }}>{busy === `restore:${snapshot.snapshotId}` ? '恢复中…' : '恢复'}</button></li>)}</ul>
                )}
              </div>
            </details>
          ) : null}
        </>
      )}
    </div>
  )
}
