/** Hub node enrollment, status, switching, and high-risk diagnostic boundaries. */

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  cancelEnrollment, createEnrollment, readFleet, revokeNode, switchRuntime,
  type EnrollmentGrant, type FleetSnapshot, type HubNode, type HubRuntime,
} from './api.ts'
import { AdvancedDiagnostics } from './AdvancedDiagnostics.tsx'
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

function runtimeKey(runtime: Pick<HubRuntime, 'nodeId' | 'runtimeId'>): string {
  return `${runtime.nodeId}\u0000${runtime.runtimeId}`
}

function currentRuntimeKey(): string | undefined {
  const query = new URL(globalThis.location.href).searchParams
  const nodeId = query.get('nodeId')
  const runtimeId = query.get('runtimeId')
  return nodeId === null || runtimeId === null ? undefined : `${nodeId}\u0000${runtimeId}`
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
  const activeKey = currentRuntimeKey()

  const load = async (): Promise<void> => {
    setError(undefined)
    try {
      setFleet(await readFleet())
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  useEffect(() => { void load() }, [])

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
          <p>节点只向 Hub 建立出站连接；在这里注册、查看状态、切换当前 DSH Runtime 或撤销身份。</p>
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
            <strong>一次性注册码</strong>
            <p>请在 {new Date(grant.expiresAt).toLocaleTimeString()} 前复制到目标节点；关闭或刷新后不能再次查看。</p>
            <code>{grant.code}</code>
            <button className={css.secondaryButton} type="button" onClick={() => { void navigator.clipboard.writeText(grant.code) }}>复制注册码</button>
            <details className={css.enrollmentHelp}>
              <summary>接下来如何接入节点</summary>
              <ol>
                <li>为这台节点创建一个独立的 Cloudflare Access Service Token；不要与其他节点共用。</li>
                <li>在节点安装发布包中的 <code>dsh-hub-node-agent</code>，准备 DSH Profile 的绝对路径。</li>
                <li>在节点本机设置注册码与 Service Token Secret 环境变量，再运行下面的初始化命令。</li>
                <li>按部署文档把 Node Agent 注册为系统服务；节点上线后，本页会显示它和对应 Runtime。</li>
              </ol>
              <pre>{`DSH_HUB_ENROLLMENT_CODE='<上方注册码>' \\\nDSH_HUB_ACCESS_CLIENT_SECRET='<节点 Service Token Secret>' \\\ndsh-hub-node init \\\n  --hub '${globalThis.location.origin}' \\\n  --node '${grant.nodeId}' \\\n  --access-client-id '<节点 Service Token Client ID>' \\\n  --profile-directory '<DSH Profile 绝对路径>' \\\n  --runtime-id 'default' \\\n  --install-connector '@k1412/dsh-hub-connector@0.1.0-rc.5'`}</pre>
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
                          disabled={!runtime.online || runtimeKey(runtime) === activeKey}
                          onClick={() => { switchRuntime(runtime) }}
                        >
                          {runtimeKey(runtime) === activeKey ? '当前' : runtime.online ? '打开' : '离线'}
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
