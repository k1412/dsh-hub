import { submitLifecycle, verifyLifecycle } from './lifecycle.ts'
import { controlPage, grantsPage, controlResult } from './control-pages.ts'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { readFile, stat } from 'node:fs/promises'
import { resolve, basename } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import { ControlRouter, capabilities, type Grant } from './control.ts'
import { GatewayTunnel, ControlRPC } from '@k1412/dsh-gateway-transport'
import { networkAssets, type GatewayNetworkStatus } from '@k1412/dsh-gateway-network'
import { GatewayStore, digest, matches, type Mode } from './store.ts'
import { page, nodesPage, failurePage, escape, css } from './pages.ts'

interface Networks {
  status(): Promise<GatewayNetworkStatus>
  endpoint(mode: Mode): Promise<string> | string
  loginTailscale(): Promise<unknown>
}
export interface GatewayOptions {
  publicUrl: string
  downloadUrl?: string
  statePath: string
  downloadsDirectory: string
  installerPath: string
  networks: Networks
  /** Verify trusted proxy JWT at the operator origin only. */
  authenticateOperator?: (request: IncomingMessage) => Promise<boolean>
  adminPassword?: string
  originSecret?: string
  /** For local integration tests, node origins use *.localhost and the listener port. */
  nodeOrigin?: (nodeId: string) => string
  requestTimeoutMs?: number
}
interface Peer { socket: WebSocket; tunnel: GatewayTunnel; alive: boolean; control?: ControlRPC; capabilities: string[]; generation: string; runtimeId: string; version: string }
const COOKIE = 'dsh_gateway_session'
const HEADER_SKIP = /^(host|connection|upgrade|transfer-encoding|keep-alive|proxy-authorization|proxy-authenticate|authorization|cookie|cf-.+|x-dsh-origin-secret|sec-websocket-.+)$/i
function token(request: IncomingMessage): string {
  return (request.headers.cookie ?? '').split(';').map(p => p.trim()).find(p => p.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? ''
}
function scalar(value: unknown, max = 256): string {
  if (typeof value !== 'string' || value.length > max || [...value].some(c => c.charCodeAt(0) < 32)) throw new Error('字段格式无效。')
  return value
}
async function body(request: IncomingMessage, limit = 16_384): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) { size += chunk.length as number; if (size > limit) throw new Error('请求过大。'); chunks.push(Buffer.from(chunk)) }
  const raw = Buffer.concat(chunks).toString('utf8')
  if ((request.headers['content-type'] ?? '').includes('application/json')) {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求格式无效。')
    return parsed as Record<string, unknown>
  }
  return Object.fromEntries(new URLSearchParams(raw))
}
function documentReferrerPolicy(type: string, disposition = ''): string {
  // no-referrer makes HTML form POSTs send Origin:null, including same-origin
  // submissions. Preserve their Origin while withholding cross-origin referrers.
  return /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(type)
    && !/^attachment(?:\s*;|$)/i.test(disposition) ? 'same-origin' : 'no-referrer'
}
function response(res: ServerResponse, status: number, value: string | object, type?: string): void {
  const json = typeof value !== 'string'
  const contentType = type ?? (json ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8')
  res.writeHead(status, { 'content-type': contentType,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': documentReferrerPolicy(contentType),
    ...(json || type ? {} : { 'content-security-policy': "default-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" }) })
  res.end(json ? JSON.stringify(value) : value)
}
function redirect(res: ServerResponse, location: string, cookie?: string): void {
  res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...(cookie ? { 'set-cookie': cookie } : {}) }); res.end()
}

