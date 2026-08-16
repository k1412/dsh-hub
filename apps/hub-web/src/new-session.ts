/** Browser-only new-session dialog primitives kept independently testable. */

export interface RuntimeChoice {
  nodeId: string
  runtimeId: string
  label: string
}

export interface DirectoryChoice {
  path: string
  kind: 'directory' | 'symlink'
}

export interface NewSessionDialogModel {
  open: boolean
  runtimes: readonly RuntimeChoice[]
  target: string
  workspacePath: string
  title: string
  browsePath?: string
  directories: readonly DirectoryChoice[]
  workspaceLoading: boolean
  creating: boolean
  error?: string
}

export interface NewSessionDialogHandlers {
  close: () => void
  submit: (event: SubmitEvent) => void
  target: (value: string) => void
  workspacePath: (value: string) => void
  title: (value: string) => void
  directory: (path: string) => void
  parent: () => void
  refresh: () => void
}

function html(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Encode an arbitrary pair without placing HTML-invalid NUL bytes in option values. */
export function encodeRuntimeTarget(nodeId: string, runtimeId: string): string {
  if (nodeId === '' || runtimeId === '') throw new Error('节点 Runtime 标识不能为空')
  return encodeURIComponent(JSON.stringify([nodeId, runtimeId]))
}

/** Decode and validate the opaque runtime option value. */
export function decodeRuntimeTarget(value: string): { nodeId: string; runtimeId: string } {
  try {
    const decoded: unknown = JSON.parse(decodeURIComponent(value))
    if (!Array.isArray(decoded) || decoded.length !== 2
      || typeof decoded[0] !== 'string' || decoded[0] === ''
      || typeof decoded[1] !== 'string' || decoded[1] === '') throw new Error('invalid tuple')
    return { nodeId: decoded[0], runtimeId: decoded[1] }
  } catch {
    throw new Error('节点 Runtime 标识无效，请重新选择')
  }
}

/** Return a navigable parent for POSIX, drive-letter, and UNC paths. */
export function parentDirectory(value: string): string {
  if (value === '/' || /^[A-Za-z]:[\\/]?$/.test(value)) return value
  const separator = value.includes('\\') ? '\\' : '/'
  const trimmed = value.replace(/[\\/]+$/, '')
  if (trimmed === '') return separator
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (index < 0) return value
  if (index === 0) return separator
  if (index === 2 && /^[A-Za-z]:/.test(trimmed)) return `${trimmed.slice(0, 2)}${separator}`
  if (trimmed.startsWith('\\\\')) {
    const rootParts = trimmed.split('\\').filter(Boolean)
    if (rootParts.length <= 2) return trimmed
  }
  return trimmed.slice(0, index)
}

/** Accept only directory-shaped rows from the untrusted node command result. */
export function directoryChoices(value: unknown): DirectoryChoice[] {
  if (!Array.isArray(value)) throw new Error('节点返回了无效的目录列表')
  return value.flatMap((entry): DirectoryChoice[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const candidate = entry as { path?: unknown; kind?: unknown }
    if (typeof candidate.path !== 'string' || candidate.path === ''
      || (candidate.kind !== 'directory' && candidate.kind !== 'symlink')) return []
    return [{ path: candidate.path, kind: candidate.kind }]
  })
}

function pathLabel(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '')
  if (trimmed === '') return value
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index < 0 ? trimmed : trimmed.slice(index + 1)
}

