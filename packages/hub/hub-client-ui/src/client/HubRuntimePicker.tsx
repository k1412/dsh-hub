/** Direct node/Runtime choice beside the official new-session Workspace picker. */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconApiOutline14, IconChevronDownOutline14, Menu, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
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
  const [menuOpen, setMenuOpen] = useState(false)

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

  const choose = (id: string): void => {
    setMenuOpen(false)
    const next = runtimesByKey.get(id)
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
  const selectedRuntime = selected === undefined ? undefined : runtimesByKey.get(runtimeKey(selected))
  const selectedLabel = selectedRuntime === undefined
    ? placeholder
    : names.get(selectedRuntime.nodeId) ?? selectedRuntime.nodeId
  const items: MenuEntry[] = runtimes.map(runtime => ({
    id: runtimeKey(runtime),
    label: `${names.get(runtime.nodeId) ?? runtime.nodeId} · ${runtime.runtimeId}`,
  }))

  return (
    <Menu
      open={menuOpen}
      items={items}
      selectedId={selectedRuntime === undefined ? undefined : runtimeKey(selectedRuntime)}
      onSelect={choose}
      onClose={() => { setMenuOpen(false) }}
      portal
      anchor={(
        <button
          type="button"
          className={css.trigger}
          aria-label={t('runtimeLabel')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={runtimes.length === 0}
          title={failed ? t('runtimeUnavailable') : t('runtimeHelp')}
          onClick={() => { setMenuOpen(open => !open) }}
        >
          <IconApiOutline14 className={css.icon} size={16} />
          <span className={css.label}>
            {selectedLabel}
            {selectedRuntime === undefined ? null : (
              <span className={css.runtimeSuffix}> · {selectedRuntime.runtimeId}</span>
            )}
          </span>
          <IconChevronDownOutline14 className={css.chevron} size={12} />
        </button>
      )}
    />
  )
}
