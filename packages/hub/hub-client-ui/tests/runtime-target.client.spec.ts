// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  readRuntimeTarget, replaceRuntimeTarget, runtimeTargetOfWorkspace, supportsOfficialWeb,
} from '../src/client/runtime-target.ts'

beforeEach(() => {
  localStorage.clear()
  history.replaceState({}, '', '/')
})

describe('Hub Runtime target browser state', () => {
  it('round-trips a last-used target through URL and local storage', () => {
    replaceRuntimeTarget({ nodeId: 'mac-neo', runtimeId: 'web' })
    expect(readRuntimeTarget()).toEqual({ nodeId: 'mac-neo', runtimeId: 'web' })
    history.replaceState({}, '', '/')
    expect(readRuntimeTarget()).toEqual({ nodeId: 'mac-neo', runtimeId: 'web' })
  })

  it('decodes only canonical, validated Hub Workspace ids', () => {
    const payload = btoa(JSON.stringify(['nas-work', 'default', 'workspace-1']))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
    expect(runtimeTargetOfWorkspace(`hub-workspace-${payload}`)).toEqual({
      nodeId: 'nas-work', runtimeId: 'default',
    })
    expect(runtimeTargetOfWorkspace('ordinary-workspace')).toBeUndefined()
    expect(runtimeTargetOfWorkspace('hub-workspace-Zm9v')).toBeUndefined()
  })

  it('requires the exact official Web fetch capability', () => {
    expect(supportsOfficialWeb({
      nodeId: 'nas-work', runtimeId: 'default',
      capabilities: [{ name: 'dsh.web', operations: [{ name: 'fetch' }] }],
    })).toBe(true)
    expect(supportsOfficialWeb({
      nodeId: 'nas-work', runtimeId: 'default',
      capabilities: [{ name: 'dsh.web', operations: [{ name: 'events' }] }],
    })).toBe(false)
  })
})
