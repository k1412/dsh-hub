# Agent Note: Hub 设置原地切换 Runtime

Status: implemented

[English](2026-08-18-hub-settings-runtime-switch-in-place.md) | 中文

## 问题

Hub 设置可以读取和写入任意已注册 Runtime 上由 Host 持久化的值。Runtime 选择器原本通过 `location.assign` 更改 URL 所属目标，这会销毁并重新构建完整的官方 Web 应用。一次普通选择会因此关闭设置对话框、重置设置导航状态并造成页面闪烁，尽管实际变化只有后续 Host 请求的所有者。

只更改 URL 仍不充分。设置 Scope 可能还在等待上一个所有者的读取响应；该响应可能在选择新 Runtime 后才发布，导致界面在新目标下显示旧值，或把后续编辑建立在错误值上。

## 决策

设置内所有 Runtime 选择器都会持久化所选所有者，并通过 `history.replaceState` 更新 `nodeId` 与 `runtimeId`，随后调用 `SettingsScopeBinder.refreshAll()`。每个活动的 Host 持久设置 Scope 会立即针对新所有者发起读取并递增代次，因此上一个所有者的延迟响应无法发布。

官方设置外壳和导航保持挂载。新会话页面的 Runtime 选择使用相同的持久化与 Scope 刷新路径；选择已有 Fleet Workspace 时仍同步其编码所有者，但不会过滤汇总后的项目与会话列表。

## 考虑过的替代方案

**每次选择 Runtime 后重新加载页面。** 重新加载会自然丢弃旧请求，但也会丢弃无关的官方 Web 状态，并把一个设置控件变成整站导航。

**只更新 URL，不刷新设置 Scope。** 后续调用会使用新所有者，但已经挂载的 Scope 仍可能显示从上一个 Runtime 读取的值，并可能在下一次普通失效前接受写入。

**只重新挂载设置对话框。** 这种方式不会重建会话页面，但仍会丢失当前设置分区，并重复实现 Scope 代次隔离已经提供的生命周期行为。

## 结果

在设置内切换节点或 Runtime 会保留对话框、当前分区、滚动位置和周围的官方 Web 应用。全部活动的 Host 持久设置 Scope 都从所选所有者重新读取，过期响应会被忽略。所选所有者仍只存在于当前浏览器标签页 URL 和本地存储中；切换它不会过滤或修改机群级项目与会话索引。

组件测试会锁定可见目标、URL 参数、默认 Runtime 状态，以及每次用户选择只触发一次 Scope 刷新。Hub 类型检查、浏览器构建、官方 Web 回归通道和多平台 Hub CI 会验证组装后的注入路径。
