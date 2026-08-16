/** Hub-only extensions mounted into the official DSH Web Settings shell. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { HubNodesSection } from './HubNodesSection.tsx'
import { HubPluginsSection } from './HubPluginsSection.tsx'
import { HubRuntimePicker } from './HubRuntimePicker.tsx'
import { en, zh, type HubSettingsLocaleKey } from './locales.ts'

export type { HubSettingsLocaleKey } from './locales.ts'
export * from './api.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Hub-only Settings navigation copy. */
    'hub.settings': HubSettingsLocaleKey
  }
}

const NS = 'hub.settings'

/** Services required by the Hub hero and Settings contributions. */
export const inject = ['slots', 'locale']

/** Register node enrollment and plugin recovery as ordinary official Settings pages. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'hub-client-ui: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.hero.runtime', () => ctx.slots.register({
    name: 'conversation.hero.runtime',
    locale: NS,
  }, HubRuntimePicker))
  ctx.slots.inject('settings.section', function* () {
    yield ctx.slots.register({
      name: 'settings.section',
      id: 'hub-nodes',
      order: 30,
      label: () => t('nodesNav'),
    }, HubNodesSection)
    yield ctx.slots.register({
      name: 'settings.section',
      id: 'hub-plugins',
      order: 40,
      label: () => t('pluginsNav'),
    }, HubPluginsSection)
  })
}
