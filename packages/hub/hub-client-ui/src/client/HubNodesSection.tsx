/** Hub node enrollment, status, switching, and high-risk diagnostic boundaries. */

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  cancelEnrollment, createEnrollment, readFleet, revokeNode, switchRuntime,
  type EnrollmentGrant, type FleetSnapshot, type HubNode, type HubOutboxHealth, type HubRuntime,
} from './api.ts'
import { AdvancedDiagnostics } from './AdvancedDiagnostics.tsx'
import { nodeInstallCommand, type NodeInstallPlatform } from './install-command.ts'
import { readRuntimeTarget, runtimeKey, supportsOfficialWeb } from './runtime-target.ts'
import css from './HubSettings.module.css'

/** Props supplied by the official Settings section outlet. */
export type HubNodesSectionProps = PropsRuntime<'settings.section'>

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatTime(value: number | undefined): string {
  return value === undefined ? '从未连接' : new Date(value).toLocaleString()
}

function nodeState(node: HubNode): { label: string; tone: string } {
  if (node.status === 'revoked') return { label: '已撤销', tone: 'danger' }
  if (node.online) return { label: '在线', tone: 'success' }
  return { label: '离线', tone: 'muted' }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function queueSummary(queue: HubOutboxHealth): string {
  const capacity = `${String(queue.records)} / ${String(queue.maxRecords)} 条 · ${formatBytes(queue.bytes)} / ${formatBytes(queue.maxBytes)}`
  return queue.oldestPendingAt === undefined ? capacity : `${capacity} · 最早 ${formatTime(queue.oldestPendingAt)}`
}

function pressureState(pressure: NonNullable<HubNode['transport']>['pressure']): { label: string; tone: string } {
  if (pressure === 'critical') return { label: '队列严重积压', tone: 'danger' }
  if (pressure === 'warning') return { label: '队列有压力', tone: 'warning' }
  if (pressure === 'normal') return { label: '传输正常', tone: 'success' }
  return { label: '等待监控数据', tone: 'muted' }
}

function currentRuntimeKey(): string | undefined {
  const target = readRuntimeTarget()
  return target === undefined ? undefined : runtimeKey(target)
}

/** Render the complete node registration and lifecycle page. */
export function HubNodesSection(_props: HubNodesSectionProps): ReactNode {
  const [fleet, setFleet] = useState<FleetSnapshot>()
  const [grant, setGrant] = useState<EnrollmentGrant>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [displayName, setDisplayName] = useState('')
  const [nodeId, setNodeId] = useState('')
  const [nodeIdEdited, setNodeIdEdited] = useState(false)
  const [installPlatform, setInstallPlatform] = useState<NodeInstallPlatform>('unix')
  const [copied, setCopied] = useState(false)
  const activeKey = currentRuntimeKey()

  const load = async (): Promise<void> => {
    setError(undefined)
    try {
      setFleet(await readFleet())
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  useEffect(() => {
    void load()
    const timer = globalThis.setInterval(() => { void load() }, 15_000)
    return () => { globalThis.clearInterval(timer) }
  }, [])

  const runtimesByNode = useMemo(() => {
    const result = new Map<string, HubRuntime[]>()
    for (const runtime of fleet?.runtimes ?? []) {
      const rows = result.get(runtime.nodeId) ?? []
      rows.push(runtime)
      result.set(runtime.nodeId, rows)
    }
    return result
  }, [fleet])

  const updateName = (value: string): void => {
    setDisplayName(value)
    if (!nodeIdEdited) {
      const slug = value.trim().toLocaleLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64)
      setNodeId(slug)
    }
  }

  const enroll = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setBusy('enroll')
    setError(undefined)
    void createEnrollment({ nodeId, displayName, expiresInSeconds: 900 })
      .then((created) => {
        setGrant(created)
        setDisplayName('')
        setNodeId('')
        setNodeIdEdited(false)
        return load()
      })
      .catch((reason: unknown) => { setError(messageOf(reason)) })
      .finally(() => { setBusy(undefined) })
  }

  const copyInstallCommand = (): void => {
    if (grant === undefined) return
    setError(undefined)
    void navigator.clipboard.writeText(nodeInstallCommand(grant, globalThis.location.origin, installPlatform))
      .then(() => { setCopied(true) })
      .catch((reason: unknown) => { setError(messageOf(reason)) })
  }

  const cancel = (pendingNodeId: string): void => {
    setBusy(`cancel:${pendingNodeId}`)
    setError(undefined)
    void cancelEnrollment(pendingNodeId)
      .then(load)
      .catch((reason: unknown) => { setError(messageOf(reason)) })
      .finally(() => { setBusy(undefined) })
  }

  const revoke = (node: HubNode): void => {
    if (!globalThis.confirm(`撤销“${node.displayName}”后，该节点会立即断开，原身份不能再次使用。确认继续？`)) return
    setBusy(`revoke:${node.nodeId}`)
    setError(undefined)
    void revokeNode(node.nodeId)
      .then(load)
      .catch((reason: unknown) => { setError(messageOf(reason)) })
      .finally(() => { setBusy(undefined) })
  }

  return (
    <div className={css.section}>
      <header className={css.pageHeader}>
        <div>
          <h2>Hub 节点</h2>
          <p>节点只向 Hub 建立出站连接；会话与项目始终跨节点汇总。这里管理节点，并选择新会话和节点设置的默认 Runtime。</p>
        </div>
        <button className={css.secondaryButton} type="button" onClick={() => { void load() }}>刷新</button>
      </header>

      {error === undefined ? null : <p className={css.error} role="alert">{error}</p>}

      <section className={css.block}>
        <div className={css.blockHeader}>
          <div><h3>注册新节点</h3><p>注册码仅显示一次，15 分钟后失效。</p></div>
        </div>
        <form className={css.formGrid} onSubmit={enroll}>
          <label>显示名称<input required maxLength={128} value={displayName} onChange={(event) => { updateName(event.currentTarget.value) }} placeholder="例如：家里 Mac" /></label>
          <label>节点 ID<input required maxLength={64} pattern="[A-Za-z0-9._-]+" value={nodeId} onChange={(event) => { setNodeIdEdited(true); setNodeId(event.currentTarget.value) }} placeholder="例如：mac-home" /></label>
          <button className={css.primaryButton} disabled={busy !== undefined} type="submit">{busy === 'enroll' ? '正在生成…' : '生成注册码'}</button>
        </form>
        {grant === undefined ? null : (
          <div className={css.secretPanel} role="status">
            <strong>在目标电脑运行一个命令</strong>
            <p>
              命令内的注册码在 {new Date(grant.expiresAt).toLocaleTimeString()} 前有效。安装器会校验 Release、安装 DSH Connector
              插件和 Node Agent 服务，并通过隐藏提示读取 Cloudflare Service Token。
            </p>
            <div className={css.platformTabs} role="tablist" aria-label="目标系统">
              <button
                className={installPlatform === 'unix' ? css.activeButton : css.secondaryButton}
                role="tab"
                aria-selected={installPlatform === 'unix'}
                type="button"
                onClick={() => { setInstallPlatform('unix'); setCopied(false) }}
              >Linux / macOS</button>
              <button
                className={installPlatform === 'windows' ? css.activeButton : css.secondaryButton}
                role="tab"
                aria-selected={installPlatform === 'windows'}
                type="button"
                onClick={() => { setInstallPlatform('windows'); setCopied(false) }}
              >Windows</button>
            </div>
            <pre className={css.installCommand}>
              {nodeInstallCommand(grant, globalThis.location.origin, installPlatform)}
            </pre>
            <button className={css.primaryButton} type="button" onClick={copyInstallCommand}>{copied ? '已复制' : '复制一键安装命令'}</button>
            <details className={css.enrollmentHelp}>
              <summary>为什么仍会询问 Cloudflare 凭据？</summary>
              <p>
                每个节点使用独立 Service Token，才能单独轮换或撤销。Connector 已是 DSH Bundle 插件；Node Agent 作为同账户
                Sidecar 保持 WSS、身份和断线恢复，不会创建第二个 DSH Runtime。
              </p>
              <code className={css.rawCode}>{grant.code}</code>
            </details>
          </div>
        )}
      </section>

      {(fleet?.enrollments.length ?? 0) === 0 ? null : (
        <section className={css.block}>
          <div className={css.blockHeader}><div><h3>等待接入</h3><p>这些节点 ID 已预留，但尚未完成身份绑定。</p></div></div>
          <ul className={css.compactList}>
            {fleet?.enrollments.map(item => (
              <li key={item.nodeId}>
                <span><strong>{item.displayName}</strong><small>{item.nodeId} · {formatTime(item.expiresAt)} 到期</small></span>
                <button className={css.textButton} disabled={busy !== undefined} type="button" onClick={() => { cancel(item.nodeId) }}>{busy === `cancel:${item.nodeId}` ? '取消中…' : '取消注册'}</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={css.block}>
        <div className={css.blockHeader}>
          <div><h3>已登记节点</h3><p>{fleet === undefined ? '正在读取…' : `${String(fleet.nodes.length)} 个节点`}</p></div>
        </div>
        {fleet !== undefined && fleet.nodes.length === 0 ? <p className={css.empty}>尚未登记节点。</p> : null}
        <div className={css.cardList}>
          {fleet?.nodes.map((node) => {
            const status = nodeState(node)
            const health = node.transport ?? {
              pressure: 'unknown' as const,
              hubOutbox: { records: 0, bytes: 0, maxRecords: 10_000, maxBytes: 64 * 1024 * 1024 },
              droppedStreamFramesTotal: 0,
              droppedStreams: [],
              controlRequests: { pending: 0, timeoutsLast24Hours: 0 },
            }
            const transport = pressureState(health.pressure)
            const runtimes = runtimesByNode.get(node.nodeId) ?? []
            return (
              <article className={css.card} key={node.nodeId}>
                <div className={css.cardTop}>
                  <div><h4>{node.displayName}</h4><p>{node.nodeId}</p></div>
                  <span className={css.status} data-tone={status.tone}>{status.label}</span>
                </div>
                <dl className={css.meta}>
                  <div><dt>最近连接</dt><dd>{formatTime(node.lastSeenAt)}</dd></div>
                  <div><dt>Runtime</dt><dd>{runtimes.length}</dd></div>
                </dl>
                <div className={css.transport} data-tone={transport.tone}>
                  <div className={css.transportHeader}>
                    <strong>{transport.label}</strong>
                    <small>{health.reportedAt === undefined ? '尚未收到节点报告' : `更新于 ${formatTime(health.reportedAt)}`}</small>
                  </div>
                  <dl className={css.transportQueues}>
                    <div><dt>节点 → Hub</dt><dd>{health.nodeOutbox === undefined ? '等待节点上线' : queueSummary(health.nodeOutbox)}</dd></div>
                    <div><dt>Hub → 节点</dt><dd>{queueSummary(health.hubOutbox)}</dd></div>
                    <div><dt>已抑制流量</dt><dd>{String(health.droppedStreamFramesTotal)} 帧</dd></div>
                    <div><dt>控制请求</dt><dd>{health.controlRequests.pending === 0
                      ? '无排队'
                      : `${String(health.controlRequests.pending)} 个排队 · 最早 ${formatTime(health.controlRequests.oldestPendingAt)}`}</dd></div>
                    <div><dt>24 小时超时</dt><dd>{String(health.controlRequests.timeoutsLast24Hours)} 次</dd></div>
                  </dl>
                  {health.controlRequests.lastTimeoutAt === undefined ? null : (
                    <small>最近超时：{health.controlRequests.lastTimeoutOperation ?? '未知操作'} · {formatTime(health.controlRequests.lastTimeoutAt)}</small>
                  )}
                </div>
                {runtimes.length === 0 ? <p className={css.empty}>尚未上报 DSH Runtime。</p> : (
                  <ul className={css.runtimeList}>
                    {runtimes.map(runtime => (
                      <li key={runtimeKey(runtime)}>
                        <span>
                          <strong>{runtime.runtimeId}</strong>
                          <small>DSH {runtime.dshVersion} · Connector {runtime.connectorVersion}</small>
                        </span>
                        <button
                          className={runtimeKey(runtime) === activeKey ? css.activeButton : css.secondaryButton}
                          type="button"
                          disabled={!runtime.online || !supportsOfficialWeb(runtime) || runtimeKey(runtime) === activeKey}
                          onClick={() => { switchRuntime(runtime) }}
                        >
                          {runtimeKey(runtime) === activeKey
                            ? '默认'
                            : !runtime.online
                              ? '离线'
                              : supportsOfficialWeb(runtime)
                                ? '设为默认'
                                : '等待 Connector 更新'}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {node.status === 'active' ? (
                  <div className={css.dangerRow}>
                    <button className={css.dangerButton} disabled={busy !== undefined} type="button" onClick={() => { revoke(node) }}>{busy === `revoke:${node.nodeId}` ? '撤销中…' : '撤销节点身份'}</button>
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      </section>

      <AdvancedDiagnostics runtimes={fleet?.runtimes ?? []} />
    </div>
  )
}
