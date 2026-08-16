// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HubNode, HubSession } from '../src/api.ts'
import { bindProjectSessionList, projectSessionList, sessionProjectGroups } from '../src/session-groups.ts'

const nodes: HubNode[] = [
  { nodeId: 'mac', displayName: 'Mac', status: 'active', online: true },
  { nodeId: 'work', displayName: 'Work', status: 'active', online: true },
]

function session(input: Partial<HubSession> & Pick<HubSession, 'hubSessionId' | 'nodeId' | 'runtimeId' | 'sourceId' | 'updatedAt'>): HubSession {
  return { running: false, stale: false, ...input }
}

describe('Hub session project grouping', () => {
  it('groups sessions by node, runtime, and working directory', () => {
    const groups = sessionProjectGroups([
      session({ hubSessionId: 'h1', nodeId: 'mac', runtimeId: 'web', sourceId: 's1', workspacePath: '/Users/me/Code/hub', updatedAt: 30 }),
      session({ hubSessionId: 'h2', nodeId: 'mac', runtimeId: 'web', sourceId: 's2', workspacePath: '/Users/me/Code/hub', updatedAt: 20 }),
      session({ hubSessionId: 'h3', nodeId: 'work', runtimeId: 'web', sourceId: 's3', workspacePath: '/Users/me/Code/hub', updatedAt: 10 }),
    ], nodes)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({
      name: 'hub', path: '/Users/me/Code/hub', nodeName: 'Mac',
      sessions: [{ hubSessionId: 'h1' }, { hubSessionId: 'h2' }],
    })
    expect(groups[1]).toMatchObject({ name: 'hub', nodeName: 'Work', sessions: [{ hubSessionId: 'h3' }] })
    expect(groups[0]?.key).not.toBe(groups[1]?.key)
  })

  it('labels Windows projects and keeps pathless sessions in a separate fallback group', () => {
    const groups = sessionProjectGroups([
      session({ hubSessionId: 'windows', nodeId: 'work', runtimeId: 'desktop', sourceId: 's1', workspacePath: 'C:\\Code\\deepseek', updatedAt: 20 }),
      session({ hubSessionId: 'other', nodeId: 'work', runtimeId: 'desktop', sourceId: 's2', updatedAt: 10 }),
    ], nodes)
    expect(groups.map(group => ({ name: group.name, path: group.path }))).toEqual([
      { name: 'deepseek', path: 'C:\\Code\\deepseek' },
      { name: '其他会话', path: undefined },
    ])
  })

  it('uses stable deterministic ordering when projects have equal activity', () => {
    const groups = sessionProjectGroups([
      session({ hubSessionId: 'b', nodeId: 'mac', runtimeId: 'web', sourceId: 'b', workspacePath: '/b', updatedAt: 10 }),
      session({ hubSessionId: 'a', nodeId: 'mac', runtimeId: 'web', sourceId: 'a', workspacePath: '/a', updatedAt: 10 }),
    ], nodes)
    expect(groups.map(group => group.name)).toEqual(['a', 'b'])
  })

  it('renders safe grouped markup and keeps session selection clickable', () => {
    const groups = sessionProjectGroups([
      session({
        hubSessionId: 'hub-selected', nodeId: 'mac', runtimeId: 'web', sourceId: 'source',
        title: '<script>bad()</script>', workspacePath: '/Code/<project>', updatedAt: 10,
      }),
    ], nodes)
    document.body.innerHTML = `<nav>${projectSessionList(groups, 'hub-selected', true)}</nav>`
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('.project-heading')?.getAttribute('title')).toBe('/Code/<project>')
    expect(document.querySelector('.project-heading small')?.textContent).toBe('Mac · 1')
    expect(document.querySelector('.session-row')?.classList.contains('active')).toBe(true)
    let selected = ''
    bindProjectSessionList(document, (id) => { selected = id })
    document.querySelector<HTMLButtonElement>('.session-row')?.click()
    expect(selected).toBe('hub-selected')
  })
})
