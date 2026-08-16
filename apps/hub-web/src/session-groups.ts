import type { HubNode, HubSession } from './api.ts'

export interface SessionProjectGroup {
  key: string
  name: string
  path?: string
  nodeName: string
  sessions: HubSession[]
}

function html(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  if (trimmed === '') return path
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index < 0 ? trimmed : trimmed.slice(index + 1)
}

/** Group session-index metadata without treating Hub as an authority for project files. */
export function sessionProjectGroups(sessions: readonly HubSession[], nodes: readonly HubNode[]): SessionProjectGroup[] {
  const groups = new Map<string, SessionProjectGroup>()
  for (const session of sessions) {
    const path = session.workspacePath
    const key = JSON.stringify([session.nodeId, session.runtimeId, path ?? null])
    let group = groups.get(key)
    if (group === undefined) {
      group = {
        key,
        name: path === undefined ? '其他会话' : basename(path),
        ...(path === undefined ? {} : { path }),
        nodeName: nodes.find(node => node.nodeId === session.nodeId)?.displayName ?? session.nodeId,
        sessions: [],
      }
      groups.set(key, group)
    }
    group.sessions.push(session)
  }
  return [...groups.values()].sort((left, right) => {
    const updated = (right.sessions[0]?.updatedAt ?? 0) - (left.sessions[0]?.updatedAt ?? 0)
    return updated === 0 ? left.name.localeCompare(right.name) : updated
  })
}

/** Render project groups as inert first-party markup; node strings never become executable HTML. */
export function projectSessionList(
  groups: readonly SessionProjectGroup[],
  selectedSession: string | undefined,
  showNodeNames: boolean,
): string {
  if (groups.length === 0) return '<p class="empty-list">该范围内暂无会话</p>'
  return groups.map(project => `<section class="project-group">
    <div class="project-heading" title="${html(project.path ?? project.name)}"><span>${html(project.name)}</span><small>${showNodeNames ? `${html(project.nodeName)} · ` : ''}${project.sessions.length}</small></div>
    ${project.sessions.map(session => `<button class="session-row ${selectedSession === session.hubSessionId ? 'active' : ''}" data-session="${html(session.hubSessionId)}">
      <span>${html(session.title || '未命名会话')}</span>
      <small>${new Date(session.updatedAt).toLocaleDateString()}</small>
    </button>`).join('')}
  </section>`).join('')
}

/** Bind session selection after each state-driven render, including compact mobile layouts. */
export function bindProjectSessionList(root: ParentNode, select: (hubSessionId: string) => void): void {
  root.querySelectorAll<HTMLElement>('[data-session]').forEach((element) => {
    element.addEventListener('click', () => {
      const id = element.dataset.session
      if (id !== undefined && id !== '') select(id)
    })
  })
}
