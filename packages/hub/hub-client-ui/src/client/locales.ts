/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  nodesNav: 'Hub 节点',
  pluginsNav: '节点插件',
  runtimeLabel: '节点与 Runtime',
  runtimeHelp: '选择新会话使用的节点；文件夹在旁边选择',
  runtimeLoading: '正在读取节点…',
  runtimeEmpty: '没有可用节点',
  runtimeUnavailable: '节点读取失败',
} satisfies Record<string, string>

/** Hub settings locale key union. */
export type HubSettingsLocaleKey = keyof typeof zh

/** English mirror dictionary. */
export const en = {
  nodesNav: 'Hub nodes',
  pluginsNav: 'Node plugins',
  runtimeLabel: 'Node and Runtime',
  runtimeHelp: 'Choose the node for the new session, then choose its folder',
  runtimeLoading: 'Loading nodes…',
  runtimeEmpty: 'No available nodes',
  runtimeUnavailable: 'Could not load nodes',
} satisfies Record<HubSettingsLocaleKey, string>
