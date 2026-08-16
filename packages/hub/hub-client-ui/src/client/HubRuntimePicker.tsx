/** Direct node/Runtime choice beside the official new-session Workspace picker. */

import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the new-session Runtime seat into the shared SlotMap.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { readFleet, type FleetSnapshot, type HubRuntime } from './api.ts'
import {
  readRuntimeTarget, replaceRuntimeTarget, runtimeKey, runtimeTargetOfWorkspace, supportsOfficialWeb,
  type HubRuntimeTarget,
} from './runtime-target.ts'
import css from './HubRuntimePicker.module.css'

/** Full props composed by the Hub Runtime slot registration. */
export type HubRuntimePickerProps = PropsRuntime<'conversation.hero.runtime'>
  & PropsLocale<'hub.settings'>

function sameTarget(left: HubRuntimeTarget | undefined, right: HubRuntimeTarget | undefined): boolean {
  return left !== undefined && right !== undefined && runtimeKey(left) === runtimeKey(right)
}

/**
 * Render the node/Runtime selector that scopes discovery for the next Workspace.
 * @param props - hero owner state and Hub locale helpers.
 * @returns the selector, including explicit loading and unavailable states.
 */
export function HubRuntimePicker({ selectedWorkspaceId, onTargetChange, t }: HubRuntimePickerProps): ReactNode {
  const [fleet, setFleet] = useState<FleetSnapshot>()
  const [selected, setSelected] = useState<HubRuntimeTarget | undefined>(() => readRuntimeTarget())
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let current = true
    void readFleet().then((snapshot) => {
      if (!current) return
      setFleet(snapshot)
      setFailed(false)
    }).catch(() => {
      if (current) setFailed(true)
    })
    return () => { current = false }
  }, [])

  const runtimes = useMemo(() => (fleet?.runtimes ?? [])
    .filter(runtime => runtime.online && supportsOfficialWeb(runtime)), [fleet])
  const runtimesByKey = useMemo(() => new Map(
    runtimes.map(runtime => [runtimeKey(runtime), runtime]),
  ), [runtimes])

  // An existing Workspace is authoritative. Otherwise keep the explicit or
  // last-used Runtime when it remains online, falling back to the first live
  // dsh.web capability. Writing the target into the URL makes every later
  // ownerless Host request (including directory browsing) route correctly.
  useEffect(() => {
    if (runtimes.length === 0) return
    const workspaceTarget = selectedWorkspaceId === undefined
      ? undefined
      : runtimeTargetOfWorkspace(selectedWorkspaceId)
    const candidate = workspaceTarget ?? selected ?? readRuntimeTarget()
    const fallback = runtimes[0] as HubRuntime
    const next = candidate === undefined ? fallback : runtimesByKey.get(runtimeKey(candidate)) ?? fallback
    if (!sameTarget(selected, next)) setSelected(next)
    replaceRuntimeTarget(next)
  }, [runtimes, runtimesByKey, selected, selectedWorkspaceId])

  const names = useMemo(() => new Map(
    (fleet?.nodes ?? []).map(node => [node.nodeId, node.displayName]),
  ), [fleet])

  const choose = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = runtimesByKey.get(event.currentTarget.value)
    if (next === undefined || sameTarget(selected, next)) return
    setSelected(next)
    replaceRuntimeTarget(next)
    onTargetChange()
  }

  const placeholder = failed
    ? t('runtimeUnavailable')
    : fleet === undefined
      ? t('runtimeLoading')
      : t('runtimeEmpty')

  return (
    <label className={css.picker} title={failed ? t('runtimeUnavailable') : t('runtimeHelp')}>
      <span className={css.srOnly}>{t('runtimeLabel')}</span>
      <select
        aria-label={t('runtimeLabel')}
        className={css.select}
        disabled={runtimes.length === 0}
        onChange={choose}
        value={selected === undefined ? '' : runtimeKey(selected)}
      >
        {runtimes.length === 0 ? <option value="">{placeholder}</option> : null}
        {runtimes.map((runtime: HubRuntime) => (
          <option key={runtimeKey(runtime)} value={runtimeKey(runtime)}>
            {names.get(runtime.nodeId) ?? runtime.nodeId} · {runtime.runtimeId}
          </option>
        ))}
      </select>
    </label>
  )
}
