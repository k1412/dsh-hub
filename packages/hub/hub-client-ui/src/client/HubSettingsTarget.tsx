/** Settings-header target: every Host-backed row below it belongs to this Runtime. */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconApiOutline14, IconChevronDownOutline14, Menu, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { readFleet, type FleetSnapshot } from './api.ts'
import {
  readRuntimeTarget, replaceRuntimeTarget, runtimeKey, supportsOfficialWeb,
  type HubRuntimeTarget,
} from './runtime-target.ts'
import css from './HubSettings.module.css'

/** Full props composed by the Settings action registration. */
export type HubSettingsTargetProps = PropsRuntime<'settings.action'> & PropsLocale<'hub.settings'>
  & { refreshNodeSettings?: () => void }

/** Render the active node/Runtime binding in Settings chrome. */
export function HubSettingsTarget({ t, refreshNodeSettings = () => undefined }: HubSettingsTargetProps): ReactNode {
  const [fleet, setFleet] = useState<FleetSnapshot>()
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const [target, setTarget] = useState<HubRuntimeTarget | undefined>(() => readRuntimeTarget())

  useEffect(() => {
    let current = true
    void readFleet().then((snapshot) => {
      if (!current) return
      setFleet(snapshot)
      setFailed(false)
    }).catch(() => { if (current) setFailed(true) })
    return () => { current = false }
  }, [])

  const names = useMemo(() => new Map(
    (fleet?.nodes ?? []).map(node => [node.nodeId, node.displayName]),
  ), [fleet])
  const runtimes = useMemo(() => (fleet?.runtimes ?? [])
    .filter(runtime => runtime.online && supportsOfficialWeb(runtime)), [fleet])
  const requestedId = target === undefined ? undefined : runtimeKey(target)
  const requested = runtimes.find(runtime => runtimeKey(runtime) === requestedId)
  const selected = requested ?? runtimes[0]
  const selectedId = selected === undefined ? undefined : runtimeKey(selected)
  useEffect(() => {
    if (fleet === undefined || requested !== undefined || selected === undefined) return
    // The server uses the same first-online fallback for an ownerless request.
    // Pin it before refreshing active Host-backed scopes. Their generation
    // fence prevents a late response from the previous owner from publishing.
    setTarget(selected)
    replaceRuntimeTarget(selected)
    refreshNodeSettings()
  }, [fleet, refreshNodeSettings, requested, selected])
  const items: MenuEntry[] = runtimes.map(runtime => ({
    id: runtimeKey(runtime),
    label: `${names.get(runtime.nodeId) ?? runtime.nodeId} · ${runtime.runtimeId}`,
  }))
  const label = selected === undefined
    ? failed ? t('runtimeUnavailable') : fleet === undefined ? t('runtimeLoading') : t('runtimeEmpty')
    : `${names.get(selected.nodeId) ?? selected.nodeId} · ${selected.runtimeId}`

  const choose = (id: string): void => {
    setOpen(false)
    const runtime = runtimes.find(candidate => runtimeKey(candidate) === id)
    if (runtime === undefined || runtimeKey(runtime) === selectedId) return
    setTarget(runtime)
    replaceRuntimeTarget(runtime)
    refreshNodeSettings()
  }

  return (
    <div className={css.settingsTarget}>
      <span>{t('settingsTarget')}</span>
      <Menu
        open={open}
        items={items}
        selectedId={selectedId}
        onSelect={choose}
        onClose={() => { setOpen(false) }}
        portal
        anchor={(
          <button
            type="button"
            className={css.settingsTargetButton}
            aria-label={t('settingsTarget')}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={runtimes.length === 0}
            title={t('settingsTargetHelp')}
            onClick={() => { setOpen(value => !value) }}
          >
            <IconApiOutline14 size={14} />
            <strong>{label}</strong>
            <IconChevronDownOutline14 size={12} />
          </button>
        )}
      />
    </div>
  )
}
