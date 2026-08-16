/** Explicit, high-risk node rescue tools kept outside the normal DSH workflow. */

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { invoke, type HubRuntime } from './api.ts'
import css from './HubSettings.module.css'

interface FileEntry {
  path: string
  kind: 'file' | 'directory' | 'symlink'
  size?: number
  modifiedAt?: number
}

interface FileListing {
  entries: FileEntry[]
  nextCursor?: string
}

interface FileContent {
  encoding: 'utf8' | 'base64'
  data: string
  eof: boolean
  contentHash: string
}

interface OpenFile extends FileContent {
  path: string
}

interface TerminalFrame {
  type: 'opened' | 'output'
  encoding?: 'utf8' | 'base64'
  data?: string
  eof?: boolean
  exitCode?: number | null
}

const TERMINAL_SCROLLBACK = 262_144

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function keyOf(runtime: Pick<HubRuntime, 'nodeId' | 'runtimeId'>): string {
  return `${runtime.nodeId}\u0000${runtime.runtimeId}`
}

function supports(runtime: HubRuntime, capability: string): boolean {
  return runtime.online && runtime.capabilities.some(candidate => candidate.name === capability)
}

function requireAbsolutePath(path: string): string {
  const value = path.trim()
  if (!value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value) && !value.startsWith('\\\\')) {
    throw new Error('请输入节点上的绝对路径')
  }
  return value
}

function parentPath(path: string): string {
  const value = path.replace(/[\\/]+$/, '')
  const separator = value.includes('\\') ? '\\' : '/'
  const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  if (index < 0) return value
  if (index === 0) return separator
  if (/^[A-Za-z]:$/.test(value.slice(0, index))) return `${value.slice(0, index)}${separator}`
  return value.slice(0, index)
}

function decodeTerminal(frame: TerminalFrame): string {
  if (frame.data === undefined || frame.data === '') return ''
  if (frame.encoding !== 'base64') return frame.data
  const bytes = Uint8Array.from(globalThis.atob(frame.data), character => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** Construct the authenticated, same-origin rescue-terminal URL. */
export function terminalSocketUrl(runtime: Pick<HubRuntime, 'nodeId' | 'runtimeId'>, cwd: string): string {
  const url = new URL('/hub/v1/terminal', globalThis.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('nodeId', runtime.nodeId)
  url.searchParams.set('runtimeId', runtime.runtimeId)
  url.searchParams.set('columns', '100')
  url.searchParams.set('rows', '30')
  if (cwd.trim() !== '') url.searchParams.set('cwd', requireAbsolutePath(cwd))
  return url.toString()
}

function TerminalDiagnostic({ runtime }: { runtime: HubRuntime }): ReactNode {
  const socketRef = useRef<WebSocket>()
  const outputRef = useRef<HTMLTextAreaElement>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [cwd, setCwd] = useState('')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [status, setStatus] = useState<'closed' | 'connecting' | 'open'>('closed')
  const [error, setError] = useState<string>()

  useEffect(() => () => { socketRef.current?.close(1000, 'Settings page closed') }, [])
  useEffect(() => {
    const element = outputRef.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [output])

  const close = (): void => {
    socketRef.current?.close(1000, 'Operator closed terminal')
    socketRef.current = undefined
    setStatus('closed')
  }

  const open = (): void => {
    setError(undefined)
    setOutput('')
    let url: string
    try {
      url = terminalSocketUrl(runtime, cwd)
    } catch (reason) {
      setError(messageOf(reason))
      return
    }
    setStatus('connecting')
    const socket = new WebSocket(url)
    socketRef.current = socket
    socket.addEventListener('message', (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as TerminalFrame
        if (frame.type === 'opened') {
          setStatus('open')
          return
        }
        const text = decodeTerminal(frame)
        setOutput(previous => `${previous}${text}`.slice(-TERMINAL_SCROLLBACK))
        if (frame.eof === true) {
          setStatus('closed')
          setOutput(previous => `${previous}\n[进程已退出${frame.exitCode === undefined ? '' : `：${String(frame.exitCode)}`} ]\n`.slice(-TERMINAL_SCROLLBACK))
        }
      } catch (reason) {
        setError(`终端响应无法解析：${messageOf(reason)}`)
      }
    })
    socket.addEventListener('error', () => { setError('终端连接失败，请检查节点状态和权限') })
    socket.addEventListener('close', () => {
      if (socketRef.current === socket) socketRef.current = undefined
      setStatus('closed')
    })
  }

  const send = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const socket = socketRef.current
    if (socket === undefined || socket.readyState !== WebSocket.OPEN || input === '') return
    socket.send(JSON.stringify({ type: 'input', data: `${input}\n` }))
    setInput('')
  }

  const interrupt = (): void => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data: '\u0003' }))
  }

  return (
    <section className={css.diagnosticTool}>
      <div><h4>应急终端</h4><p>适合修复 Agent、Connector、DSH Profile 或服务进程。这里的命令直接以 Node Agent 的系统账号执行。</p></div>
      <label className={css.confirmRow}><input type="checkbox" checked={acknowledged} onChange={(event) => { setAcknowledged(event.currentTarget.checked) }} />我理解这里不是 DSH 对话，命令可能修改或删除节点数据。</label>
      <div className={css.inlineForm}>
        <label>起始目录（可选）<input value={cwd} disabled={status !== 'closed'} onChange={(event) => { setCwd(event.currentTarget.value) }} placeholder="例如：/srv/dsh 或 C:\\Users\\me" /></label>
        {status === 'closed'
          ? <button className={css.dangerButton} type="button" disabled={!acknowledged} onClick={open}>打开终端</button>
          : <button className={css.secondaryButton} type="button" onClick={close}>关闭终端</button>}
      </div>
      {error === undefined ? null : <p className={css.error} role="alert">{error}</p>}
      {status === 'closed' && output === '' ? null : (
        <>
          <textarea ref={outputRef} className={css.terminalOutput} aria-label="终端输出" readOnly value={status === 'connecting' ? '正在连接节点终端…' : output} />
          <form className={css.terminalInput} onSubmit={send}>
            <label>命令<input aria-label="终端命令" autoComplete="off" value={input} disabled={status !== 'open'} onChange={(event) => { setInput(event.currentTarget.value) }} /></label>
            <button className={css.primaryButton} type="submit" disabled={status !== 'open' || input === ''}>发送</button>
            <button className={css.secondaryButton} type="button" disabled={status !== 'open'} onClick={interrupt}>中断</button>
          </form>
        </>
      )}
    </section>
  )
}

