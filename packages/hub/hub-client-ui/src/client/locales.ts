/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  nodesNav: 'Hub 节点',
  pluginsNav: '节点插件',
} satisfies Record<string, string>

/** Hub settings locale key union. */
export type HubSettingsLocaleKey = keyof typeof zh

/** English mirror dictionary. */
export const en = {
  nodesNav: 'Hub nodes',
  pluginsNav: 'Node plugins',
} satisfies Record<HubSettingsLocaleKey, string>
