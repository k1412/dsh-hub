// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { HubNodesSection } from '../src/client/HubNodesSection.tsx'
import { HubPluginsSection } from '../src/client/HubPluginsSection.tsx'
import { HubRuntimePicker } from '../src/client/HubRuntimePicker.tsx'
import { HubSettingsTarget } from '../src/client/HubSettingsTarget.tsx'

interface RegisteredEntry {
  options: { name: string; id?: string; label?: string | (() => string) }
  component: unknown
}

class TestSlots {
  private readonly declared = new Set<string>()
  private readonly pending = new Map<string, Array<() => unknown>>()
  private readonly records: RegisteredEntry[] = []
  private readonly disposers: Array<() => void> = []

  inject(name: string, contribution: () => unknown): void {
    const list = this.pending.get(name) ?? []
    list.push(contribution)
    this.pending.set(name, list)
    if (this.declared.has(name)) this.activate(contribution)
  }

  declare(...names: string[]): void {
    for (const name of names) {
      if (this.declared.has(name)) continue
      this.declared.add(name)
      for (const contribution of this.pending.get(name) ?? []) this.activate(contribution)
    }
  }

  register(options: RegisteredEntry['options'], component: unknown): () => void {
    const entry = { options, component }
    this.records.push(entry)
    return () => {
      const index = this.records.indexOf(entry)
      if (index >= 0) this.records.splice(index, 1)
    }
  }

  entries(name: string): RegisteredEntry[] {
    return this.records.filter(entry => entry.options.name === name)
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0).reverse()) dispose()
  }

  private activate(contribution: () => unknown): void {
    const value = contribution()
    if (typeof value === 'function') {
      this.disposers.push(value as () => void)
      return
    }
    if (value !== null && typeof value === 'object' && Symbol.iterator in value) {
      for (const dispose of value as Iterable<unknown>) {
        if (typeof dispose === 'function') this.disposers.push(dispose as () => void)
      }
    }
  }
}

class TestLocale {
  private language: 'zh' | 'en' = 'zh'
  private dictionaries: { zh: Record<string, string>; en: Record<string, string> } | undefined

  register(_namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void {
    this.dictionaries = dictionaries
    return () => { this.dictionaries = undefined }
  }

  bind(_namespace: string): (key: string) => string {
    return key => this.dictionaries?.[this.language][key] ?? key
  }

  setLocale(language: 'zh' | 'en'): void {
    this.language = language
  }
}

function fixture() {
  const slots = new TestSlots()
  const locale = new TestLocale()
  const effects: Array<() => void> = []
  const ctx = {
    slots,
    locale,
    settingsScope: { refreshAll: vi.fn() },
    effect(activate: () => unknown) {
      const dispose = activate()
      if (typeof dispose === 'function') effects.push(dispose as () => void)
    },
    dispose() {
      slots.dispose()
      for (const dispose of effects.splice(0).reverse()) dispose()
    },
  }
  return { ctx, slots, locale }
}

function labelOf(entry: RegisteredEntry): string | undefined {
  return typeof entry.options.label === 'function' ? entry.options.label() : entry.options.label
}

describe('Hub official Settings registration', () => {
  it('registers node and plugin management as ordinary localized sections', () => {
    expect(inject).toEqual(['slots', 'locale', 'settingsScope'])
    const { ctx, slots, locale } = fixture()
    slots.declare('settings.section', 'settings.action', 'conversation.hero.runtime')
    apply(ctx as never)

    const entries = slots.entries('settings.section')
    expect(entries.map(entry => ({
      id: entry.options.id,
      label: labelOf(entry),
      component: entry.component,
    }))).toEqual([
      { id: 'hub-nodes', label: 'Hub 节点', component: HubNodesSection },
      { id: 'hub-plugins', label: '节点插件', component: HubPluginsSection },
    ])
    expect(slots.entries('conversation.hero.runtime').map(entry => entry.component)).toEqual([HubRuntimePicker])
    expect(slots.entries('settings.action').map(entry => ({
      id: entry.options.id, component: entry.component,
    }))).toEqual([{ id: 'hub-runtime-target', component: HubSettingsTarget }])

    locale.setLocale('en')
    expect(entries.map(labelOf)).toEqual(['Hub nodes', 'Node plugins'])
    ctx.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
  })

  it('recovers when the Settings declaration arrives after the plugin', () => {
    const { ctx, slots } = fixture()
    apply(ctx as never)
    expect(slots.entries('settings.section')).toHaveLength(0)
    slots.declare('settings.section')
    expect(slots.entries('settings.section')).toHaveLength(2)
    ctx.dispose()
  })
})
