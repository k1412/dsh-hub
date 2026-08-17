// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetSnapshot, HubRuntime } from '../src/client/api.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'

const api = vi.hoisted(() => ({
  readFleet: vi.fn(),
  createEnrollment: vi.fn(),
  cancelEnrollment: vi.fn(),
  revokeNode: vi.fn(),
  switchRuntime: vi.fn(),
  invoke: vi.fn(),
}))

vi.mock('../src/client/api.ts', async original => ({
  ...await original(),
  ...api,
}))

import { HubNodesSection } from '../src/client/HubNodesSection.tsx'
import { HubPluginsSection } from '../src/client/HubPluginsSection.tsx'
import { HubRuntimePicker } from '../src/client/HubRuntimePicker.tsx'
import { nodeInstallCommand } from '../src/client/install-command.ts'
import { terminalSocketUrl } from '../src/client/AdvancedDiagnostics.tsx'
import { zh } from '../src/client/locales.ts'

const runtime: HubRuntime = {
  nodeId: 'nas-home',
  runtimeId: 'web',
  dshVersion: '0.1.0-rc.5',
  connectorVersion: '0.1.0-rc.5',
  online: true,
  lastSeenAt: 1_000,
  capabilities: [
    { name: 'dsh.web', version: '1.0.0', operations: [{ name: 'fetch' }] },
    { name: 'dsh.plugins', version: '2.0.0', operations: [
      { name: 'inventory' }, { name: 'check-updates' }, { name: 'history' },
      { name: 'apply' }, { name: 'rollback' },
    ] },
    { name: 'dsh.snapshots', version: '2.0.0', operations: [
      { name: 'list' }, { name: 'create' }, { name: 'restore' },
    ] },
    { name: 'dsh.files', version: '1.0.0', operations: [
      { name: 'list' }, { name: 'read' }, { name: 'write' }, { name: 'remove' },
    ] },
    { name: 'dsh.terminals', version: '1.0.0', operations: [
      { name: 'open' }, { name: 'write' }, { name: 'resize' }, { name: 'close' },
    ] },
  ],
}

const fleet: FleetSnapshot = {
  nodes: [{
    nodeId: 'nas-home', displayName: 'Home NAS', status: 'active', online: true,
    createdAt: 500, lastSeenAt: 1_000,
    transport: {
      reportedAt: 1_000,
      pressure: 'warning',
      nodeOutbox: { records: 8_100, bytes: 5_000_000, maxRecords: 10_000, maxBytes: 64 * 1024 * 1024 },
      hubOutbox: { records: 2, bytes: 512, maxRecords: 10_000, maxBytes: 64 * 1024 * 1024 },
      droppedStreamFramesTotal: 12,
      droppedStreams: [{ runtimeId: 'web', capability: 'dsh.sessions', stream: 'events', frames: 12 }],
    },
  }],
  runtimes: [runtime],
  enrollments: [{ nodeId: 'mac-home', displayName: 'Home Mac', createdAt: 600, expiresAt: 60_000 }],
}

const unusedHook = (() => { throw new Error('not used by Hub Settings') }) as never
const hubT = makeTranslate(zh)
const clipboardWrite = vi.fn<(text: string) => Promise<void>>()

