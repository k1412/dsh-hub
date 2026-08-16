// @vitest-environment jsdom

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { HubNodesSection } from '../src/client/HubNodesSection.tsx'
import { HubPluginsSection } from '../src/client/HubPluginsSection.tsx'
import { HubRuntimePicker } from '../src/client/HubRuntimePicker.tsx'

usePinnedBrowserLanguages('zh-CN')

describe('Hub official Settings registration', () => {
  it('registers node and plugin management as ordinary localized sections', async () => {
    expect(inject).toEqual(['slots', 'locale'])
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: {
        'settings.section': { kind: 'list', scope: 'root' },
        'conversation.hero.runtime': { kind: 'single', scope: 'root' },
      },
    } as never, () => null)

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entries = slots.entries('settings.section')
    expect(entries.map(entry => ({
      id: entry.options.id,
      label: resolveSlotLabel(entry.options.label),
      component: entry.component,
    }))).toEqual([
      { id: 'hub-nodes', label: 'Hub 节点', component: HubNodesSection },
      { id: 'hub-plugins', label: '节点插件', component: HubPluginsSection },
    ])
    expect(slots.entries('conversation.hero.runtime').map(entry => entry.component)).toEqual([HubRuntimePicker])

    locale.setLocale('en')
    expect(entries.map(entry => resolveSlotLabel(entry.options.label))).toEqual(['Hub nodes', 'Node plugins'])
    await fiber.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('recovers when the Settings declaration arrives after the plugin', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    const slots = ctx.get('slots') as SlotRegistry
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('settings.section')).toHaveLength(0)

    slots.register({
      name: 'root',
      children: { 'settings.section': { kind: 'list', scope: 'root' } },
    } as never, () => null)
    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(2) })
    await ctx.fiber.dispose()
  })
})