/** Render a state-preserving dialog with explicit close and submit semantics. */
export function newSessionDialog(model: NewSessionDialogModel): string {
  const runtimeOptions = model.runtimes.map((runtime) => {
    const key = encodeRuntimeTarget(runtime.nodeId, runtime.runtimeId)
    return `<option value="${html(key)}"${key === model.target ? ' selected' : ''}>${html(runtime.label)}</option>`
  }).join('')
  const directoryOptions = model.directories.map(directory =>
    `<option value="${html(directory.path)}">${html(pathLabel(directory.path))}${directory.kind === 'symlink' ? ' ↗' : ''}</option>`).join('')
  const suggestions = [model.browsePath, ...model.directories.map(directory => directory.path)]
    .filter((path): path is string => path !== undefined && path !== '')
    .map(path => `<option value="${html(path)}"></option>`).join('')
  const unavailable = model.runtimes.length === 0
  return `<dialog id="new-dialog"${model.open ? ' data-request-open="true"' : ''}>
    <form id="new-form">
      <div class="dialog-heading"><h2>新建会话</h2><button type="button" class="icon dialog-close" data-action="close-new-session" aria-label="关闭新建会话">×</button></div>
      ${unavailable ? '<div class="dialog-error" role="alert">当前没有提供会话能力的在线 Runtime。</div>' : ''}
      <label>节点 Runtime<select name="target" required ${unavailable || model.creating ? 'disabled' : ''}>${runtimeOptions}</select></label>
      <label>工作目录
        <input name="workspacePath" list="workspace-suggestions" value="${html(model.workspacePath)}" autocomplete="off" placeholder="从节点读取，或直接输入路径" ${unavailable || model.creating ? 'disabled' : ''}>
        <datalist id="workspace-suggestions">${suggestions}</datalist>
      </label>
      <div class="directory-browser" aria-busy="${String(model.workspaceLoading)}">
        <div class="directory-browser-head"><span>${model.browsePath === undefined ? '节点目录' : html(model.browsePath)}</span><div>
          <button type="button" data-action="workspace-parent" ${model.browsePath === undefined || parentDirectory(model.browsePath) === model.browsePath || model.workspaceLoading || model.creating ? 'disabled' : ''}>上一级</button>
          <button type="button" data-action="workspace-refresh" ${unavailable || model.workspaceLoading || model.creating ? 'disabled' : ''}>刷新</button>
        </div></div>
        <select name="workspaceDirectory" aria-label="选择节点目录" ${directoryOptions === '' || model.workspaceLoading || model.creating ? 'disabled' : ''}>
          <option value="">${model.workspaceLoading ? '正在读取节点目录…' : directoryOptions === '' ? '没有可进入的子目录' : '选择并进入子目录…'}</option>${directoryOptions}
        </select>
        <p>路径仅从所选节点实时读取；Hub 不保存目录缓存。也可以在上方直接输入完整路径。</p>
      </div>
      <label>标题（可选）<input name="title" value="${html(model.title)}" maxlength="1024" ${unavailable || model.creating ? 'disabled' : ''}></label>
      ${model.error === undefined ? '' : `<div class="dialog-error" role="alert">${html(model.error)}</div>`}
      <div class="dialog-actions"><button type="button" data-action="close-new-session">取消</button><button type="submit" data-action="create-session" ${unavailable || model.creating ? 'disabled' : ''}>${model.creating ? '创建中…' : '创建'}</button></div>
    </form>
  </dialog>`
}

/** Bind all dialog exits explicitly so a cancelled dialog can never submit. */
export function bindNewSessionDialog(dialog: HTMLDialogElement, handlers: NewSessionDialogHandlers): void {
  dialog.querySelectorAll<HTMLElement>('[data-action="close-new-session"]').forEach((element) => {
    element.addEventListener('click', handlers.close)
  })
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    handlers.close()
  })
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) handlers.close()
  })
  dialog.querySelector<HTMLFormElement>('#new-form')?.addEventListener('submit', (event) => {
    event.preventDefault()
    handlers.submit(event)
  })
  dialog.querySelector<HTMLSelectElement>('[name="target"]')?.addEventListener('change', (event) => {
    handlers.target((event.currentTarget as HTMLSelectElement).value)
  })
  dialog.querySelector<HTMLInputElement>('[name="workspacePath"]')?.addEventListener('input', (event) => {
    handlers.workspacePath((event.currentTarget as HTMLInputElement).value)
  })
  dialog.querySelector<HTMLInputElement>('[name="title"]')?.addEventListener('input', (event) => {
    handlers.title((event.currentTarget as HTMLInputElement).value)
  })
  dialog.querySelector<HTMLSelectElement>('[name="workspaceDirectory"]')?.addEventListener('change', (event) => {
    const path = (event.currentTarget as HTMLSelectElement).value
    if (path !== '') handlers.directory(path)
  })
  dialog.querySelector('[data-action="workspace-parent"]')?.addEventListener('click', handlers.parent)
  dialog.querySelector('[data-action="workspace-refresh"]')?.addEventListener('click', handlers.refresh)
}
