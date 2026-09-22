import { describe, expect, it } from 'vitest'
import { readHubTarget, withHubTarget } from '../src/target-bridge.ts'

describe('Hub target transport bridge', () => {
  it('accepts only bounded node and Runtime identifiers', () => {
    expect(readHubTarget('?nodeId=nas-home&runtimeId=web')).toEqual({ nodeId: 'nas-home', runtimeId: 'web' })
    expect(readHubTarget('?nodeId=bad%2Fnode&runtimeId=web')).toBeUndefined()
    expect(readHubTarget('?nodeId=nas-home')).toBeUndefined()
  })

  it('adds the selected target to HTTP and WebSocket API URLs', () => {
    const search = '?nodeId=nas-home&runtimeId=web'
    expect(withHubTarget('https://hub.example/api/session.list', search).href)
      .toBe('https://hub.example/api/session.list?nodeId=nas-home&runtimeId=web')
    expect(withHubTarget('wss://hub.example/api/remote.mux', search).href)
      .toBe('wss://hub.example/api/remote.mux?nodeId=nas-home&runtimeId=web')
  })

  it('leaves Hub control paths and unselected pages unchanged', () => {
    const search = '?nodeId=nas-home&runtimeId=web'
    expect(withHubTarget('https://hub.example/hub/v1/nodes', search).href)
      .toBe('https://hub.example/hub/v1/nodes')
    expect(withHubTarget('https://hub.example/api/session.list', '').href)
      .toBe('https://hub.example/api/session.list')
  })
})
