/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  nodesNav: 'Hub 节点',
  pluginsNav: '节点插件',
  runtimeLabel: '节点与 Runtime',
  runtimeHelp: '选择新会话使用的节点；文件夹在旁边选择',
  runtimeLoading: '正在读取节点…',
  runtimeEmpty: '没有可用节点',
  runtimeUnavailable: '节点读取失败',
  settingsTarget: '当前 Runtime',
  settingsTargetHelp: '模型、权限、Agent、会话偏好和可配置插件属于此 Runtime；语言与外观属于当前浏览器；Hub 节点属于 Hub；节点插件页会单独选择目标',
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
  settingsTarget: 'Current Runtime',
  settingsTargetHelp: 'Models, permissions, agents, conversation preferences, and configurable plugins belong to this Runtime; language and appearance belong to this browser; Hub nodes are global; Node plugins has its own target picker',
} satisfies Record<HubSettingsLocaleKey, string>
