// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  readRuntimeTarget, replaceRuntimeTarget, runtimeTargetOfWorkspace, supportsOfficialWeb,
} from '../src/client/runtime-target.ts'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  history.replaceState({}, '', '/')
})

describe('Hub Runtime target browser state', () => {
  it('keeps the page canonical while remembering a tab-local target', () => {
    replaceRuntimeTarget({ nodeId: 'workstation-a', runtimeId: 'web' })
    expect(readRuntimeTarget()).toEqual({ nodeId: 'workstation-a', runtimeId: 'web' })
    expect(location.search).toBe('')
    localStorage.setItem('dsh.hub.runtime-target', JSON.stringify({ nodeId: 'another-tab', runtimeId: 'default' }))
    history.replaceState({}, '', '/')
    expect(readRuntimeTarget()).toEqual({ nodeId: 'workstation-a', runtimeId: 'web' })
  })

  it('decodes only canonical, validated Hub Workspace ids', () => {
    const payload = btoa(JSON.stringify(['nas-node', 'default', 'workspace-1']))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
    expect(runtimeTargetOfWorkspace(`hub-workspace-${payload}`)).toEqual({
      nodeId: 'nas-node', runtimeId: 'default',
    })
    expect(runtimeTargetOfWorkspace('ordinary-workspace')).toBeUndefined()
    expect(runtimeTargetOfWorkspace('hub-workspace-Zm9v')).toBeUndefined()
  })

  it('requires the exact official Web fetch capability', () => {
    expect(supportsOfficialWeb({
      nodeId: 'nas-node', runtimeId: 'default',
      capabilities: [{ name: 'dsh.web', operations: [{ name: 'fetch' }] }],
    })).toBe(true)
    expect(supportsOfficialWeb({
      nodeId: 'nas-node', runtimeId: 'default',
      capabilities: [{ name: 'dsh.web', operations: [{ name: 'events' }] }],
    })).toBe(false)
  })
})
