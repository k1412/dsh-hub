/** Empty-fleet enrollment gate; the full product remains the official DSH Web shell. */

import './setup.css'

interface NodeSummary {
  nodeId: string
  displayName: string
  status: string
  online: boolean
}

interface RuntimeSummary {
  nodeId: string
  runtimeId: string
  online: boolean
  capabilities: Array<{ name: string }>
}

function required(selector: string): Element {
  const element = document.querySelector(selector)
  if (element === null) throw new Error(`Hub setup document is missing ${selector}`)
  return element
}

const form = required('#enroll-form') as HTMLFormElement
const displayName = required('#display-name') as HTMLInputElement
const nodeId = required('#node-id') as HTMLInputElement
const status = required('#status') as HTMLElement
const nodes = required('#nodes') as HTMLUListElement
const grant = required('#grant') as HTMLElement

let edited = false
nodeId.addEventListener('input', () => { edited = true })
displayName.addEventListener('input', () => {
  if (edited) return
  nodeId.value = displayName.value.trim().toLocaleLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
})

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const value = await response.json() as T & { error?: unknown }
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : `HTTP ${String(response.status)}`)
  return value
}

async function refresh(): Promise<void> {
  try {
    const fleet = await json<{ nodes: NodeSummary[]; runtimes: RuntimeSummary[] }>('/hub/v1/nodes')
    const ready = fleet.runtimes.find(runtime => runtime.online
      && runtime.capabilities.some(capability => capability.name === 'dsh.web'))
    if (ready !== undefined) {
      const target = new URL('/', globalThis.location.origin)
      target.searchParams.set('nodeId', ready.nodeId)
      target.searchParams.set('runtimeId', ready.runtimeId)
      globalThis.location.replace(target)
      return
    }
    status.textContent = fleet.nodes.length === 0 ? '尚无已登记节点。' : '节点已登记，正在等待 DSH Runtime 上线。'
    nodes.replaceChildren(...fleet.nodes.map((node) => {
      const item = document.createElement('li')
      const text = document.createElement('span')
      text.textContent = `${node.displayName} · ${node.nodeId}`
      const badge = document.createElement('strong')
      badge.textContent = node.status === 'revoked' ? '已撤销' : node.online ? '在线，等待 Runtime' : '离线'
      item.append(text, badge)
      return item
    }))
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error)
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const button = form.querySelector<HTMLButtonElement>('button')
  if (button !== null) button.disabled = true
  status.textContent = '正在生成注册码…'
  void json<{ code: string; expiresAt: number }>('/hub/v1/enrollments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: nodeId.value, displayName: displayName.value, expiresInSeconds: 900 }),
  }).then((created) => {
    grant.hidden = false
    grant.replaceChildren()
    const title = document.createElement('strong')
    title.textContent = '一次性注册码'
    const code = document.createElement('code')
    code.textContent = created.code
    const note = document.createElement('p')
    note.textContent = `请在 ${new Date(created.expiresAt).toLocaleTimeString()} 前复制到目标节点；此页面刷新后不能再次查看。`
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.textContent = '复制注册码'
    copy.addEventListener('click', () => { void navigator.clipboard.writeText(created.code) })
    grant.append(title, note, code, copy)
    form.reset()
    edited = false
    return refresh()
  }).catch((error: unknown) => { status.textContent = error instanceof Error ? error.message : String(error) })
    .finally(() => { if (button !== null) button.disabled = false })
})

void refresh()
globalThis.setInterval(() => { void refresh() }, 3_000)