/** Only an explicit, valid gzip preference authorizes transforming a response. */
function acceptsGzip(value: string | undefined): boolean {
  const preferences = (value ?? '').split(',').map(entry => entry.trim()).filter(entry => /^gzip(?:\s*;|$)/i.test(entry))
  return preferences.length > 0 && preferences.every(entry => {
    const match = /^gzip\s*(?:;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?\s*$/i.exec(entry)
    return !!match && (match[1] === undefined || Number(match[1]) > 0)
  })
}

function varyEncoding(headers: Record<string, string>): void {
  const values = (headers.vary ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (!values.some(value => value === '*' || value.toLowerCase() === 'accept-encoding')) values.push('Accept-Encoding')
  headers.vary = values.join(', ')
}

/** rc.2 advertises both individual bundles and /plugins/??a/client.js,b/client.js&rev=... . */
function pluginCodeUrl(url: URL): boolean {
  if (/^\/plugins\/.+\/client\.js$/.test(url.pathname)) return true
  if (url.pathname !== '/plugins/' || !/^\?\?[^?&]+&rev=[a-f0-9]{12}$/.test(url.search)) return false
  return url.search.slice(2, url.search.indexOf('&')).split(',')
    .every(file => /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+\/client\.js$/i.test(file))
}

export function createGateway(options: GatewayOptions) {
  const root = new URL(options.publicUrl)
  const downloads = new URL(options.downloadUrl ?? options.publicUrl)
  if (root.pathname !== '/' || downloads.pathname !== '/') throw new Error('Gateway URL must have no mount path')
  if (!options.authenticateOperator && !options.adminPassword) throw new Error('Configure operator authentication before starting Hub')
  if (options.adminPassword && options.adminPassword.length < 16) throw new Error('Administrator password must be at least 16 characters')
  const passwordHash = options.adminPassword ? digest(options.adminPassword) : undefined
  const originHash = options.originSecret ? digest(options.originSecret) : undefined
  const store = new GatewayStore(options.statePath)
  const peers = new Map<string, Peer>()
  const supervisors = new Map<string, Peer>()
  const router = new ControlRouter(() => store.grants(), peers, id => { const n = store.node(id); return !!n && !n.revokedAt })
  let closing = false
  const browserSockets = new Set<WebSocket>()
  const agentSockets = new WebSocketServer({ noServer: true, maxPayload: 262144, perMessageDeflate: false })
  agentSockets.on('headers', (headers, request) => { if (request.headers['x-dsh-control'] === '2') headers.push('x-dsh-control: 2') })
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 262144, perMessageDeflate: false })
  const attempts = new Map<string, { count: number; reset: number }>()
  const nodeOrigin = options.nodeOrigin ?? ((id: string) => `${root.protocol}//${id}.${root.host}`)
  const cookie = (value: string, clear = false) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 28_800}${root.protocol === 'https:' ? '; Secure' : ''}`
  const permittedOrigin = (request: IncomingMessage, expected: string) => request.headers.origin === expected
  function rate(request: IncomingMessage): boolean {
    const key = request.socket.remoteAddress ?? 'unknown'; const now = Date.now()
    let entry = attempts.get(key)
    if (!entry || entry.reset <= now) { entry = { count: 0, reset: now + 60_000 }; attempts.set(key, entry) }
    return ++entry.count <= 30
  }
  function hostNode(request: IncomingMessage): string | undefined {
    const host = request.headers.host
    return store.nodes().find(n => new URL(nodeOrigin(n.id)).host === host)?.id
  }
  function originAllowed(request: IncomingMessage): boolean {
    if (!originHash) return true
    const value = request.headers['x-dsh-origin-secret']
    return typeof value === 'string' && matches(value, originHash)
  }
  async function operator(request: IncomingMessage): Promise<boolean> {
    if (request.headers.host !== root.host) return false
    if (store.authorized(token(request), 'operator')) return true
    try { return await options.authenticateOperator?.(request) ?? false } catch { return false }
  }
  async function manifest(inviteToken: string) {
    const invite = store.invitation(inviteToken)
    if (!invite || (invite.expiresAt <= Date.now() && !invite.nodeId)) throw new Error('邀请已失效，请重新生成。')
    const packageBytes = await readFile(resolve(options.downloadsDirectory, 'gateway-node.tgz'))
    const { createHash } = await import('node:crypto')
    return { protocol: 1, hubUrl: root.origin, downloadUrl: downloads.origin, mode: invite.mode, endpoint: invite.endpoint, expiresAt: invite.expiresAt, claimed: !!invite.nodeId,
      inviteToken, name: invite.name,
      package: { url: `${downloads.origin}/downloads/gateway-node.tgz`, sha256: createHash('sha256').update(packageBytes).digest('hex') },
      networkBinaries: Object.fromEntries((['amd64', 'arm64'] as const).map(architecture => [`linux-${architecture}`, networkAssets(architecture).map(asset => ({ ...asset, url: `${downloads.origin}/downloads/${asset.file}` }))])) }
  }
  async function native(request: IncomingMessage, res: ServerResponse, nodeId: string): Promise<void> {
    const node = store.node(nodeId)
    const url = new URL(request.url ?? '/', nodeOrigin(nodeId))
    if (!node || node.revokedAt) { response(res, 410, failurePage('此节点的连接已撤销。', `${root.origin}/`)); return }
    if (url.pathname === '/_hub/ticket') {
      if (!store.consumeTicket(url.searchParams.get('ticket') ?? '', nodeId)) { response(res, 403, failurePage('打开链接已过期，请从节点列表重新打开。', `${root.origin}/`)); return }
      redirect(res, '/', cookie(store.session(nodeId))); return
    }
    if (!store.authorized(token(request), nodeId)) {
      if (request.method === 'GET' && (request.headers.accept ?? '').includes('text/html')) redirect(res, `${root.origin}/open/${nodeId}`)
      else response(res, 401, { error: '浏览器登录已过期，请返回 Hub 重新打开节点。' })
      return
    }
    if (!['GET', 'HEAD'].includes(request.method ?? '') && !permittedOrigin(request, new URL(nodeOrigin(nodeId)).origin)) { response(res, 403, { error: 'Origin mismatch' }); return }
    const peer = peers.get(nodeId)
    if (!peer || !peer.tunnel.isOpen) {
      const message = '节点当前离线。请检查节点 DSH 和连接工具，然后从 Hub 重新打开。'
      response(res, 503, url.pathname.startsWith('/api') ? { error: message } : failurePage(message, `${root.origin}/`)); return
    }
    const abort = new AbortController()
    request.once('aborted', () => abort.abort())
    res.once('close', () => { if (!res.writableFinished) abort.abort() })
    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers)) if (value !== undefined && !HEADER_SKIP.test(key)) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
    const init = { method: request.method ?? 'GET', headers, signal: abort.signal, ...(hasBody ? { body: Readable.toWeb(request) as ReadableStream<Uint8Array>, duplex: 'half' as const } : {}) }
    const reply = await peer.tunnel.fetch(new Request(url, init))
    const out: Record<string, string> = {}
    reply.headers.forEach((value, key) => { if (!/^(connection|transfer-encoding|set-cookie)$/i.test(key)) out[key] = value })
    out['referrer-policy'] = reply.status >= 300 && reply.status < 400 ? 'no-referrer'
      : documentReferrerPolicy(out['content-type'] ?? '', out['content-disposition'])
    out['x-content-type-options'] = 'nosniff'
    // Compress only installed browser code on this hop. APIs, events, downloads
    // and pre-encoded/ranged representations retain their native byte contract.
    const pluginCode = pluginCodeUrl(url)
    const staticCode = (/^\/assets\/.+\.(?:js|css)$/.test(url.pathname) || pluginCode)
      && /^(?:text\/(?:javascript|css)|application\/(?:javascript|x-javascript))(?:\s*;|$)/i.test(out['content-type'] ?? '')
    const eligibleCode = staticCode && reply.status === 200 && ['GET', 'HEAD'].includes(request.method ?? '')
      && !reply.headers.has('content-range') && !request.headers.range
      && !/^attachment(?:\s*;|$)/i.test(out['content-disposition'] ?? '')
      && !/(?:^|,)\s*no-transform\s*(?:,|$)/i.test(out['cache-control'] ?? '')
    if (eligibleCode) varyEncoding(out)
    const gzip = eligibleCode && (reply.body !== null || request.method === 'HEAD')
      && !reply.headers.has('content-encoding') && acceptsGzip(request.headers['accept-encoding'])
    if (gzip) {
      out['content-encoding'] = 'gzip'
      for (const header of ['content-length', 'etag', 'last-modified', 'content-md5', 'digest', 'content-digest', 'repr-digest', 'accept-ranges']) delete out[header]
    }
    // Trust versioned URLs only when the native owner also promises immutability.
    // Cache lives in this node origin's browser; no Hub or shared proxy cache.
    const revisions = url.searchParams.getAll('rev')
    const revisioned = pluginCode && revisions.length === 1 && /^[a-f0-9]{12}$/.test(revisions[0] ?? '')
    const hashedAsset = /^\/assets\/(?:[^/]+\/)*[^/]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/.test(url.pathname)
    const nativeCache = reply.headers.get('cache-control') ?? ''
    const immutable = /(?:^|,)\s*immutable\s*(?:,|$)/i.test(nativeCache)
      && !/(?:^|,)\s*(?:no-store|no-cache)\s*(?:=|,|$)/i.test(nativeCache)
    out['cache-control'] = eligibleCode && immutable && (revisioned || hashedAsset)
      ? 'private, max-age=31536000, immutable' : 'private, no-store'
    res.writeHead(reply.status, out)
    if (request.method === 'HEAD' || !reply.body) { res.end(); await reply.body?.cancel(); return }
    if (gzip) {
      const source = Readable.fromWeb(reply.body as import('node:stream/web').ReadableStream)
      // pipeline preserves backpressure and destroys every per-request stream
      // on browser abort or native failure, cancelling only this tunnel call.
      await pipeline(source, createGzip(), res, { signal: abort.signal })
      return
    }
    const reader = reply.body.getReader()
    try {
      while (!abort.signal.aborted) {
        const item = await reader.read(); if (item.done) break
        if (!res.write(item.value)) await new Promise<void>((ok, fail) => {
          const cleanup = () => { res.off('drain', done); res.off('close', closed) }
          const done = () => { cleanup(); ok() }; const closed = () => { cleanup(); fail(new Error('Browser disconnected')) }
          res.once('drain', done); res.once('close', closed)
        })
      }
      res.end()
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
  async function browserRequest(request: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!originAllowed(request)) { response(res, 403, { error: 'Proxy authorization required' }); return }
    const url = new URL(request.url ?? '/', root)
    const host = request.headers.host
    if (url.pathname === '/healthz') { response(res, 200, { ok: true, version: '2.0.0-alpha.1', experiment: 'node-control', controlProtocol: 1 }); return }
    if (url.pathname === '/hub.css') { response(res, 200, css, 'text/css; charset=utf-8'); return }
    if (host === downloads.host || host === root.host) {
      if (url.pathname === '/install.sh' && request.method === 'GET') { response(res, 200, await readFile(options.installerPath, 'utf8'), 'text/x-shellscript; charset=utf-8'); return }
      if (url.pathname.startsWith('/downloads/') && ['GET', 'HEAD'].includes(request.method ?? '')) {
        const name = url.pathname.slice('/downloads/'.length)
        const allowed = ['gateway-node.tgz', 'network-pins.json', 'SHA256SUMS', ...['amd64', 'arm64'].flatMap(a => networkAssets(a as 'amd64' | 'arm64')).map(a => a.file)]
        if (basename(name) !== name || !allowed.includes(name)) { response(res, 404, { error: 'Unknown download' }); return }
        const file = resolve(options.downloadsDirectory, name)
        const info = await stat(file)
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': info.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        if (request.method === 'HEAD') res.end(); else { const { createReadStream } = await import('node:fs'); const stream = createReadStream(file); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res) }
        return
      }
      if (url.pathname.startsWith('/api/enrollment/') && request.method === 'GET') {
        if (!rate(request)) { response(res, 429, { error: 'Too many requests' }); return }
        response(res, 200, await manifest(url.pathname.slice('/api/enrollment/'.length))); return
      }
    }
    const nodeId = hostNode(request)
    if (nodeId) { await native(request, res, nodeId); return }
    if (host !== root.host) { response(res, 404, { error: 'Unknown Hub host' }); return }
    if (url.pathname === '/login') {
      if (!passwordHash) { response(res, 401, failurePage('请通过配置的身份认证入口登录。')); return }
      if (request.method === 'POST') {
        if (!permittedOrigin(request, root.origin) || !rate(request)) { response(res, 403, failurePage('登录请求无效，请稍后重试。')); return }
        const input = await body(request)
        if (!matches(scalar(input.password, 512), passwordHash)) { response(res, 401, failurePage('登录密码不正确。')); return }
        redirect(res, '/', cookie(store.session('operator'))); return
      }
      response(res, 200, page('登录', '<h1>登录 Hub</h1><form class="card" method="post" action="/login"><label for="password">管理员密码</label><input id="password" name="password" type="password" autocomplete="current-password" required><nav><button class="primary">登录</button></nav></form>')); return
    }
    if (!await operator(request)) { if (passwordHash) redirect(res, '/login'); else response(res, 401, failurePage('身份认证已过期，请重新登录。')); return }
    if (request.method === 'POST' && !permittedOrigin(request, root.origin)) { response(res, 403, { error: 'Origin mismatch' }); return }
    if (url.pathname === '/control/audit') { response(res, 200, page('控制审计', `<h1>控制审计摘要</h1><a href="/">返回</a><pre>${escape(JSON.stringify(store.auditRows(), null, 2))}</pre>`)); return }
    if (url.pathname === '/control/grants') {
      if (request.method === 'POST') {
        const input = await body(request)
        if (input.revoke) { store.revokeGrant(scalar(input.revoke)); store.audit('', 'grant.revoke', scalar(input.revoke)); await router.reconcile() }
        else {
          const source = store.node(scalar(input.source)), target = store.node(scalar(input.target))
          const duration = Number(input.durationSeconds)
          if (input.durationSeconds !== undefined && ![3600,86400,604800,2592000].includes(duration)) throw new Error('Invalid grant duration')
          const workspace = scalar(input.workspace, 1024), expiresAt = input.durationSeconds === undefined ? Number(input.expiresAt) : Date.now() + duration * 1000
          const requested = scalar(input.capabilities).split(',').map(v => v.trim())
          if (!source || !target || source.id === target.id || source.revokedAt || target.revokedAt || !workspace || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 86400000 * 30 || requested.some(v => !(capabilities as readonly string[]).includes(v))) throw new Error('Invalid grant')
          const grant: Grant = { id: randomUUID(), source: source.id, target: target.id, sourceRuntime: source.runtimeId, targetRuntime: target.runtimeId, workspace, expiresAt, capabilities: requested }
          store.grant(grant); store.audit(target.id, 'grant.create', grant.id)
        }
        redirect(res, '/control/grants'); return
      }
      response(res, 200, grantsPage(store.grants(), store.nodes())); return
    }
    const controlRoute = /^\/control\/(n[a-f0-9]{16})$/.exec(url.pathname)
    if (controlRoute) {
      const id = controlRoute[1] as string, peer = peers.get(id), supervisor = supervisors.get(id)
      if ((!peer?.control || !peer.capabilities.includes('management')) && !supervisor?.control) { response(res, 409, failurePage('此节点离线或未启用实验控制能力。')); return }
      if (request.method === 'POST') {
        const input = await body(request)
        const method = scalar(input.method)
        if (!['management.submit','management.cancel','management.check','management.recover','management.retry-persistence','task.cleanup'].includes(method)) throw new Error('Unsupported operation')
        store.audit(id, method === 'management.submit' ? scalar(input.action) : method, scalar(input.requestId ?? '', 80))
        const lifecycleAction = method === 'management.recover' || input.controller === 'supervisor' || typeof input.action === 'string' && input.action.startsWith('dsh.')
        if (['dsh.start','dsh.install'].includes(String(input.action)) && peers.has(id)) throw new Error('This Runtime is already online; a second Runtime must not be started')
        const controller = lifecycleAction ? (supervisor?.capabilities.includes('lifecycle') ? supervisor.control : undefined) : peer?.control
        if (!controller) throw new Error(lifecycleAction ? '独立生命周期监督器离线或不支持此操作；请先启动节点监督服务。' : 'Runtime 管理服务离线或不支持此操作。')
        if (method === 'task.cleanup' && input.retentionMs !== undefined) input.retentionMs = Number(input.retentionMs)
        const result = method==='management.submit' && lifecycleAction && supervisor
          ? await submitLifecycle(input,peer,supervisor,()=>peers.get(id)===peer&&supervisors.get(id)===supervisor)
          : await controller.call(method, method === 'task.cleanup' ? (input.retentionMs === undefined ? {} : { retentionMs: input.retentionMs }) : input)
        if(method==='management.submit' && lifecycleAction)verificationNodes.add(id)
        response(res, 200, controlResult(result, id)); return
      }
      const inventory = { runtime: peer?.control && peer.capabilities.includes('management') ? await peer.control.call('management.inventory', {}) : 'Runtime offline or management unsupported', supervisor: supervisor?.control ? await supervisor.control.call('management.inventory', {}) : 'external-supervisor-required' }
      response(res, 200, controlPage(id, store.node(id)?.name ?? id, inventory)); return
    }
    if (url.pathname === '/' && request.method === 'GET') { response(res, 200, nodesPage(store.nodes(), new Set(peers.keys()))); return }
    if (url.pathname === '/api/nodes' && request.method === 'GET') {
      response(res, 200, { nodes: store.nodes().map(({ id, name, mode, dshVersion, runtimeId, lastSeen, revokedAt }) => ({ id, name, mode, dshVersion, runtimeId, lastSeen, revoked: !!revokedAt, online: peers.has(id) })) }); return
    }
    if (url.pathname === '/network') {
      const status = await options.networks.status()
      const cards = (['tailscale', 'tailcat'] as const).map(mode => {
        const item = status[mode]
        const login = 'loginUrl' in item && typeof item.loginUrl === 'string' && item.loginUrl.startsWith('https://') ? `<p><a class="button primary" href="${escape(item.loginUrl)}" target="_blank" rel="noopener noreferrer">打开 Tailscale 登录页面</a></p>` : ''
        return `<section class="card"><h2>${mode === 'tailscale' ? 'Tailscale' : 'Tailcat'}</h2><p>${escape(({ ready: '已就绪', 'needs-login': '等待登录', starting: '正在启动', unavailable: '暂不可用' })[item.state])}</p>${item.error ? `<p class="danger">${escape(item.error)}</p>` : ''}${login}${mode === 'tailscale' && 'mode' in item && item.mode === 'managed' ? '<form method="post" action="/network/tailscale/login"><button>配置并登录 Tailscale</button></form>' : ''}<p class="muted">${mode === 'tailscale' ? '两端加入同一 Tailnet，使用已登录的设备身份连接。' : '无需 Tailscale 账号，使用邀请配对，通过加密通道连接。'}</p></section>`
      }).join('')
      response(res, 200, page('连接设置', `<h1>连接设置</h1><p class="muted">生成安装命令时，为每个 node 选择一种连接方式。</p><nav><a href="/">返回节点</a><a href="/network">刷新状态</a></nav>${cards}`)); return
    }
    if (url.pathname === '/network/tailscale/login' && request.method === 'POST') { await options.networks.loginTailscale(); redirect(res, '/network'); return }
    if (url.pathname === '/invites/new' && request.method === 'GET') {
      const status = await options.networks.status()
      response(res, 200, page('添加节点', `<h1>添加节点</h1><p class="muted">邀请 15 分钟内有效，仅供一台机器使用。</p><form class="card" action="/invites" method="post"><label for="name">节点名称</label><input id="name" name="name" placeholder="例如：工作电脑" maxlength="80" required><label for="mode">连接方式</label><select id="mode" name="mode">${(['tailscale','tailcat'] as const).map(mode => `<option value="${mode}" ${status[mode].state === 'ready' ? '' : 'disabled'}>${mode === 'tailscale' ? 'Tailscale · 使用已登录的设备' : 'Tailcat · 无需账号'}${status[mode].state === 'ready' ? '' : '（请先配置）'}</option>`).join('')}</select><nav><button class="primary">生成安装命令</button><a href="/network">连接设置</a></nav></form>`)); return
    }
    if (url.pathname === '/invites' && request.method === 'POST') {
      const input = await body(request); const mode = scalar(input.mode) as Mode
      if (mode !== 'tailscale' && mode !== 'tailcat') throw new Error('请选择 Tailscale 或 Tailcat。')
      const name = scalar(input.name, 80).trim(); if (!name) throw new Error('请输入节点名称。')
      const endpoint = await options.networks.endpoint(mode)
      const { token: invitationToken } = store.invite(mode, endpoint, name)
      const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
      const command = `curl -fsSL ${shellQuote(`${downloads.origin}/install.sh`)} | sh -s -- --hub ${shellQuote(downloads.origin)} --invite ${shellQuote(invitationToken)}`
      response(res, 200, page('安装命令', `<h1>连接 ${escape(name)}</h1><div class="card"><p>在该 node 上，以运行 DSH 的用户执行：</p><pre>${escape(command)}</pre><p class="muted">命令会安装连接插件与所选网络工具，完成配对。已有 Tailscale 会被复用；首次使用时按终端提示登录。</p><p>安装后按终端提示重新加载当前 DSH，然后返回节点列表。</p><nav><a class="button primary" href="/">查看节点</a><a href="/invites/new">生成新邀请</a></nav></div>`)); return
    }
    const opening = /^\/open\/(n[a-f0-9]{16})$/.exec(url.pathname)
    if (opening && request.method === 'GET') {
      const id = opening[1] as string; const node = store.node(id)
      if (!node || node.revokedAt) { response(res, 404, failurePage('节点不存在或已撤销。')); return }
      if (!peers.has(id)) { response(res, 503, failurePage('节点当前离线，请先检查连接。')); return }
      redirect(res, `${nodeOrigin(id)}/_hub/ticket?ticket=${store.ticket(id)}`); return
    }
    const detail = /^\/nodes\/(n[a-f0-9]{16})(?:\/(revoke|rename))?$/.exec(url.pathname)
    if (detail) {
      const id = detail[1] as string; const node = store.node(id)
      if (!node) { response(res, 404, failurePage('节点不存在。')); return }
      if (request.method === 'POST' && detail[2] === 'revoke') { store.revoke(id); peers.get(id)?.socket.close(4003, 'Node revoked'); peers.get(id)?.tunnel.close(); peers.delete(id); supervisors.get(id)?.socket.close(4003, 'Node revoked'); supervisors.get(id)?.tunnel.close(); supervisors.delete(id); redirect(res, '/'); return }
      if (request.method === 'POST' && detail[2] === 'rename') { const input = await body(request); const name = scalar(input.name, 80).trim(); if (!name) throw new Error('请输入名称。'); store.rename(id, name); redirect(res, `/nodes/${id}`); return }
      response(res, 200, page(node.name, `<h1>${escape(node.name)}</h1><nav><a href="/control/${id}">实验节点管理</a><a href="/control/grants">节点授权</a><a href="/">返回节点</a>${peers.has(id) ? `<a class="button primary" href="/open/${id}" target="_blank" rel="noopener">打开 DSH ↗</a>` : ''}</nav><section class="card"><dl><dt>状态</dt><dd>${node.revokedAt ? '已撤销' : peers.has(id) ? '在线' : '离线：请检查节点 DSH 与连接工具是否在运行。'}</dd><dt>连接方式</dt><dd>${escape(node.mode)}</dd><dt>DSH 版本</dt><dd>${escape(node.dshVersion)}</dd><dt>上次连接</dt><dd>${node.lastSeen ? escape(new Date(node.lastSeen).toISOString()) : '尚未加载连接插件'}</dd></dl></section><form class="card" method="post" action="/nodes/${id}/rename"><label for="name">节点名称</label><input id="name" name="name" value="${escape(node.name)}" maxlength="80" required><nav><button>保存名称</button></nav></form><details class="card"><summary class="danger">撤销此节点</summary><p>立即断开远程访问。DSH 的会话和文件保留在 node 上。</p><form method="post" action="/nodes/${id}/revoke"><button class="danger">确认撤销连接</button></form></details>`)); return
    }
    response(res, 404, failurePage('页面不存在。'))
  }
  function fail(res: ServerResponse, error: unknown): void {
    if (res.destroyed) return
    if (res.headersSent) { res.destroy(); return }
    const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 400
    response(res, status, failurePage(error instanceof Error ? error.message : '请求失败，请重试。', `${root.origin}/`))
  }
  const publicServer = createServer((req, res) => { void browserRequest(req, res).catch(error => fail(res, error)) })
  const privateServer = createServer((request, res) => {
    void (async () => {
      if (request.url !== '/enroll' || request.method !== 'POST') { response(res, 404, { error: 'Unknown agent endpoint' }); return }
      if (!rate(request)) { response(res, 429, { error: 'Too many attempts' }); return }
      const input = await body(request)
      const credential = scalar(input.credential, 128)
      if (credential.length < 32) throw new Error('设备凭据无效。')
      const node = store.enroll({ inviteToken: scalar(input.inviteToken, 128), clientId: scalar(input.clientId, 128), credential,
        name: scalar(input.name ?? 'DSH node', 80), dshVersion: scalar(input.dshVersion ?? 'unknown', 64), runtimeId: scalar(input.runtimeId ?? 'default', 128) })
      response(res, 200, { nodeId: node.id, protocol: 1 })
    })().catch(error => response(res, 400, { error: error instanceof Error ? error.message : 'Enrollment failed' }))
  })
  privateServer.on('upgrade', (req, socket, head) => {
    if (closing) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const id = url.searchParams.get('nodeId') ?? ''
    const auth = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
    const node = store.authenticate(id, auth)
    if (!['/connect','/supervise'].includes(url.pathname) || !node || String(req.headers['x-dsh-runtime'] ?? '') !== node.runtimeId) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
    agentSockets.handleUpgrade(req, socket, head, ws => {
      const collection = url.pathname === '/supervise' ? supervisors : peers
      collection.get(id)?.tunnel.close()
      const enabled = req.headers['x-dsh-control'] === '2'
      const tunnel = new GatewayTunnel(ws, { ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }), control: enabled })
      const generation = randomUUID()
      const peer: Peer = { socket: ws, tunnel, alive: true, capabilities: String(req.headers['x-dsh-control-capabilities'] ?? '').split(',').filter(v => (url.pathname === '/supervise' ? ['lifecycle'] : ['management','delegation','admission']).includes(v)), generation, runtimeId: node.runtimeId, version: String(req.headers['x-dsh-version'] ?? node.dshVersion).slice(0,64) }
      if (enabled) peer.control = new ControlRPC(ws, (method, input, signal) => { if (collection === supervisors) throw new Error('Supervisors cannot delegate'); return router.dispatch(id, generation, method, input, signal) })
      collection.set(id, peer)
      if(collection===supervisors)verificationNodes.add(id)
      if (collection === peers) store.seen(id, String(req.headers['x-dsh-version'] ?? node.dshVersion).slice(0, 64))
      ws.on('pong', () => { peer.alive = true })
      ws.on('error', () => {})
      ws.once('close', () => { if (!closing && collection.get(id) === peer) { collection.delete(id); if (collection === peers) store.seen(id, store.node(id)?.dshVersion ?? node.dshVersion) } })
    })
  })
  publicServer.on('upgrade', (req, socket, head) => {
    if (closing) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return }
    const id = hostNode(req); const node = id ? store.node(id) : undefined
    if (!originAllowed(req) || !id || !node || node.revokedAt || !store.authorized(token(req), id) || !permittedOrigin(req, new URL(nodeOrigin(id)).origin)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return
    }
    const path = new URL(req.url ?? '/', nodeOrigin(id)).pathname
    const peer = peers.get(id)
    if (path !== '/api/remote.mux' || !peer) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return }
    webSockets.handleUpgrade(req, socket, head, ws => {
      browserSockets.add(ws)
      const abort = new AbortController()
      const mux = peer.tunnel.openMux(text => { if (ws.readyState === WebSocket.OPEN) ws.send(text) }, abort.signal)
      ws.on('message', (bytes, binary) => { if (binary) ws.close(1003, 'Native mux requires text'); else mux.send(bytes.toString()) })
      ws.on('error', () => {})
      const disconnected = () => ws.close(1012, 'Node disconnected')
      peer.socket.once('close', disconnected)
      ws.once('close', () => { abort.abort(); mux.close(); browserSockets.delete(ws); peer.socket.off('close', disconnected) })
      const expiry = setTimeout(() => ws.close(1008, 'Please reopen node from Hub'), 8 * 60 * 60_000); expiry.unref()
      ws.once('close', () => clearTimeout(expiry))
    })
  })
  let reconciling = false
  const verificationNodes=new Set<string>()
  let verifying=false
  const lifecycleVerification=setInterval(()=>{
    if(verifying||closing)return
    verifying=true
    void Promise.all([...verificationNodes].map(async id=>{
      const supervisor=supervisors.get(id),peer=peers.get(id)
      if(!supervisor?.control)return
      try{if(!await verifyLifecycle(peer,supervisor,()=>!closing&&peers.get(id)===peer&&supervisors.get(id)===supervisor))verificationNodes.delete(id)}catch{/* keep durable pending state; retry after reconnect */}
    })).finally(()=>{verifying=false})
  },1000);lifecycleVerification.unref()
  const controlExpiry = setInterval(() => { if (!reconciling) { reconciling = true; void router.reconcile().finally(() => { reconciling = false }) } }, 250); controlExpiry.unref()
  const heartbeat = setInterval(() => {
    for (const peer of [...peers.values(), ...supervisors.values()]) { if (!peer.alive) peer.socket.terminate(); else { peer.alive = false; peer.socket.ping() } }
    store.prune()
    for (const [key, entry] of attempts) if (entry.reset < Date.now()) attempts.delete(key)
  }, 20_000); heartbeat.unref()
  return { publicServer, privateServer, store, peers, supervisors,
    async close(): Promise<void> {
      if (closing) return
      closing = true
      clearInterval(heartbeat); clearInterval(controlExpiry); clearInterval(lifecycleVerification)
      // Give browsers and reverse proxies an explicit restart frame while the
      // carriers are still alive. An unresponsive browser cannot block shutdown.
      await Promise.all([...browserSockets].map(ws => new Promise<void>(ok => {
        if (ws.readyState === WebSocket.CLOSED) { ok(); return }
        const done = () => { clearTimeout(timer); ws.off('close', done); ok() }
        const timer = setTimeout(() => { ws.terminate(); done() }, 1000)
        ws.once('close', done)
        ws.close(1012, 'Hub restarting')
      })))
      for (const peer of [...peers.values(), ...supervisors.values()]) { peer.tunnel.close(); peer.socket.terminate() }
      peers.clear(); supervisors.clear()
      for (const ws of agentSockets.clients) ws.terminate()
      const close = (server: Server) => new Promise<void>(ok => { server.close(() => ok()); server.closeAllConnections() })
      await Promise.all([close(publicServer), close(privateServer)])
      agentSockets.close(); webSockets.close(); store.close()
    },
  }
}
