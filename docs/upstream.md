# 上游与第三方归属

[English](upstream.en.md) | 中文

DSH Hub 是由社区独立维护的项目，不是 DeepSeek 官方产品，也不代表 DeepSeek Harness 的发布计划或支持承诺。

## DeepSeek Harness

本项目通过公开的 Cordis 插件接口、Host API 和经过 Review 的 Web 构建快照与 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 集成。快照的精确上游提交、Hub 兼容提交、浏览器插件清单和可复现源码补丁保存在 `third_party/official-web`；Hub Release 不会在运行时从节点上传或执行前端 JavaScript。

仓库不再保存一份完整的 DeepSeek Harness 源码镜像。这样可以让 Hub 的 Review、Issue、Release 和安全边界集中在本项目真正维护的代码上，同时仍通过固定制品复用完整官方 Web 交互。升级快照时，维护者必须固定新的上游提交、重新生成源码补丁与清单，并运行 Hub 单元／组件、多节点、生产 CSP、桌面和 390px 手机浏览器测试，记录兼容性变化。

DeepSeek Harness 及其 npm 包采用 MIT License。其版权和商标归各自权利人所有。本项目的 MIT License 不授予使用 DeepSeek 名称、Logo 或其他商标来暗示官方背书的权利。

## 本项目代码

`@k1412/dsh-hub-*` 包、Hub Web 组合入口、安装器、部署文件和 Hub 文档由本项目维护，并按 [MIT License](../LICENSE)发布。依赖许可证及需要随发行保留的通知汇总在 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

发现缺失归属、许可证冲突或品牌混淆时，请提交 Issue；涉及安全影响时按 [SECURITY.md](../SECURITY.md)私下报告。
