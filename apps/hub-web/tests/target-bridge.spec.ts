import { describe, expect, it } from 'vitest'
import { readHubTarget, withHubTarget } from '../src/target-bridge.ts'

describe('Hub target transport bridge', () => {
  it('accepts only bounded node and Runtime identifiers', () => {
    expect(readHubTarget('?nodeId=nas-home&runtimeId=web')).toEqual({ nodeId: 'nas-home', runtimeId: 'web' })
    expect(readHubTarget('?nodeId=bad%2Fnode&runtimeId=web')).toBeUndefined()
    expect(readHubTarget('?nodeId=nas-home')).toBeUndefined()
  })

  it('routes ownerless operations while keeping discovery and live events fleet-wide', () => {
    const search = '?nodeId=nas-home&runtimeId=web'
    expect(withHubTarget('https://hub.example/api/host.listDirectory', search).href)
      .toBe('https://hub.example/api/host.listDirectory?nodeId=nas-home&runtimeId=web')
    expect(withHubTarget('wss://hub.example/api/remote.mux', search).href)
      .toBe('wss://hub.example/api/remote.mux')
  })

  it.each(['session.list', 'session/list', 'session.search', 'workspace.list', 'workspace/list', 'events.mux', 'events.host'])('strips legacy scoping from global %s requests', method => {
    const input = `https://hub.example/api/${method}?nodeId=old-node&runtimeId=web`
    expect(withHubTarget(input, '?nodeId=another-node&runtimeId=web').search).toBe('')
  })

  it('routes selected tab state without requiring a page query', () => {
    expect(withHubTarget('https://hub.example/api/session.create', '', 'https://hub.example', { nodeId: 'chosen', runtimeId: 'default' }).search)
      .toBe('?nodeId=chosen&runtimeId=default')
  })

  it('leaves Hub control paths and unselected pages unchanged', () => {
    const search = '?nodeId=nas-home&runtimeId=web'
    expect(withHubTarget('https://hub.example/hub/v1/nodes', search).href)
      .toBe('https://hub.example/hub/v1/nodes')
    expect(withHubTarget('https://hub.example/api/session.list', '').href)
      .toBe('https://hub.example/api/session.list')
  })
})
