# DSH Hub 文档

[English](index.md) | 中文

DSH Hub 为多个 DeepSeek Harness 节点提供一个经过认证的浏览器工作台，同时保持每个节点对其 Runtime、会话、工作区、插件和凭据的权威所有权。

## 指南

- [部署](deployment.md)使用 Docker Compose 安装 Hub 并注册 DSH 节点。
- [节点服务](node-services.md)介绍如何通过 Linux、macOS 或 Windows 的服务管理机制运行 Node Agent。
- [运维](operations.md)介绍注册、吊销、备份、恢复、版本升级和故障恢复。

## 参考

- [架构](architecture.md)定义组件所有权、传输方式、持久化、命令交付和本地客户端共存机制。
- [安全](security.md)定义信任边界、Cloudflare Access 要求、节点权限、机密处理和部署加固。

## 支持的拓扑

一个 Hub 可以控制任意数量的独立注册 Node Agent。一个节点可以公开一个或多个 DSH Runtime，每个 Runtime 在接入 Hub 时仍可继续服务本地 Web 和桌面客户端。Hub 不需要节点开放入站端口、SSH 隧道或 DSH Web 路由。