beforeEach(() => {
  localStorage.clear()
  history.replaceState({}, '', '/?nodeId=nas-home&runtimeId=web')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite.mockResolvedValue(undefined) },
  })
  api.readFleet.mockResolvedValue(fleet)
  api.createEnrollment.mockResolvedValue({
    nodeId: 'work-pc', displayName: 'Work PC', createdAt: 1_000, expiresAt: 60_000, code: 'one-time-code',
  })
  api.cancelEnrollment.mockResolvedValue(undefined)
  api.revokeNode.mockResolvedValue(undefined)
  api.invoke.mockImplementation(async (_runtime, capability, operation) => {
    if (capability === 'dsh.files' && operation === 'list') return {
      entries: [{ path: '/var/log/dsh.log', kind: 'file', size: 8, modifiedAt: 1_000 }],
    }
    if (capability === 'dsh.files' && operation === 'read') return {
      encoding: 'utf8', data: 'old text', eof: true, contentHash: 'b'.repeat(43),
    }
    if (capability === 'dsh.files' && operation === 'write') return {
      contentHash: 'c'.repeat(43), size: 8,
    }
    if (operation === 'inventory') return {
      plugins: [{ packageName: '@deepseek-ai/dsh-tool-web', version: '1.0.0', enabled: true, healthy: true }],
      lockHash: 'a'.repeat(43), checkedAt: 1_000,
    }
    if (operation === 'history') return { changes: [{
      changeId: 'change-1', packageName: '@deepseek-ai/dsh-tool-web', fromVersion: '0.9.0',
      toVersion: '1.0.0', createdAt: 900, status: 'applied',
    }] }
    if (operation === 'list') return { snapshots: [] }
    if (operation === 'check-updates') return {
      plugins: [{
        packageName: '@deepseek-ai/dsh-tool-web', version: '1.0.0', latestVersion: '1.1.0',
        updateAvailable: true, enabled: true, healthy: true,
      }],
      lockHash: 'a'.repeat(43), checkedAt: 1_100,
    }
    if (operation === 'apply') return {}
    throw new Error(`unexpected operation ${String(operation)}`)
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('Hub management Settings pages', () => {
  it('selects the node directly on the new-session screen and retains it in the URL', async () => {
    const secondRuntime: HubRuntime = { ...runtime, nodeId: 'mac-neo', runtimeId: 'desktop' }
    api.readFleet.mockResolvedValue({
      ...fleet,
      nodes: [...fleet.nodes, {
        nodeId: 'mac-neo', displayName: 'Mac Neo', status: 'active', online: true,
        createdAt: 600, lastSeenAt: 1_100,
      }],
      runtimes: [runtime, secondRuntime],
    })
    const onTargetChange = vi.fn()
    render(<HubRuntimePicker
      selectedWorkspaceId={undefined}
      onTargetChange={onTargetChange}
      t={hubT}
      useSessions={unusedHook}
      useWorkspaces={unusedHook}
    />)

    const picker = await screen.findByRole('button', { name: '节点与 Runtime' })
    expect(picker.textContent).toContain('Home NAS · web')
    fireEvent.click(picker)
    expect(picker.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mac Neo · desktop' }))
    expect(onTargetChange).toHaveBeenCalledOnce()
    expect(new URL(location.href).searchParams.get('nodeId')).toBe('mac-neo')
    expect(new URL(location.href).searchParams.get('runtimeId')).toBe('desktop')
    expect(localStorage.getItem('dsh.hub.runtime-target')).toContain('mac-neo')
  })

  it('synchronizes the node selector to the owner of an aggregated Workspace', async () => {
    const secondRuntime: HubRuntime = { ...runtime, nodeId: 'mac-neo', runtimeId: 'desktop' }
    api.readFleet.mockResolvedValue({ ...fleet, runtimes: [runtime, secondRuntime] })
    const encoded = btoa(JSON.stringify(['mac-neo', 'desktop', 'workspace-local']))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
    const onTargetChange = vi.fn()
    render(<HubRuntimePicker
      selectedWorkspaceId={`hub-workspace-${encoded}` as never}
      onTargetChange={onTargetChange}
      t={hubT}
      useSessions={unusedHook}
      useWorkspaces={unusedHook}
    />)

    const picker = await screen.findByRole('button', { name: '节点与 Runtime' })
    await waitFor(() => { expect(picker.textContent).toContain('mac-neo · desktop') })
    expect(onTargetChange).not.toHaveBeenCalled()
    expect(new URL(location.href).searchParams.get('nodeId')).toBe('mac-neo')
  })

  it('shows registration lifecycle, runtime switching, and diagnostic purpose without primary tool navigation', async () => {
    render(<HubNodesSection
      close={() => undefined}
      useSessions={unusedHook}
      useWorkspaces={unusedHook}
    />)
    expect(await screen.findByText('Home NAS')).toBeTruthy()
    expect(screen.getByText('Home Mac')).toBeTruthy()
    expect(screen.getByText('队列有压力')).toBeTruthy()
    expect(screen.getByText(/8100 \/ 10000 条/)).toBeTruthy()
    expect(screen.getByText('12 帧')).toBeTruthy()
    expect(screen.getByRole('button', { name: '默认' })).toHaveProperty('disabled', true)
    expect(screen.queryByRole('navigation', { name: /终端|文件/ })).toBeNull()

    fireEvent.click(screen.getByText('高级诊断：终端与文件'))
    expect(screen.getByText(/仅在节点服务损坏/)).toBeTruthy()
    expect(screen.getByText(/不是聊天、项目管理或日常文件浏览功能/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Work PC' } })
    expect(screen.getByLabelText('节点 ID')).toHaveProperty('value', 'work-pc')
    fireEvent.click(screen.getByRole('button', { name: '生成注册码' }))
    expect(await screen.findByText(/install-node\.sh/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '复制一键安装命令' }))
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledWith(expect.stringContaining('one-time-code'))
    })
    expect(clipboardWrite).not.toHaveBeenCalledWith(expect.stringContaining('ACCESS_CLIENT_SECRET'))
    expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Windows' }))
    expect(screen.getByText(/install-node\.ps1/)).toBeTruthy()
    fireEvent.click(screen.getByText('为什么仍会询问 Cloudflare 凭据？'))
    expect(screen.getByText(/DSH Bundle 插件/)).toBeTruthy()
  })

  it('quotes one-command enrollment values without placing the long-lived Access secret in history', () => {
    const grant = { nodeId: "mac-'neo", code: "short-'code" }
    const unix = nodeInstallCommand(grant, 'https://agent.k1412.top', 'unix')
    const windows = nodeInstallCommand(grant, 'https://agent.k1412.top', 'windows')

    expect(unix).toContain("--node 'mac-'\"'\"'neo'")
    expect(windows).toContain("$env:DSH_HUB_NODE_ID='mac-''neo'")
    expect(unix).toContain('/releases/download/hub-v0.1.0-rc.10/install-node.sh')
    expect(windows).toContain('/releases/download/hub-v0.1.0-rc.10/install-node.ps1')
    expect(unix).not.toContain('DSH_HUB_ACCESS_CLIENT_SECRET')
    expect(windows).not.toContain('DSH_HUB_ACCESS_CLIENT_SECRET')
  })

  it('cancels pending registration, opens another runtime, and revokes an enrolled node only after confirmation', async () => {
    const secondRuntime: HubRuntime = {
      ...runtime,
      runtimeId: 'desktop',
    }
    api.readFleet.mockResolvedValue({ ...fleet, runtimes: [runtime, secondRuntime] })
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true)

    render(<HubNodesSection
      close={() => undefined}
      useSessions={unusedHook}
      useWorkspaces={unusedHook}
    />)

    expect(await screen.findByText('Home Mac')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消注册' }))
    await waitFor(() => { expect(api.cancelEnrollment).toHaveBeenCalledWith('mac-home') })

    fireEvent.click(screen.getByRole('button', { name: '设为默认' }))
    expect(api.switchRuntime).toHaveBeenCalledWith(secondRuntime)

    fireEvent.click(screen.getByRole('button', { name: '撤销节点身份' }))
    await waitFor(() => { expect(api.revokeNode).toHaveBeenCalledWith('nas-home') })
    expect(globalThis.confirm).toHaveBeenCalledWith(expect.stringContaining('原身份不能再次使用'))
  })

  it('keeps file rescue path-explicit and protects edits with the version read from the node', async () => {
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true)
    render(<HubNodesSection
      close={() => undefined}
      useSessions={unusedHook}
      useWorkspaces={unusedHook}
    />)
    expect(await screen.findByText('Home NAS')).toBeTruthy()
    fireEvent.click(screen.getByText('高级诊断：终端与文件'))
    fireEvent.change(screen.getByLabelText('节点绝对路径'), { target: { value: '/var/log' } })
    fireEvent.click(screen.getByRole('button', { name: '列出目录' }))
    fireEvent.click(await screen.findByRole('button', { name: /dsh\.log/ }))
    const editor = await screen.findByLabelText('文件内容')
    expect((editor as HTMLTextAreaElement).value).toBe('old text')
    fireEvent.change(editor, { target: { value: 'new text' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith(runtime, 'dsh.files', 'write', {
        path: '/var/log/dsh.log', expectedHash: 'b'.repeat(43), encoding: 'utf8', data: 'new text',
      })
    })
    expect(document.body.textContent).not.toContain('b'.repeat(43))
  })

  it('builds terminal access on the current authenticated origin', () => {
    expect(terminalSocketUrl(runtime, '/srv/dsh')).toBe(
      'ws://localhost:3000/hub/v1/terminal?nodeId=nas-home&runtimeId=web&columns=100&rows=30&cwd=%2Fsrv%2Fdsh',
    )
  })

  it('turns plugin state and rollback points into direct actions without exposing hashes', async () => {
    render(<HubPluginsSection
      close={() => undefined}
      useSessions={unusedHook}
      useWorkspaces={unusedHook}
    />)
    expect(await screen.findAllByText('@deepseek-ai/dsh-tool-web')).toHaveLength(2)
    expect(screen.getByText('运行正常')).toBeTruthy()
    expect(screen.getByRole('button', { name: '回退到更新前' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/lockHash|artifactHash|快照 ID/)

    fireEvent.click(screen.getByRole('button', { name: '检查更新' }))
    expect(await screen.findByRole('button', { name: '更新到 1.1.0' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '更新到 1.1.0' }))
    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith(runtime, 'dsh.plugins', 'apply', expect.objectContaining({
        packageName: '@deepseek-ai/dsh-tool-web',
        version: '1.1.0',
        expectedLockHash: 'a'.repeat(43),
      }))
    })
    expect(JSON.stringify(api.invoke.mock.calls)).not.toContain('artifactHash')
  })

  it('rolls a plugin back independently from explicit snapshot create and restore', async () => {
    api.invoke.mockImplementation(async (_runtime, capability, operation) => {
      if (operation === 'inventory') return {
        plugins: [{ packageName: '@deepseek-ai/dsh-tool-web', version: '1.0.0', enabled: true, healthy: true }],
        lockHash: 'a'.repeat(43), checkedAt: 1_000,
      }
      if (operation === 'history') return { changes: [{
        changeId: 'change-1', packageName: '@deepseek-ai/dsh-tool-web', fromVersion: '0.9.0',
        toVersion: '1.0.0', createdAt: 900, status: 'applied',
      }] }
      if (capability === 'dsh.snapshots' && operation === 'list') return { snapshots: [{
        snapshotId: 'snapshot-1', type: 'configuration', createdAt: 800,
        label: '升级前', reason: 'manual',
      }] }
      if (operation === 'rollback' || operation === 'create' || operation === 'restore') return {}
      throw new Error(`unexpected operation ${String(operation)}`)
    })
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true)

    render(<HubPluginsSection
      close={() => undefined}
      useSessions={unusedHook}
      useWorkspaces={unusedHook}
    />)

    fireEvent.click(await screen.findByRole('button', { name: '回退到更新前' }))
    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith(runtime, 'dsh.plugins', 'rollback', expect.objectContaining({
        changeId: 'change-1',
        expectedLockHash: 'a'.repeat(43),
      }))
    })

    fireEvent.click(screen.getByText('整机快照与恢复'))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '手工保护点' } })
    await waitFor(() => { expect(screen.getByRole('button', { name: '创建快照' })).not.toHaveProperty('disabled', true) })
    fireEvent.click(screen.getByRole('button', { name: '创建快照' }))
    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith(runtime, 'dsh.snapshots', 'create', expect.objectContaining({
        type: 'configuration', label: '手工保护点', includeSecretValues: false,
      }))
    })

    await waitFor(() => { expect(screen.getByRole('button', { name: '恢复' })).not.toHaveProperty('disabled', true) })
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))
    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith(runtime, 'dsh.snapshots', 'restore', expect.objectContaining({
        snapshotId: 'snapshot-1',
      }))
    })
  })
})
