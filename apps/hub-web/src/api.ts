export interface HubNode {
  nodeId: string
  displayName: string
  status: string
  online: boolean
  lastSeenAt?: number
}

export interface HubRuntime {
  nodeId: string
  runtimeId: string
  dshVersion: string
  connectorVersion: string
  online: boolean
  capabilities: Array<{ name: string; version: string; operations: Array<{ name: string }> }>
}

export interface HubSession {
  hubSessionId: string
  nodeId: string
  runtimeId: string
  sourceId: string
  title?: string
  updatedAt: number
  running: boolean
  stale: boolean
}

export interface HubCommand {
  commandId: string
  nodeId?: string
  runtimeId?: string
  capability?: string
  operation?: string
  status: 'pending' | 'sent' | 'running' | 'ok' | 'error' | 'outcome-unknown'
  createdAt?: number
  updatedAt?: number
  result?: unknown
}

export interface HubAuditRecord {
  sequence: number
  occurredAt: number
  actor: string
  action: string
  nodeId?: string
  runtimeId?: string
  resourceId?: string
  outcome: string
  details: unknown
  recordHash: string
}

export interface HubEnrollmentGrant {
  nodeId: string
  displayName: string
  code: string
  expiresAt: number
}

export interface ConversationMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  time?: number
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${String(response.status)}`)
  return body
}

function jsonMutation(method: 'POST', body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export async function baseline(): Promise<{
  nodes: HubNode[]
  runtimes: HubRuntime[]
  sessions: HubSession[]
}> {
  const [fleet, sessionList] = await Promise.all([
    json<{ nodes: HubNode[]; runtimes: HubRuntime[] }>('/hub/v1/nodes'),
    json<{ sessions: HubSession[] }>('/hub/v1/sessions'),
  ])
  return { ...fleet, sessions: sessionList.sessions }
}

export async function invoke(input: {
  nodeId: string
  runtimeId: string
  capability: string
  operation: string
  payload: unknown
}): Promise<HubCommand> {
  const runtime = (await baseline()).runtimes.find(candidate =>
    candidate.nodeId === input.nodeId && candidate.runtimeId === input.runtimeId)
  const descriptor = runtime?.capabilities.find(capability => capability.name === input.capability)
  if (descriptor === undefined || !descriptor.operations.some(operation => operation.name === input.operation)) {
    throw new Error(`节点未提供 ${input.capability}.${input.operation}`)
  }
  const created = await json<{ command: HubCommand }>('/hub/v1/commands', {
    ...jsonMutation('POST', {
      ...input,
      capabilityVersion: descriptor.version,
    }),
  })
  return waitCommand(created.command.commandId)
}

/** Create a one-time node enrollment grant. */
export function createEnrollment(input: {
  nodeId: string
  displayName: string
  expiresInSeconds: number
}): Promise<HubEnrollmentGrant> {
  return json('/hub/v1/enrollments', jsonMutation('POST', input))
}

/** Revoke a node identity and fence its current connection. */
export async function revokeNode(nodeId: string): Promise<void> {
  await json(`/hub/v1/nodes/${encodeURIComponent(nodeId)}/revoke`, jsonMutation('POST', {}))
}

/** Load recent command metadata and immutable audit records. */
export async function activity(nodeId?: string): Promise<{
  commands: HubCommand[]
  records: HubAuditRecord[]
}> {
  const query = nodeId === undefined ? '' : `?nodeId=${encodeURIComponent(nodeId)}`
  const [commands, audit] = await Promise.all([
    json<{ commands: HubCommand[] }>(`/hub/v1/commands${query}`),
    json<{ records: HubAuditRecord[] }>(`/hub/v1/audit${query}`),
  ])
  return { commands: commands.commands, records: audit.records }
}

async function waitCommand(commandId: string, timeoutMs = 60_000): Promise<HubCommand> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { command } = await json<{ command: HubCommand }>(`/hub/v1/commands/${encodeURIComponent(commandId)}`)
    if (command.status === 'ok') {
      await json(`/hub/v1/commands/${encodeURIComponent(commandId)}`, jsonMutation('POST', {}))
      return command
    }
    if (command.status === 'error' || command.status === 'outcome-unknown') {
      const result = command.result as { message?: unknown } | undefined
      await json(`/hub/v1/commands/${encodeURIComponent(commandId)}`, jsonMutation('POST', {}))
      throw new Error(typeof result?.message === 'string' ? result.message : `命令状态：${command.status}`)
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('命令仍在节点执行，可稍后从操作记录查看')
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap((part) => {
    if (typeof part === 'string') return [part]
    if (typeof part !== 'object' || part === null) return []
    if ('text' in part && typeof (part as { text?: unknown }).text === 'string') {
      return [(part as { text: string }).text]
    }
    return []
  }).join('\n')
}

/** Convert the stable DSH ledger surface into a compact conversation view. */
export function conversation(events: unknown[]): ConversationMessage[] {
  const messages: ConversationMessage[] = []
  for (const [index, value] of events.entries()) {
    if (typeof value !== 'object' || value === null) continue
    const event = value as { type?: unknown; seq?: unknown; time?: unknown; data?: unknown }
    if (typeof event.type !== 'string' || typeof event.data !== 'object' || event.data === null) continue
    const data = event.data as Record<string, unknown>
    const content = textContent(data.content ?? (data.message as Record<string, unknown> | undefined)?.content)
    let role: ConversationMessage['role'] | undefined
    if (event.type.includes('user') || (data.source as { kind?: unknown } | undefined)?.kind === 'user') role = 'user'
    else if (event.type.includes('assistant')) role = 'assistant'
    else if (event.type === 'compaction/summary') role = 'system'
    if (role === undefined || content === '') continue
    messages.push({
      id: typeof event.seq === 'number' ? String(event.seq) : `${event.type}-${String(index)}`,
      role,
      text: content,
      ...(typeof event.time === 'number' ? { time: event.time } : {}),
    })
  }
  return messages
}
