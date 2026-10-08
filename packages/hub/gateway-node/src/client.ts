/** Experimental official-client plugin. All conversation UI stays upstream-owned. */
interface Snapshot<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
interface SessionRow { id: string; retainedBy: Record<string, number | undefined> }
interface NavigationContext {
  connection: { generation: Snapshot<{ id: number } | undefined> }
  sessions: {
    list: Snapshot<{ phase: string; ids: string[]; byId: Record<string, SessionRow> }>
    refresh(): Promise<void>
    subagentAddress(id: string): unknown
    retain(target: unknown, options: { source: string; signal: AbortSignal }): { ready: Promise<unknown>; release(): void }
  }
  workspaces: { list: Snapshot<{ phase: string; archivedSessionIds: readonly string[] }> }
  layout: { beginNavigation(): AbortSignal }
  uiWorkspace: { openSession(target: unknown): void }
  effect(callback: () => () => void, label: string): void
}
export const inject = ['sessions', 'workspaces', 'layout', 'uiWorkspace', 'connection']
class ArchivedSessionError extends Error {}
function waitReady(ctx: NavigationContext, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const disposers: Array<() => void> = []
    const cleanup = () => { for (const dispose of disposers) dispose(); signal.removeEventListener('abort', aborted) }
    const aborted = () => { cleanup(); reject(signal.reason) }
    const check = () => {
      if (ctx.sessions.list.getSnapshot().phase === 'ready' && ctx.workspaces.list.getSnapshot().phase === 'ready') { cleanup(); resolve() }
    }
    disposers.push(ctx.sessions.list.subscribe(check), ctx.workspaces.list.subscribe(check))
    signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted(); else check()
  })
}
export function apply(ctx: NavigationContext): void {
  const key = new URL(location.href).searchParams.get('gatewayIntent')
  if (!key) return
  ctx.effect(() => {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(new Error('Native navigation timed out')), 20_000)
    const notice = document.createElement('div')
    notice.id = 'gateway-session-intent'; notice.setAttribute('role', 'status'); notice.dataset.state = 'loading'
    notice.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:white;color:#222;padding:24px;font:16px sans-serif'
    notice.textContent = 'Opening the selected native session…'; document.body.prepend(notice)
    const read = async () => {
      const reply = await fetch(`/_hub/session-intent?intent=${encodeURIComponent(key)}`, { credentials: 'same-origin', signal: abort.signal, cache: 'no-store' })
      if (!reply.ok) throw new Error('Session target expired or disconnected. Reopen it from the experiment directory.')
      const value = await reply.json() as { nodeId: string; runtimeId: string; generation: string; sessionId: string }
      if (![value.nodeId, value.runtimeId, value.generation, value.sessionId].every(v => typeof v === 'string' && v.length > 0)) throw new Error('Invalid session target')
      return value
    }
    let rejectAbort: () => void = () => {}
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(abort.signal.reason)
      abort.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    const navigation = (async () => {
      const intent = await read()
      await waitReady(ctx, abort.signal)
      const generation = ctx.connection.generation.getSnapshot()?.id
      const stopGeneration = ctx.connection.generation.subscribe(() => {
        if (ctx.connection.generation.getSnapshot()?.id !== generation) abort.abort(new Error('Connection changed'))
      })
      abort.signal.addEventListener('abort', stopGeneration, { once: true })
      await ctx.sessions.refresh()
      abort.signal.throwIfAborted()
      if (!ctx.sessions.list.getSnapshot().ids.includes(intent.sessionId)) throw new Error('The selected session no longer exists on this node.')
      const checkArchived = () => {
        if (ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(intent.sessionId)) {
          throw new ArchivedSessionError('This session is archived. Restore it in the owning node’s DSH before opening it from the directory. The archive has not been changed.')
        }
      }
      checkArchived()
      const target = ctx.sessions.subagentAddress(intent.sessionId) ?? intent.sessionId
      const retained = ctx.sessions.retain(target, { source: 'workspaceOperation', signal: abort.signal })
      try {
        await retained.ready
        const verified = await read()
        if (JSON.stringify(verified) !== JSON.stringify(intent)) throw new Error('Session ownership changed')
        abort.signal.throwIfAborted()
        checkArchived()
        // Supersedes the official startup restore's asynchronous workspace navigation.
        ctx.layout.beginNavigation()
        ctx.uiWorkspace.openSession(target)
        if (!(ctx.sessions.list.getSnapshot().byId[intent.sessionId]?.retainedBy.mainView)) throw new Error('Native session selection was not confirmed')
        stopGeneration()
        notice.style.cssText = 'padding:8px;font:12px sans-serif;background:#e9f5ed;color:#17452b'
        notice.dataset.state = 'opened'; notice.dataset.sessionId = intent.sessionId
        notice.textContent = 'Selected native session opened · session directory experiment'
        const url = new URL(location.href); url.searchParams.delete('gatewayIntent'); history.replaceState(null, '', url)
      } finally { retained.release() }
    })()
    void Promise.race([navigation, cancelled]).catch((error: unknown) => {
      notice.dataset.state = 'error'; notice.setAttribute('role', 'alert')
      notice.textContent = error instanceof ArchivedSessionError ? error.message : 'Could not open the selected session. The target expired, disconnected, or is unavailable. Return to the experiment directory; no substitute session was selected.'
      const back = document.createElement('a'); back.href = '/_hub/directory'; back.textContent = ' Return to session directory'; notice.append(back)
    }).finally(() => { clearTimeout(timer); abort.signal.removeEventListener('abort', rejectAbort); abort.abort() })
    return () => { clearTimeout(timer); abort.abort(); notice.remove() }
  }, 'gateway experiment: exact native session intent')
}
