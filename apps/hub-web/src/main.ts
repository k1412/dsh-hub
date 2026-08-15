import './style.css'
import {
  activity, baseline, conversation, createEnrollment, invoke, revokeNode,
  type ConversationMessage, type HubAuditRecord, type HubCommand, type HubEnrollmentGrant,
  type HubNode, type HubRuntime, type HubSession,
} from './api.ts'

type View = 'chat' | 'fleet' | 'terminal' | 'files' | 'plugins' | 'snapshots' | 'settings' | 'activity'

interface State {
  nodes: HubNode[]
  runtimes: HubRuntime[]
  sessions: HubSession[]
  messages: ConversationMessage[]
  commands: HubCommand[]
  audit: HubAuditRecord[]
  enrollment: HubEnrollmentGrant | undefined
  operationResult: string | undefined
  selectedNode: string | undefined
  selectedSession: string | undefined
  view: View
  busy: boolean
  error: string | undefined
  mobileSidebar: boolean
}

const state: State = {
  nodes: [],
  runtimes: [],
  sessions: [],
  messages: [],
  commands: [],
  audit: [],
  enrollment: undefined,
  operationResult: undefined,
  selectedNode: undefined,
  selectedSession: undefined,
  view: 'chat',
  busy: false,
  error: undefined,
  mobileSidebar: false,
}

const root = document.querySelector<HTMLDivElement>('#app') as HTMLDivElement
let terminalSocket: WebSocket | undefined
let terminalText = ''

function formString(data: FormData, name: string): string {
  const value = data.get(name)
  return typeof value === 'string' ? value : ''
}

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function formatDate(value: number | undefined): string {
  return value === undefined ? '—' : new Date(value).toLocaleString()
}

function activeSession(): HubSession | undefined {
  return state.sessions.find(session => session.hubSessionId === state.selectedSession)
}

function activeRuntime(): HubRuntime | undefined {
  const session = activeSession()
  if (session !== undefined) return state.runtimes.find(runtime =>
    runtime.nodeId === session.nodeId && runtime.runtimeId === session.runtimeId)
  return state.runtimes.find(runtime => runtime.nodeId === state.selectedNode && runtime.online)
    ?? state.runtimes.find(runtime => runtime.online)
}

