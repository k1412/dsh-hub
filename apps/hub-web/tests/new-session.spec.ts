// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import {
  bindNewSessionDialog, decodeRuntimeTarget, directoryChoices, encodeRuntimeTarget, newSessionDialog, parentDirectory,
  type NewSessionDialogHandlers,
} from '../src/new-session.ts'

function model() {
  const target = encodeRuntimeTarget('node\0/odd', 'web:runtime')
  return {
    open: true,
    runtimes: [{ nodeId: 'node\0/odd', runtimeId: 'web:runtime', label: '工作站 · Web' }],
    target,
    workspacePath: '/Users/example/Code',
    title: '继续工作',
    browsePath: '/Users/example/Code',
    directories: [
      { path: '/Users/example/Code/project', kind: 'directory' as const },
      { path: '/Users/example/Code/current', kind: 'symlink' as const },
    ],
    workspaceLoading: false,
    creating: false,
  }
}

function mount(): { dialog: HTMLDialogElement; handlers: NewSessionDialogHandlers } {
  document.body.innerHTML = newSessionDialog(model())
  const dialog = document.querySelector<HTMLDialogElement>('#new-dialog') as HTMLDialogElement
  const handlers: NewSessionDialogHandlers = {
    close: vi.fn(),
    submit: vi.fn(),
    target: vi.fn(),
    workspacePath: vi.fn(),
    title: vi.fn(),
    directory: vi.fn(),
    parent: vi.fn(),
    refresh: vi.fn(),
  }
  bindNewSessionDialog(dialog, handlers)
  return { dialog, handlers }
}

describe('new session dialog', () => {
  it('round-trips arbitrary runtime IDs without HTML NUL corruption', () => {
    const encoded = encodeRuntimeTarget('node\0/odd', 'web:runtime')
    expect(encoded).not.toContain('\0')
    expect(decodeRuntimeTarget(encoded)).toEqual({ nodeId: 'node\0/odd', runtimeId: 'web:runtime' })
    expect(() => decodeRuntimeTarget('node�runtime')).toThrow('节点 Runtime 标识无效')
  })

  it('renders explicit non-submit cancel controls and a submit create control', () => {
    const { dialog } = mount()
    const cancel = dialog.querySelector<HTMLButtonElement>('.dialog-actions [data-action="close-new-session"]')
    const create = dialog.querySelector<HTMLButtonElement>('[data-action="create-session"]')
    expect(cancel?.type).toBe('button')
    expect(create?.type).toBe('submit')
    expect((dialog.querySelector('[name="workspacePath"]') as HTMLInputElement).value).toBe('/Users/example/Code')
    expect(dialog.querySelectorAll('[name="workspaceDirectory"] option')).toHaveLength(3)
  })

  it('shows a visible, disabled creation state while preserving form values', () => {
    document.body.innerHTML = newSessionDialog({ ...model(), creating: true })
    const create = document.querySelector<HTMLButtonElement>('[data-action="create-session"]')
    expect(create?.textContent).toBe('创建中…')
    expect(create?.disabled).toBe(true)
    expect((document.querySelector('[name="workspacePath"]') as HTMLInputElement).value).toBe('/Users/example/Code')
    expect((document.querySelector('[name="title"]') as HTMLInputElement).value).toBe('继续工作')
  })

  it('closes from cancel, Escape, and backdrop without submitting', () => {
    const { dialog, handlers } = mount()
    dialog.querySelector<HTMLButtonElement>('.dialog-actions [data-action="close-new-session"]')?.click()
    const cancelled = new Event('cancel', { cancelable: true })
    dialog.dispatchEvent(cancelled)
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(handlers.close).toHaveBeenCalledTimes(3)
    expect(handlers.submit).not.toHaveBeenCalled()
    expect(cancelled.defaultPrevented).toBe(true)
  })

  it('submits create and reports directory navigation and live input', () => {
    const { dialog, handlers } = mount()
    const workspace = dialog.querySelector<HTMLInputElement>('[name="workspacePath"]') as HTMLInputElement
    workspace.value = '/Users/example/next'
    workspace.dispatchEvent(new Event('input', { bubbles: true }))
    const directory = dialog.querySelector<HTMLSelectElement>('[name="workspaceDirectory"]') as HTMLSelectElement
    directory.value = '/Users/example/Code/project'
    directory.dispatchEvent(new Event('change', { bubbles: true }))
    dialog.querySelector<HTMLButtonElement>('[data-action="workspace-parent"]')?.click()
    dialog.querySelector<HTMLButtonElement>('[data-action="workspace-refresh"]')?.click()
    dialog.querySelector<HTMLFormElement>('#new-form')?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    expect(handlers.workspacePath).toHaveBeenCalledWith('/Users/example/next')
    expect(handlers.directory).toHaveBeenCalledWith('/Users/example/Code/project')
    expect(handlers.parent).toHaveBeenCalledOnce()
    expect(handlers.refresh).toHaveBeenCalledOnce()
    expect(handlers.submit).toHaveBeenCalledOnce()
  })

  it('keeps path navigation inside POSIX, Windows, and UNC roots', () => {
    expect(parentDirectory('/Users/example/Code')).toBe('/Users/example')
    expect(parentDirectory('/')).toBe('/')
    expect(parentDirectory('C:\\Users\\example\\Code')).toBe('C:\\Users\\example')
    expect(parentDirectory('C:\\')).toBe('C:\\')
    expect(parentDirectory('\\\\server\\share')).toBe('\\\\server\\share')
    expect(parentDirectory('\\\\server\\share\\project')).toBe('\\\\server\\share')
  })

  it('accepts only navigable node directory rows', () => {
    expect(directoryChoices([
      { path: '/project', kind: 'directory' },
      { path: '/current', kind: 'symlink' },
      { path: '/note.txt', kind: 'file' },
      { path: 42, kind: 'directory' },
      null,
    ])).toEqual([
      { path: '/project', kind: 'directory' },
      { path: '/current', kind: 'symlink' },
    ])
    expect(() => directoryChoices({ entries: [] })).toThrow('节点返回了无效的目录列表')
  })
})
