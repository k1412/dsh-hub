/** Fleet-owned archive and trash management inside the official Settings shell. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { invoke, readFleet, type HubLifecycleInventory, type HubLifecycleSession, type HubRuntime } from './api.ts'
import { runtimeKey } from './runtime-target.ts'
import css from './HubSettings.module.css'

type Filter = 'active' | 'archived' | 'trash'
interface Row { session: HubLifecycleSession; runtime: HubRuntime; nodeName: string }
type Props = PropsRuntime<'settings.section'> & PropsLocale<'hub.settings'> & { refreshSessions: () => void }
const capability = 'dsh.session-lifecycle'
function key(row: Row): string { return `${runtimeKey(row.runtime)}\u0000${row.session.sessionId}` }
function errorMessage(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
function supports(runtime: HubRuntime): boolean {
  return runtime.online && runtime.capabilities.some(item => item.name === capability)
}

/** Render archive browsing, restore, and two-stage deletion with explicit owners. */
export function HubSessionsSection({ t, refreshSessions }: Props): ReactNode {
  const [filter, setFilter] = useState<Filter>('active')
  const [target, setTarget] = useState('all')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [runtimes, setRuntimes] = useState<Array<{ runtime: HubRuntime; name: string }>>([])
  const [unavailable, setUnavailable] = useState<string[]>([])
  const [cursors, setCursors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [confirmation, setConfirmation] = useState<{ row: Row; operation: 'trash' | 'purge' }>()
  const [accepted, setAccepted] = useState(false)
  const generation = useRef(0)

  const load = async (status = filter, selected = target): Promise<void> => {
    const current = ++generation.current
    setBusy(true); setError(undefined); setNotice(undefined)
    try {
      const fleet = await readFleet()
      const names = new Map(fleet.nodes.map(node => [node.nodeId, node.displayName]))
      const candidates = fleet.runtimes.map(runtime => ({ runtime, name: names.get(runtime.nodeId) ?? runtime.nodeId }))
      const targets = candidates.filter(item => supports(item.runtime) && (selected === 'all' || runtimeKey(item.runtime) === selected))
      const results = await Promise.allSettled(targets.map(async item => ({ item,
        inventory: await invoke<HubLifecycleInventory>(item.runtime, capability, 'inventory', { status, query, limit: 100 }),
      })))
      if (current !== generation.current) return
      setRuntimes(candidates)
      setUnavailable(candidates.filter(item => !supports(item.runtime)).map(item => `${item.name} · ${item.runtime.runtimeId}`))
      const next: Row[] = []
      const nextCursors: Record<string, string> = {}
      results.forEach(result => {
        if (result.status !== 'fulfilled') return
        const { item, inventory } = result.value
        next.push(...inventory.sessions.map(session => ({ session, runtime: item.runtime, nodeName: item.name })))
        if (inventory.nextCursor !== undefined) nextCursors[runtimeKey(item.runtime)] = inventory.nextCursor
      })
      setRows(next.sort((left, right) => right.session.updatedAt - left.session.updatedAt))
      setCursors(nextCursors)
      const failures = results.flatMap(result => result.status === 'rejected' ? [errorMessage(result.reason)] : [])
      setError(failures.length > 0 ? failures.join('；') : undefined)
    } catch (reason) { if (current === generation.current) setError(errorMessage(reason)) }
    finally { if (current === generation.current) setBusy(false) }
  }
  useEffect(() => { void load(); return () => { generation.current += 1 } }, [])

  const change = async (row: Row, operation: string): Promise<void> => {
    setBusy(true); setError(undefined); setNotice(undefined)
    try {
      await invoke(row.runtime, capability, operation, {
        sessionId: row.session.sessionId,
        ...(['restore', 'purge'].includes(operation) ? { deletedAt: row.session.deletedAt } : {}),
      })
      setConfirmation(undefined); setAccepted(false)
      refreshSessions()
      await load()
      setNotice(t('sessionsDone'))
    } catch (reason) { setError(errorMessage(reason)) }
    finally { setBusy(false) }
  }
  const more = async (runtime: HubRuntime, name: string): Promise<void> => {
    const cursor = cursors[runtimeKey(runtime)]
    if (cursor === undefined) return
    setBusy(true); setError(undefined)
    try {
      const inventory = await invoke<HubLifecycleInventory>(runtime, capability, 'inventory', { status: filter, query, cursor, limit: 100 })
      setRows(previous => {
        const map = new Map(previous.map(row => [key(row), row]))
        inventory.sessions.forEach(session => { const row = { session, runtime, nodeName: name }; map.set(key(row), row) })
        return [...map.values()].sort((left, right) => right.session.updatedAt - left.session.updatedAt)
      })
      setCursors(previous => {
        const next = { ...previous }; delete next[runtimeKey(runtime)]
        if (inventory.nextCursor !== undefined) next[runtimeKey(runtime)] = inventory.nextCursor
        return next
      })
    } catch (reason) { setError(errorMessage(reason)) }
    finally { setBusy(false) }
  }
  const confirm = (row: Row, operation: 'trash' | 'purge'): void => { setAccepted(false); setConfirmation({ row, operation }); setError(undefined) }
  return <section className={css.section} aria-label={t('sessionsNav')}>
    <div className={css.pageHeader}><div><h2>{t('sessionsNav')}</h2><p>{t('sessionsHelp')}</p></div>
      <button className={css.secondaryButton} disabled={busy} onClick={() => { void load() }}>{t('sessionsRefresh')}</button></div>
    <label className={css.runtimePicker}>{t('runtimeLabel')}<select value={target} disabled={busy} onChange={event => {
      setTarget(event.target.value); void load(filter, event.target.value)
    }}><option value="all">{t('sessionsAllNodes')}</option>{runtimes.map(item => <option key={runtimeKey(item.runtime)}
      value={runtimeKey(item.runtime)} disabled={!supports(item.runtime)}>{item.name} · {item.runtime.runtimeId}</option>)}</select></label>
    <div className={css.sessionFilters}>{(['active', 'archived', 'trash'] as const).map(status => <button key={status}
      className={filter === status ? css.activeButton : css.secondaryButton} aria-pressed={filter === status} disabled={busy}
      onClick={() => { setFilter(status); void load(status) }}>{t(status === 'active' ? 'sessionsActive' : status === 'archived' ? 'sessionsArchived' : 'sessionsTrash')}</button>)}</div>
    <form className={css.inlineForm} onSubmit={event => { event.preventDefault(); void load() }}>
      <input aria-label={t('sessionsSearch')} placeholder={t('sessionsSearch')} value={query} disabled={busy}
        onChange={event => { setQuery(event.target.value) }} /><button className={css.secondaryButton} disabled={busy}>{t('sessionsSearchButton')}</button></form>
    {unavailable.length > 0 && <p className={css.sessionHelp}>{t('sessionsUnavailable')} {unavailable.join('、')}</p>}
    {error !== undefined && <p role="alert" className={css.error}>{error}</p>}
    {notice !== undefined && <p role="status" className={css.notice}>{notice}</p>}
    {rows.length === 0 && !busy && <p className={css.sessionHelp}>{t('sessionsEmpty')}</p>}
    <ul className={css.cardList}>{rows.map(row => <li className={css.card} key={key(row)}>
      <div className={css.cardTop}><div className={css.sessionIdentity}><h4>{row.session.title ?? t('sessionsUntitled')}</h4>
        <p>{row.nodeName} · {row.runtime.runtimeId}</p><p>{row.session.workspacePath}</p>
        <small>{row.session.sessionId}</small></div><span className={css.status}>{t(row.session.status === 'active'
          ? 'sessionsActive' : row.session.status === 'archived' ? 'sessionsArchived' : 'sessionsTrash')}</span></div>
      <div className={css.sessionActions}>
        {row.session.status === 'active' && <button className={css.secondaryButton} disabled={busy || row.session.running}
          onClick={() => { void change(row, 'archive') }}>{t('sessionsArchive')}</button>}
        {row.session.status === 'archived' && <button className={css.secondaryButton} disabled={busy}
          onClick={() => { void change(row, 'unarchive') }}>{t('sessionsUnarchive')}</button>}
        {row.session.status === 'trash' ? <><button className={css.secondaryButton} disabled={busy}
          onClick={() => { void change(row, 'restore') }}>{t('sessionsRestore')}</button>
          <button className={css.dangerButton} disabled={busy || !row.session.purgeAvailable}
            onClick={() => { confirm(row, 'purge') }}>{t('sessionsPurge')}</button></>
          : <button className={css.dangerButton} disabled={busy || row.session.running} onClick={() => { confirm(row, 'trash') }}>{t('sessionsDelete')}</button>}
      </div>{row.session.status === 'trash' && !row.session.purgeAvailable && <p className={css.sessionHelp}>{t('sessionsLockHelp')}</p>}
    </li>)}</ul>
    {runtimes.filter(item => cursors[runtimeKey(item.runtime)] !== undefined).map(item => <button key={runtimeKey(item.runtime)}
      className={css.secondaryButton} disabled={busy} onClick={() => { void more(item.runtime, item.name) }}>{t('sessionsMore')} · {item.name}</button>)}
    <p className={css.sessionHelp}>{t('sessionsTrashHelpFooter')}</p>
    <Modal open={confirmation !== undefined} title={t(confirmation?.operation === 'purge' ? 'sessionsPurgeTitle' : 'sessionsTrashTitle')}
      closeLabel={t('sessionsClose')} onClose={() => { if (!busy) setConfirmation(undefined) }}
      description={t(confirmation?.operation === 'purge' ? 'sessionsPurgeHelp' : 'sessionsTrashHelp')}
      footer={<><button className={css.secondaryButton} disabled={busy} onClick={() => { setConfirmation(undefined) }}>{t('sessionsCancel')}</button>
        <button className={css.dangerButton} disabled={busy || (confirmation?.operation === 'purge' && !accepted)} onClick={() => {
          if (confirmation !== undefined) void change(confirmation.row, confirmation.operation)
        }}>{t(confirmation?.operation === 'purge' ? 'sessionsPurge' : 'sessionsDelete')}</button></>}>
      <p>{confirmation?.row.session.title ?? t('sessionsUntitled')} · {confirmation?.row.nodeName}</p>
      {confirmation?.operation === 'purge' && <label><input type="checkbox" checked={accepted} disabled={busy}
        onChange={event => { setAccepted(event.target.checked) }} /> {t('sessionsPurgeConfirm')}</label>}
      {error !== undefined && <p role="alert">{error}</p>}
    </Modal>
  </section>
}
