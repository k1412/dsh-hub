import { describe, expect, it } from 'vitest'
import {
  decodeFleetId, decodeFleetPayload, encodeFleetId, encodeFleetPayload, singleFleetTarget,
} from '../src/fleet-web.ts'

const mac = { nodeId: 'mac-neo', runtimeId: 'web', displayName: 'Mac Neo' }
const nas = { nodeId: 'nas-work', runtimeId: 'default', displayName: 'Home NAS' }

describe('fleet Web identity routing', () => {
  it('round-trips collision-free session and workspace identities', () => {
    const session = encodeFleetId('session', mac, 'same-local-id')
    const workspace = encodeFleetId('workspace', nas, 'same-local-id')
    expect(session).not.toBe(workspace)
    expect(decodeFleetId(session)).toEqual({
      kind: 'session', nodeId: 'mac-neo', runtimeId: 'web', sourceId: 'same-local-id',
    })
    expect(decodeFleetId(workspace)).toEqual({
      kind: 'workspace', nodeId: 'nas-work', runtimeId: 'default', sourceId: 'same-local-id',
    })
  })

  it('namespaces official summaries, workspace accounts, lineage, and event addresses', () => {
    const value = encodeFleetPayload({
      workspaceId: 'workspace-one',
      path: '/srv/project',
      title: 'Project',
      sessionIds: ['session-one'],
      nested: {
        sessionId: 'session-one',
        parentSessionId: 'session-parent',
        agentId: 'session-one',
      },
    }, nas) as Record<string, unknown>
    expect(value.title).toBe('Home NAS · Project')
    expect(decodeFleetPayload(value)).toMatchObject({
      value: {
        workspaceId: 'workspace-one',
        sessionIds: ['session-one'],
        nested: {
          sessionId: 'session-one',
          parentSessionId: 'session-parent',
          agentId: 'session-one',
        },
      },
      targets: [{ nodeId: 'nas-work', runtimeId: 'default' }],
    })
  })

  it('rejects one browser mutation that mixes identities from two Runtimes', () => {
    const decoded = decodeFleetPayload({
      sessionId: encodeFleetId('session', mac, 'one'),
      beforeSessionId: encodeFleetId('session', nas, 'two'),
    })
    expect(() => singleFleetTarget(decoded.targets)).toThrow('multiple DSH Runtimes')
  })

  it('never interprets a fleet-looking id in user-authored content as routing metadata', () => {
    const encoded = encodeFleetId('session', mac, 'one')
    expect(decodeFleetPayload({
      sessionId: encoded,
      payload: { text: encoded, title: encoded },
    })).toEqual({
      value: {
        sessionId: 'one',
        payload: { text: encoded, title: encoded },
      },
      targets: [{ nodeId: 'mac-neo', runtimeId: 'web' }],
    })
    expect(decodeFleetPayload(encoded, 'sessionId').value).toBe('one')
  })

  it('rejects non-canonical or structurally invalid fleet identities', () => {
    expect(() => decodeFleetId('hub-session-Zm9v')).toThrow('malformed')
    expect(decodeFleetId('ordinary-session')).toBeUndefined()
    expect(() => decodeFleetPayload({
      sessionId: encodeFleetId('workspace', nas, 'workspace-one'),
    })).toThrow('kind does not match')
  })
})