function FileDiagnostic({ runtime }: { runtime: HubRuntime }): ReactNode {
  const [path, setPath] = useState('')
  const [listingPath, setListingPath] = useState('')
  const [listing, setListing] = useState<FileEntry[]>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [opened, setOpened] = useState<OpenFile>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()

  const list = (cursor?: string): void => {
    let target: string
    try { target = requireAbsolutePath(path) } catch (reason) { setError(messageOf(reason)); return }
    setBusy('list')
    setError(undefined)
    void invoke<FileListing>(runtime, 'dsh.files', 'list', { path: target, ...(cursor === undefined ? {} : { cursor }), limit: 500 })
      .then((result) => {
        setListingPath(target)
        setListing(previous => cursor === undefined ? result.entries : [...previous, ...result.entries])
        setNextCursor(result.nextCursor)
        setOpened(undefined)
      })
      .catch((reason: unknown) => { setError(messageOf(reason)) })
      .finally(() => { setBusy(undefined) })
  }

  const read = (target = path): void => {
    let absolute: string
    try { absolute = requireAbsolutePath(target) } catch (reason) { setError(messageOf(reason)); return }
    setPath(absolute)
    setBusy('read')
    setError(undefined)
    void invoke<FileContent>(runtime, 'dsh.files', 'read', { path: absolute, offset: 0, maxBytes: 1_048_576 })
      .then((result) => {
        setOpened({ ...result, path: absolute })
        setDraft(result.encoding === 'utf8' ? result.data : '')
      })
      .catch((reason: unknown) => { setError(messageOf(reason)) })
      .finally(() => { setBusy(undefined) })
  }

  const save = (): void => {
    if (opened === undefined || opened.encoding !== 'utf8' || !opened.eof) return
    if (!globalThis.confirm(`保存“${opened.path}”？如果节点上的文件在读取后发生变化，本次保存会被拒绝。`)) return
    setBusy('save')
    setError(undefined)
    void invoke<{ contentHash: string; size: number }>(runtime, 'dsh.files', 'write', {
      path: opened.path, expectedHash: opened.contentHash, encoding: 'utf8', data: draft,
    }).then((result) => { setOpened({ ...opened, data: draft, contentHash: result.contentHash }) })
      .catch((reason: unknown) => { setError(messageOf(reason)) })
      .finally(() => { setBusy(undefined) })
  }

  const remove = (): void => {
    if (opened === undefined) return
    if (!globalThis.confirm(`永久删除节点文件“${opened.path}”？此操作不会进入回收站。`)) return
    setBusy('remove')
    setError(undefined)
    void invoke(runtime, 'dsh.files', 'remove', {
      path: opened.path, expectedHash: opened.contentHash, recursive: false,
    }).then(() => { setOpened(undefined); setDraft('') })
      .catch((reason: unknown) => { setError(messageOf(reason)) })
      .finally(() => { setBusy(undefined) })
  }

  const enter = (entry: FileEntry): void => {
    setPath(entry.path)
    if (entry.kind === 'file') read(entry.path)
  }

  return (
    <section className={css.diagnosticTool}>
      <div><h4>按路径检查文件</h4><p>适合读取日志或修复已知配置文件，不会把节点目录或文件缓存到 Hub。</p></div>
      <div className={css.pathBar}>
        <label>节点绝对路径<input aria-label="节点绝对路径" value={path} onChange={(event) => { setPath(event.currentTarget.value) }} placeholder="输入一个目录或文件的绝对路径" /></label>
        <button className={css.secondaryButton} type="button" disabled={busy !== undefined || path === ''} onClick={() => { list() }}>列出目录</button>
        <button className={css.secondaryButton} type="button" disabled={busy !== undefined || path === ''} onClick={() => { read() }}>读取文件</button>
      </div>
      {error === undefined ? null : <p className={css.error} role="alert">{error}</p>}
      {listingPath === '' ? null : (
        <div className={css.fileBrowser}>
          <div className={css.fileBrowserHeader}>
            <strong>{listingPath}</strong>
            <button className={css.textButton} type="button" onClick={() => { setPath(parentPath(listingPath)) }}>转到上级</button>
          </div>
          {listing.length === 0 ? <p className={css.empty}>目录为空。</p> : (
            <ul className={css.fileList}>{listing.map(entry => (
              <li key={entry.path}>
                <button type="button" onClick={() => { enter(entry) }}>
                  <span>{entry.kind === 'directory' ? '目录' : entry.kind === 'symlink' ? '链接' : '文件'}</span>
                  <strong>{entry.path.slice(Math.max(entry.path.lastIndexOf('/'), entry.path.lastIndexOf('\\')) + 1)}</strong>
                  <small>{entry.size === undefined ? '' : `${String(entry.size)} B`}</small>
                </button>
              </li>
            ))}</ul>
          )}
          {nextCursor === undefined ? null : <button className={css.secondaryButton} type="button" disabled={busy !== undefined} onClick={() => { list(nextCursor) }}>加载更多</button>}
        </div>
      )}
      {opened === undefined ? null : (
        <div className={css.fileEditor}>
          <div className={css.fileBrowserHeader}><strong>{opened.path}</strong><span>{opened.encoding === 'base64' ? '二进制，只读' : opened.eof ? 'UTF-8 文本' : '文件超过 1 MiB，只读预览'}</span></div>
          {opened.encoding === 'base64'
            ? <p className={css.empty}>该文件不是 UTF-8 文本。为避免损坏，Hub 不在浏览器中编辑二进制内容。</p>
            : <textarea aria-label="文件内容" value={draft} readOnly={!opened.eof} onChange={(event) => { setDraft(event.currentTarget.value) }} />}
          <div className={css.fileActions}>
            <button className={css.primaryButton} type="button" disabled={busy !== undefined || opened.encoding !== 'utf8' || !opened.eof || draft === opened.data} onClick={save}>保存修改</button>
            <button className={css.dangerButton} type="button" disabled={busy !== undefined} onClick={remove}>删除文件</button>
          </div>
        </div>
      )}
    </section>
  )
}

