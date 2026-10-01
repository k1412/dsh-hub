/** Batch node-to-node model transfer; the browser receives receipts only. */
import { useEffect, useState, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { readFleet, syncModels, type HubRuntime, type ModelSyncReceipt } from './api.ts'
import { runtimeKey } from './runtime-target.ts'
import css from './HubSettings.module.css'

/** Render explicit source and destination choices without a Hub model catalog. */
export function HubModelSyncSection({ t, refreshNodeSettings }: PropsLocale<'hub.settings'> & { refreshNodeSettings: () => void }): ReactNode {
  const [runtimes, setRuntimes] = useState<Array<{ runtime: HubRuntime; name: string }>>([])
  const [source, setSource] = useState('')
  const [targets, setTargets] = useState<string[]>([])
  const [replace, setReplace] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [results, setResults] = useState<ModelSyncReceipt[]>([])
  const load = async (): Promise<void> => {
    try {
      const fleet = await readFleet(); const names = new Map(fleet.nodes.filter(row => row.status === 'active').map(row => [row.nodeId, row.displayName]))
      setRuntimes(fleet.runtimes.filter(row => names.has(row.nodeId)).map(runtime => ({ runtime, name: `${names.get(runtime.nodeId)} · ${runtime.runtimeId}` })))
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  useEffect(() => { void load() }, [])
  const supported = (row: HubRuntime): boolean => row.online && row.capabilities.some(cap => cap.name === 'dsh.model-sync')
  const sync = async (): Promise<void> => {
    const origin = runtimes.find(row => runtimeKey(row.runtime) === source)?.runtime
    if (origin === undefined) return
    setBusy(true); setError(undefined); setResults([])
    try {
      const destinations = runtimes.filter(row => targets.includes(runtimeKey(row.runtime))).map(row => row.runtime)
      setResults(await syncModels(origin, destinations, replace)); refreshNodeSettings(); await load()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <section className={css.section} aria-label={t('modelSyncNav')}>
    <div className={css.pageHeader}><div><h2>{t('modelSyncNav')}</h2><p>{t('modelSyncHelp')}</p></div>
      <button className={css.secondaryButton} disabled={busy} onClick={() => { void load() }}>{t('modelSyncRefresh')}</button></div>
    <label className={css.runtimePicker}>{t('modelSyncSource')}<select value={source} disabled={busy} onChange={event => {
      const value = event.target.value; setSource(value); setTargets(previous => previous.filter(key => key !== value)); setResults([])
    }}><option value="">{t('modelSyncChoose')}</option>{runtimes.map(row => <option key={runtimeKey(row.runtime)}
      value={runtimeKey(row.runtime)} disabled={!supported(row.runtime)}>{row.name}{supported(row.runtime) ? '' : ` · ${t('modelSyncUnavailable')}`}</option>)}</select></label>
    <h3>{t('modelSyncTargets')}</h3><ul className={css.cardList}>{runtimes.filter(row => runtimeKey(row.runtime) !== source).map(row => {
      const key = runtimeKey(row.runtime)
      return <li className={css.card} key={key}><label><input type="checkbox" checked={targets.includes(key)} disabled={busy || !supported(row.runtime)}
        onChange={event => { setTargets(previous => event.target.checked ? [...previous, key] : previous.filter(value => value !== key)) }} /> {row.name}
        {!supported(row.runtime) && ` · ${t('modelSyncUnavailable')}`}</label></li>
    })}</ul>
    <label><input type="checkbox" checked={replace} disabled={busy} onChange={event => { setReplace(event.target.checked) }} /> {t('modelSyncReplace')}</label>
    <p className={css.sessionHelp}>{t('modelSyncBoundary')}</p>
    <button className={css.activeButton} disabled={busy || source === '' || targets.length === 0} onClick={() => { void sync() }}>{t(busy ? 'modelSyncBusy' : 'modelSyncStart')}</button>
    {error !== undefined && <p role="alert" className={css.error}>{error}</p>}
    <ul className={css.cardList}>{results.map(result => <li className={css.card} key={runtimeKey(result)}>
      {runtimes.find(row => runtimeKey(row.runtime) === runtimeKey(result))?.name} · {result.ok
        ? `${t('modelSyncDone')} ${result.providers ?? 0} ${t('modelSyncProviders')} / ${result.models ?? 0} ${t('modelSyncModels')} · ${t('modelSyncSkipped')} ${result.skipped ?? 0}`
        : t('modelSyncFailed')}
    </li>)}</ul>
  </section>
}