function icon(name: 'menu' | 'plus' | 'send' | 'close'): string {
  const paths = {
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    send: '<path d="m4 4 16 8-16 8 3-8-3-8Zm3 8h13"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`
}

function sidebar(): string {
  const sessions = state.sessions.filter(session =>
    state.selectedNode === undefined || session.nodeId === state.selectedNode)
  return `<aside class="sidebar ${state.mobileSidebar ? 'open' : ''}">
    <div class="brand"><span class="brand-mark">D</span><span>DSH Hub</span>
      <button class="icon mobile-close" data-action="sidebar-close" aria-label="关闭导航">${icon('close')}</button>
    </div>
    <button class="new-session" data-action="new-session">${icon('plus')}<span>新建会话</span></button>
    <div class="filter-label">节点</div>
    <button class="node-filter ${state.selectedNode === undefined ? 'active' : ''}" data-node="">
      <span class="status all"></span><span>全部节点</span><small>${state.nodes.length}</small>
    </button>
    ${state.nodes.map(node => `<button class="node-filter ${state.selectedNode === node.nodeId ? 'active' : ''}" data-node="${escape(node.nodeId)}">
      <span class="status ${node.online ? 'online' : ''}"></span><span>${escape(node.displayName)}</span>
      <small>${state.sessions.filter(session => session.nodeId === node.nodeId).length}</small>
    </button>`).join('')}
    <div class="filter-label sessions-label">会话</div>
    <nav class="session-list">
      ${sessions.map(session => `<button class="session-row ${state.selectedSession === session.hubSessionId ? 'active' : ''}" data-session="${escape(session.hubSessionId)}">
        <span>${escape(session.title || '未命名会话')}</span>
        <small>${new Date(session.updatedAt).toLocaleDateString()}</small>
      </button>`).join('') || '<p class="empty-list">该范围内暂无会话</p>'}
    </nav>
    <div class="sidebar-footer"><span class="status ${state.nodes.some(node => node.online) ? 'online' : ''}"></span>${state.nodes.filter(node => node.online).length} 个节点在线</div>
  </aside>`
}

function messageMarkup(message: ConversationMessage): string {
  if (message.role === 'user') return `<article class="message user"><div>${escape(message.text)}</div></article>`
  return `<article class="message ${message.role}"><div class="avatar">${message.role === 'assistant' ? 'D' : 'i'}</div><div class="message-body">${escape(message.text)}</div></article>`
}

function chat(): string {
  const session = activeSession()
  const node = state.nodes.find(candidate => candidate.nodeId === session?.nodeId)
  return `<section class="content chat-view">
    <header class="topbar">
      <button class="icon mobile-menu" data-action="sidebar-open" aria-label="打开导航">${icon('menu')}</button>
      <div><h1>${escape(session?.title || '选择一个会话')}</h1><p>${session === undefined ? '从左侧选择会话，或在任意在线节点新建会话' : `${escape(node?.displayName || session.nodeId)} · ${escape(session.runtimeId)}`}</p></div>
      ${session?.running ? '<span class="running">运行中</span>' : ''}
    </header>
    <div class="messages" id="messages">
      ${session === undefined ? '<div class="welcome"><span class="welcome-mark">D</span><h2>所有节点，一个工作台</h2><p>继续本地 Web 或桌面端已经开始的 DSH 会话。</p></div>'
        : state.messages.map(messageMarkup).join('') || '<div class="welcome compact"><h2>会话尚未开始</h2><p>发送一条消息开始工作。</p></div>'}
    </div>
    <form class="composer ${session === undefined ? 'disabled' : ''}" id="composer">
      <textarea name="message" rows="1" placeholder="向 DSH 发送消息" ${session === undefined || state.busy ? 'disabled' : ''}></textarea>
      <div class="composer-foot"><span>Shift + Enter 换行</span><button class="send" type="submit" ${session === undefined || state.busy ? 'disabled' : ''} aria-label="发送">${icon('send')}</button></div>
    </form>
  </section>`
}

function fleet(): string {
  const enrollment = state.enrollment === undefined ? '' : `<div class="secret-result">
    <strong>一次性注册信息</strong><p>节点 ${escape(state.enrollment.nodeId)} · ${formatDate(state.enrollment.expiresAt)} 到期</p>
    <code>${escape(state.enrollment.code)}</code><p>该注册码只显示本次，请立即写入目标节点的 owner-only 配置。</p>
  </div>`
  const cards = state.nodes.map((node) => {
    const runtimes = state.runtimes.filter(runtime => runtime.nodeId === node.nodeId)
    return `<article class="card"><div class="card-title"><span class="status ${node.online ? 'online' : ''}"></span><h3>${escape(node.displayName)}</h3><span class="pill">${node.status === 'revoked' ? '已吊销' : node.online ? '在线' : '离线'}</span></div>
      <p class="mono">${escape(node.nodeId)}</p><p class="card-meta">最后连接：${formatDate(node.lastSeenAt)}</p>
      ${runtimes.map(runtime => `<button class="runtime" data-runtime-node="${escape(runtime.nodeId)}"><strong>${escape(runtime.runtimeId)}</strong><span>DSH ${escape(runtime.dshVersion)}</span><span>${runtime.capabilities.length} 项能力</span></button>`).join('') || '<p>暂无 Runtime</p>'}
      ${node.status === 'active' ? `<button class="danger" data-revoke-node="${escape(node.nodeId)}">吊销节点</button>` : ''}
    </article>`
  }).join('') || '<div class="notice">尚未注册节点。</div>'
  return panel('节点', '每个 Node Agent 仅建立出站连接。', `<form id="enrollment-form" class="operation-form grid">
    <label>节点 ID<input name="nodeId" required maxlength="64" placeholder="workstation-a"></label>
    <label>显示名称<input name="displayName" required maxlength="128" placeholder="工作电脑"></label>
    <label>有效时间（秒）<input name="expiresInSeconds" type="number" min="60" max="86400" value="900" required></label>
    <button>创建一次性注册</button>
  </form>${enrollment}<div class="cards">${cards}</div>`)
}

function capabilityAvailable(runtime: HubRuntime, capability: string): boolean {
  return runtime.capabilities.some(item => item.name === capability)
}

function capabilityPanel(kind: 'plugins' | 'snapshots' | 'settings'): string {
  const runtime = activeRuntime()
  if (runtime === undefined) return panel('节点能力', '请先选择一个在线节点。', '')
  const heading = kind === 'plugins' ? '插件管理' : kind === 'snapshots' ? '快照' : '设置'
  const capability = `dsh.${kind}`
  if (!capabilityAvailable(runtime, capability)) {
    return panel(heading, `${runtime.nodeId} · ${runtime.runtimeId}`, '<div class="notice">该 Runtime 未声明此能力。</div>')
  }
  let fields: string
  if (kind === 'plugins') {
    fields = `<form class="operation-form" data-capability="dsh.plugins" data-operation="inventory"><button>读取插件清单与锁哈希</button></form>
      <form class="operation-form grid" data-capability="dsh.plugins" data-operation="apply"><label>包名<input name="packageName" required></label><label>精确版本<input name="version" required></label><label>制品 SHA-256（Base64URL）<input name="artifactHash" required></label><label>当前锁哈希<input name="expectedLockHash" required></label><button>校验并应用</button></form>
      <form class="operation-form grid" data-capability="dsh.plugins" data-operation="rollback"><label>包名<input name="packageName" required></label><label>目标锁哈希<input name="targetLockHash" required></label><button>回滚依赖状态</button></form>`
  } else if (kind === 'snapshots') {
    fields = `<form class="operation-form" data-capability="dsh.snapshots" data-operation="list"><button>读取节点快照</button></form>
      <form class="operation-form grid" data-capability="dsh.snapshots" data-operation="create"><label>类型<select name="type"><option>configuration</option><option>dependency</option><option>data</option><option>fleet</option></select></label><button>创建显式快照</button></form>
      <form class="operation-form grid" data-capability="dsh.snapshots" data-operation="restore"><label>快照 ID<input name="snapshotId" required></label><label>当前内容哈希（可选）<input name="expectedCurrentHash"></label><button>校验并恢复</button></form>`
  } else {
    fields = `<form class="operation-form" data-capability="dsh.settings" data-operation="read"><button>读取已脱敏设置</button></form>
      <form class="operation-form grid" data-capability="dsh.settings" data-operation="update"><label>全局 Revision<input name="expectedRevision" required></label><label>命名空间<input name="namespace" required></label><label>命名空间 Revision（可选）<input name="namespaceRevision" type="number" min="0"></label><label class="wide">设置 Patch（JSON 对象）<textarea name="values" rows="7" required>{}</textarea></label><button>按 Revision 更新</button></form>
      <p class="help">密钥字段只显示是否已配置，Hub 不保存凭据值。</p>`
  }
  return panel(heading, `${runtime.nodeId} · ${runtime.runtimeId}`, fields)
}

function files(): string {
  const runtime = activeRuntime()
  if (runtime === undefined) return panel('文件', '请先选择一个在线节点。', '')
  if (!capabilityAvailable(runtime, 'dsh.files')) {
    return panel('文件', `${runtime.nodeId} · ${runtime.runtimeId}`, '<div class="notice">该 Runtime 未声明文件能力。</div>')
  }
  return panel('文件', `${runtime.nodeId} · ${runtime.runtimeId}`, `<form class="operation-form grid" data-capability="dsh.files" data-operation="list"><label>目录路径<input name="path" required></label><label>数量<input name="limit" type="number" min="1" max="2000" value="200"></label><button>列出目录</button></form>
    <form class="operation-form grid" data-capability="dsh.files" data-operation="read"><label>文件路径<input name="path" required></label><label>偏移<input name="offset" type="number" min="0" value="0"></label><label>最大字节<input name="maxBytes" type="number" min="1" max="4194304" value="1048576"></label><button>读取文件</button></form>
    <form class="operation-form grid" data-capability="dsh.files" data-operation="write"><label>文件路径<input name="path" required></label><label>预期哈希（留空表示仅新建）<input name="expectedHash"></label><label>编码<select name="encoding"><option>utf8</option><option>base64</option></select></label><label class="wide">内容<textarea name="data" rows="8" required></textarea></label><button>原子写入</button></form>
    <form class="operation-form grid danger-form" data-capability="dsh.files" data-operation="remove"><label>目标路径<input name="path" required></label><label>预期文件哈希（目录可留空）<input name="expectedHash"></label><label class="check"><input name="recursive" type="checkbox">递归删除目录</label><button>删除目标</button></form>`)
}

function terminal(): string {
  const runtime = activeRuntime()
  if (runtime === undefined) return panel('终端', '请先选择一个在线节点。', '')
  const available = capabilityAvailable(runtime, 'dsh.terminals')
  const body = available ? `<form id="terminal-open" class="operation-form"><label>工作目录（可选）<input name="cwd"></label><button>打开终端</button></form>
    <pre class="terminal-output" id="terminal-output">${escape(terminalText || '终端尚未连接。')}</pre>
    <form id="terminal-input" class="terminal-input"><input name="input" autocomplete="off" placeholder="输入命令并回车" ${terminalSocket?.readyState === WebSocket.OPEN ? '' : 'disabled'}><button ${terminalSocket?.readyState === WebSocket.OPEN ? '' : 'disabled'}>发送</button></form>`
    : '<div class="notice">该 Runtime 未声明终端能力。</div>'
  return panel('终端', `${runtime.nodeId} · ${runtime.runtimeId}`, body)
}

function activityPanel(): string {
  const commandRows = state.commands.map(command => `<tr><td>${formatDate(command.createdAt)}</td><td>${escape(command.nodeId || '—')}</td><td>${escape(`${command.capability || '—'}.${command.operation || '—'}`)}</td><td><span class="status-text ${escape(command.status)}">${escape(command.status)}</span></td></tr>`).join('')
  const auditRows = state.audit.map(record => `<tr><td>${formatDate(record.occurredAt)}</td><td>${escape(record.actor)}</td><td>${escape(record.action)}</td><td>${escape(record.nodeId || '—')}</td><td>${escape(record.outcome)}</td></tr>`).join('')
  return panel('操作记录', state.selectedNode === undefined ? '全部节点' : state.selectedNode, `<button class="refresh" data-action="refresh-activity">刷新</button>
    <h2 class="section-title">命令</h2><div class="table-wrap"><table><thead><tr><th>时间</th><th>节点</th><th>操作</th><th>状态</th></tr></thead><tbody>${commandRows || '<tr><td colspan="4">暂无命令</td></tr>'}</tbody></table></div>
    <h2 class="section-title">审计链</h2><div class="table-wrap"><table><thead><tr><th>时间</th><th>主体</th><th>事件</th><th>节点</th><th>结果</th></tr></thead><tbody>${auditRows || '<tr><td colspan="5">暂无记录</td></tr>'}</tbody></table></div>`)
}

function panel(title: string, subtitle: string, body: string): string {
  const result = state.operationResult === undefined
    ? ''
    : `<pre id="operation-result" class="operation-result">${escape(state.operationResult)}</pre>`
  return `<section class="content panel-view"><header class="topbar"><button class="icon mobile-menu" data-action="sidebar-open" aria-label="打开导航">${icon('menu')}</button><div><h1>${escape(title)}</h1><p>${escape(subtitle)}</p></div></header><div class="panel-body">${body}${result}</div></section>`
}

function main(): string {
  if (state.view === 'chat') return chat()
  if (state.view === 'fleet') return fleet()
  if (state.view === 'terminal') return terminal()
  if (state.view === 'files') return files()
  if (state.view === 'activity') return activityPanel()
  return capabilityPanel(state.view)
}

function render(): void {
  const navigation: ReadonlyArray<readonly [View, string]> = [
    ['chat', '对话'], ['fleet', '节点'], ['files', '文件'], ['terminal', '终端'],
    ['plugins', '插件'], ['snapshots', '快照'], ['settings', '设置'], ['activity', '记录'],
  ]
  root.innerHTML = `<div class="shell">${sidebar()}${main()}<nav class="rail" aria-label="功能">
    ${navigation.map(([view, label]) => `<button data-view="${view}" class="${state.view === view ? 'active' : ''}">${label}</button>`).join('')}
  </nav>${state.mobileSidebar ? '<button class="scrim" data-action="sidebar-close" aria-label="关闭导航"></button>' : ''}</div>
  ${state.error ? `<div class="toast" role="alert">${escape(state.error)}<button data-action="clear-error">×</button></div>` : ''}
  <dialog id="new-dialog"><form method="dialog" id="new-form"><h2>新建会话</h2><label>节点 Runtime<select name="target" required>${state.runtimes.filter(runtime => runtime.online && capabilityAvailable(runtime, 'dsh.sessions')).map(runtime => `<option value="${escape(`${runtime.nodeId}\0${runtime.runtimeId}`)}">${escape(`${state.nodes.find(node => node.nodeId === runtime.nodeId)?.displayName || runtime.nodeId} · ${runtime.runtimeId}`)}</option>`).join('')}</select></label><label>工作目录（可选）<input name="workspacePath"></label><label>标题（可选）<input name="title"></label><div class="dialog-actions"><button value="cancel">取消</button><button value="default" data-action="create-session">创建</button></div></form></dialog>`
  bind()
}

function bind(): void {
  root.querySelectorAll<HTMLElement>('[data-view]').forEach((element) => { element.addEventListener('click', () => {
    state.view = element.dataset.view as View
    state.operationResult = undefined
    if (state.view === 'activity') void loadActivity()
    else render()
  }) })
  root.querySelectorAll<HTMLElement>('[data-node]').forEach((element) => { element.addEventListener('click', () => {
    state.selectedNode = element.dataset.node || undefined
    state.selectedSession = undefined
    state.messages = []
    state.operationResult = undefined
    state.mobileSidebar = false
    if (state.view === 'activity') void loadActivity()
    else render()
  }) })
  root.querySelectorAll<HTMLElement>('[data-session]').forEach((element) => { element.addEventListener('click', () => {
    state.selectedSession = element.dataset.session
    state.view = 'chat'
    state.mobileSidebar = false
    void loadConversation()
  }) })
  root.querySelectorAll<HTMLElement>('[data-runtime-node]').forEach((element) => { element.addEventListener('click', () => {
    state.selectedNode = element.dataset.runtimeNode
    state.view = 'chat'
    render()
  }) })
  root.querySelector('[data-action="sidebar-open"]')?.addEventListener('click', () => { state.mobileSidebar = true; render() })
  root.querySelectorAll('[data-action="sidebar-close"]').forEach((element) => { element.addEventListener('click', () => { state.mobileSidebar = false; render() }) })
  root.querySelector('[data-action="clear-error"]')?.addEventListener('click', () => { state.error = undefined; render() })
  root.querySelector('[data-action="new-session"]')?.addEventListener('click', () => { (root.querySelector('#new-dialog') as HTMLDialogElement).showModal() })
  root.querySelector('[data-action="refresh-activity"]')?.addEventListener('click', () => { void loadActivity() })
  root.querySelector('#new-form')?.addEventListener('submit', (event) => { void createSession(event) })
  root.querySelector('#composer')?.addEventListener('submit', (event) => { void sendMessage(event) })
  root.querySelector('#enrollment-form')?.addEventListener('submit', (event) => { void enroll(event) })
  root.querySelector('#terminal-open')?.addEventListener('submit', (event) => { openTerminal(event) })
  root.querySelector('#terminal-input')?.addEventListener('submit', (event) => { sendTerminal(event) })
  root.querySelectorAll<HTMLElement>('[data-revoke-node]').forEach((element) => { element.addEventListener('click', () => { void revoke(element.dataset.revokeNode as string) }) })
  root.querySelectorAll<HTMLFormElement>('.operation-form[data-capability]').forEach((form) => { form.addEventListener('submit', (event) => { void runOperation(event) }) })
  const messages = root.querySelector('#messages')
  if (messages !== null) messages.scrollTop = messages.scrollHeight
}

function openTerminal(event: Event): void {
  event.preventDefault()
  const runtime = activeRuntime()
  if (runtime === undefined) return
  terminalSocket?.close()
  terminalText = ''
  const data = new FormData(event.currentTarget as HTMLFormElement)
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = new URL('/hub/v1/terminal', `${protocol}//${location.host}`)
  url.searchParams.set('nodeId', runtime.nodeId)
  url.searchParams.set('runtimeId', runtime.runtimeId)
  url.searchParams.set('columns', '100')
  url.searchParams.set('rows', '32')
  const cwd = formString(data, 'cwd').trim()
  if (cwd !== '') url.searchParams.set('cwd', cwd)
  terminalSocket = new WebSocket(url)
  terminalSocket.addEventListener('message', (message) => {
    if (typeof message.data !== 'string') throw new Error('terminal server sent a non-text frame')
    const frame = JSON.parse(message.data) as { type?: unknown; data?: unknown; eof?: unknown; exitCode?: unknown }
    if (frame.type === 'output' && typeof frame.data === 'string') terminalText += frame.data
    if (frame.type === 'output' && frame.eof === true) {
      const exitCode = typeof frame.exitCode === 'number' ? String(frame.exitCode) : ''
      terminalText += `\n[进程已退出：${exitCode}]\n`
    }
    const output = root.querySelector<HTMLPreElement>('#terminal-output')
    if (output !== null) { output.textContent = terminalText; output.scrollTop = output.scrollHeight }
  })
  terminalSocket.addEventListener('open', () => { render() })
  terminalSocket.addEventListener('close', () => { render() })
  terminalSocket.addEventListener('error', () => { state.error = '终端连接失败'; render() })
}

function sendTerminal(event: Event): void {
  event.preventDefault()
  if (terminalSocket?.readyState !== WebSocket.OPEN) return
  const form = event.currentTarget as HTMLFormElement
  const input = form.elements.namedItem('input') as HTMLInputElement
  terminalSocket.send(JSON.stringify({ type: 'input', data: `${input.value}\n` }))
  input.value = ''
}

async function refresh(renderAfter = true): Promise<void> {
  try {
    const next = await baseline()
    state.nodes = next.nodes
    state.runtimes = next.runtimes
    state.sessions = next.sessions
    if (renderAfter) render()
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
    if (renderAfter) render()
  }
}

async function loadActivity(): Promise<void> {
  try {
    const next = await activity(state.selectedNode)
    state.commands = next.commands
    state.audit = next.records
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
  }
  render()
}

async function loadConversation(): Promise<void> {
  const session = activeSession()
  if (session === undefined) { render(); return }
  state.busy = true
  render()
  try {
    const command = await invoke({
      nodeId: session.nodeId,
      runtimeId: session.runtimeId,
      capability: 'dsh.sessions',
      operation: 'read',
      payload: { sessionId: session.sourceId, afterSequence: 0, limit: 2_000 },
    })
    const result = command.result as { events?: unknown[] } | undefined
    state.messages = conversation(result?.events ?? [])
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
  } finally {
    state.busy = false
    render()
  }
}

async function sendMessage(event: Event): Promise<void> {
  event.preventDefault()
  const session = activeSession()
  const form = event.currentTarget as HTMLFormElement
  const text = formString(new FormData(form), 'message').trim()
  if (session === undefined || text === '') return
  state.busy = true
  state.messages.push({ id: crypto.randomUUID(), role: 'user', text })
  render()
  try {
    await invoke({
      nodeId: session.nodeId,
      runtimeId: session.runtimeId,
      capability: 'dsh.sessions',
      operation: 'message.append',
      payload: { clientMutationId: crypto.randomUUID(), sessionId: session.sourceId, text, attachments: [] },
    })
    await loadConversation()
  } catch (error) {
    state.busy = false
    state.error = error instanceof Error ? error.message : String(error)
    render()
  }
}

async function createSession(event: Event): Promise<void> {
  event.preventDefault()
  const data = new FormData(event.currentTarget as HTMLFormElement)
  const [nodeId, runtimeId] = formString(data, 'target').split('\0')
  if (!nodeId || !runtimeId) return
  try {
    const workspacePath = formString(data, 'workspacePath').trim()
    const title = formString(data, 'title').trim()
    const command = await invoke({
      nodeId,
      runtimeId,
      capability: 'dsh.sessions',
      operation: 'create',
      payload: {
        clientMutationId: crypto.randomUUID(),
        ...(workspacePath === '' ? {} : { workspacePath }),
        ...(title === '' ? {} : { title }),
      },
    })
    await refresh(false)
    const created = command.result as { sessionId?: string } | undefined
    state.selectedSession = state.sessions.find(session =>
      session.nodeId === nodeId && session.runtimeId === runtimeId
      && session.sourceId === created?.sessionId)?.hubSessionId
    render()
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
    render()
  }
}

async function enroll(event: Event): Promise<void> {
  event.preventDefault()
  const data = new FormData(event.currentTarget as HTMLFormElement)
  try {
    state.enrollment = await createEnrollment({
      nodeId: formString(data, 'nodeId').trim(),
      displayName: formString(data, 'displayName').trim(),
      expiresInSeconds: Number(formString(data, 'expiresInSeconds')),
    })
    render()
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
    render()
  }
}

async function revoke(nodeId: string): Promise<void> {
  if (!window.confirm(`确认吊销节点 ${nodeId}？当前连接会立即断开。`)) return
  try {
    await revokeNode(nodeId)
    state.enrollment = undefined
    await refresh()
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
    render()
  }
}

function operationPayload(capability: string, operation: string, data: FormData): Record<string, unknown> {
  const value = (name: string) => formString(data, name).trim()
  if (capability === 'dsh.plugins') {
    if (operation === 'inventory') return {}
    if (operation === 'apply') return {
      packageName: value('packageName'), version: value('version'),
      artifactHash: value('artifactHash'), expectedLockHash: value('expectedLockHash'),
    }
    return { packageName: value('packageName'), targetLockHash: value('targetLockHash') }
  }
  if (capability === 'dsh.snapshots') {
    if (operation === 'list') return {}
    if (operation === 'create') return {
      clientMutationId: crypto.randomUUID(), type: value('type'), includeSecretValues: false,
    }
    const expectedCurrentHash = value('expectedCurrentHash')
    return { snapshotId: value('snapshotId'), ...(expectedCurrentHash === '' ? {} : { expectedCurrentHash }) }
  }
  if (capability === 'dsh.settings') {
    if (operation === 'read') return {}
    const namespaceRevision = value('namespaceRevision')
    return {
      expectedRevision: value('expectedRevision'),
      patch: {
        namespace: value('namespace'),
        values: JSON.parse(formString(data, 'values')) as unknown,
        ...(namespaceRevision === '' ? {} : { namespaceRevision: Number(namespaceRevision) }),
      },
    }
  }
  if (capability === 'dsh.files') {
    if (operation === 'list') return { path: value('path'), limit: Number(value('limit')) }
    if (operation === 'read') return {
      path: value('path'), offset: Number(value('offset')), maxBytes: Number(value('maxBytes')),
    }
    const expectedHash = value('expectedHash')
    if (operation === 'write') return {
      path: value('path'), expectedHash: expectedHash === '' ? null : expectedHash,
      encoding: value('encoding'), data: formString(data, 'data'),
    }
    return {
      path: value('path'), expectedHash: expectedHash === '' ? null : expectedHash,
      recursive: data.has('recursive'),
    }
  }
  throw new Error('未知节点能力')
}

async function runOperation(event: Event): Promise<void> {
  event.preventDefault()
  const form = event.currentTarget as HTMLFormElement
  const runtime = activeRuntime()
  if (runtime === undefined) return
  const capability = form.dataset.capability as string
  const operation = form.dataset.operation as string
  try {
    const command = await invoke({
      nodeId: runtime.nodeId,
      runtimeId: runtime.runtimeId,
      capability,
      operation,
      payload: operationPayload(capability, operation, new FormData(form)),
    })
    state.operationResult = JSON.stringify(command.result, null, 2)
    render()
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
    render()
  }
}

await refresh()
const events = new EventSource('/hub/v1/events')
events.addEventListener('stream.frame', (event) => {
  try {
    const frame = JSON.parse((event as MessageEvent<string>).data) as { data?: { capability?: unknown } }
    if (frame.data?.capability !== 'dsh.sessions') return
  } catch {
    return
  }
  void refresh(false)
  if (activeSession() !== undefined) void loadConversation()
})
events.addEventListener('node.connected', () => { void refresh() })
events.addEventListener('node.disconnected', () => { void refresh() })
events.addEventListener('runtime.hello', () => { void refresh() })
events.addEventListener('runtime.goodbye', () => { void refresh() })
events.addEventListener('command.result', () => { void refresh(false) })