/** Render hidden-by-default rescue controls for one explicitly selected runtime. */
export function AdvancedDiagnostics({ runtimes }: { runtimes: HubRuntime[] }): ReactNode {
  const candidates = useMemo(
    () => runtimes.filter(runtime => supports(runtime, 'dsh.terminals') || supports(runtime, 'dsh.files')),
    [runtimes],
  )
  const [selected, setSelected] = useState('')
  const runtime = candidates.find(candidate => keyOf(candidate) === selected) ?? candidates[0]

  return (
    <details className={css.advanced}>
      <summary>高级诊断：终端与文件</summary>
      <div className={css.advancedBody}>
        <div><h3>什么时候使用？</h3><p>仅在节点服务损坏、普通 DSH 操作无法完成，或必须检查一个明确文件时使用。它们不是聊天、项目管理或日常文件浏览功能。</p></div>
        <p className={css.warning}>Hub 拥有节点已授予的全部权限；终端命令和文件改动以 Node Agent 的系统账号执行并写入审计。</p>
        {runtime === undefined ? <p className={css.empty}>没有在线且启用高级诊断能力的 Runtime。请先在节点 Agent 的受管 Profile 中启用对应能力。</p> : (
          <>
            <label className={css.runtimePicker}>诊断目标
              <select value={keyOf(runtime)} onChange={(event) => { setSelected(event.currentTarget.value) }}>
                {candidates.map(candidate => (
                  <option key={keyOf(candidate)} value={keyOf(candidate)}>
                    {candidate.nodeId} / {candidate.runtimeId}
                  </option>
                ))}
              </select>
            </label>
            {supports(runtime, 'dsh.terminals') ? <TerminalDiagnostic key={`terminal:${keyOf(runtime)}`} runtime={runtime} /> : null}
            {supports(runtime, 'dsh.files') ? <FileDiagnostic key={`files:${keyOf(runtime)}`} runtime={runtime} /> : null}
          </>
        )}
      </div>
    </details>
  )
}
