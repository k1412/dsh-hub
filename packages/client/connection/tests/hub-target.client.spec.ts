// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { withHubTarget } from '../src/client/hub-target.ts'

afterEach(() => { history.replaceState({}, '', '/') })

describe('Hub tab target routing', () => {
  it('adds both target ids while preserving endpoint query parameters', () => {
    history.replaceState({}, '', '/?nodeId=nas-home&runtimeId=web.main')
    const result = withHubTarget(new URL('https://hub.example/api/session.export?sessionId=session-1'))

    expect(result.toString()).toBe(
      'https://hub.example/api/session.export?sessionId=session-1&nodeId=nas-home&runtimeId=web.main',
    )
  })

  it('leaves ordinary local Web URLs unchanged', () => {
    const input = new URL('http://127.0.0.1:3080/api/host.describe')
    expect(withHubTarget(input).toString()).toBe('http://127.0.0.1:3080/api/host.describe')
  })

  it('refuses partial or malformed targets', () => {
    history.replaceState({}, '', '/?nodeId=nas-home')
    expect(withHubTarget(new URL('https://hub.example/api/x')).search).toBe('')
    history.replaceState({}, '', '/?nodeId=nas%2Fhome&runtimeId=web')
    expect(withHubTarget(new URL('https://hub.example/api/x')).search).toBe('')
  })
})
