# 安全策略

中文 | [English](SECURITY.en.md)

DSH Hub 的操作员拥有已注册节点账户的全部权限。安全问题可能影响终端命令、工作区文件、会话、插件更新与快照恢复，请不要在公开 Issue 中披露可利用细节。

请通过 GitHub 仓库的 **Security → Report a vulnerability** 私下报告，并包含受影响版本、前置条件、复现步骤、影响和建议修复。不要附带真实 Token、私钥、注册码或用户数据；如必须提供，请先索取安全传输方式。

我们优先处理认证绕过、Origin Secret 绕过、跨节点路由、签名或重放、命令越权、节点上传脚本执行、可靠队列串线、更新／回退制品校验和备份泄露。修复发布前请保密。

仅支持仍在 GitHub Releases 中标记为当前稳定版的版本。安全部署必须使用受身份代理保护的 HTTPS 入口、不可公开直连的 Origin、精确操作员白名单、每节点独立 Service Token 和非特权节点账户；详见[安全模型](docs/hub/security.zh.md)。
