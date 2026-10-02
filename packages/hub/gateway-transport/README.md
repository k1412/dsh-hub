# 原生 Gateway 传输

[English](README.en.md)

此包在一条已认证的节点主动出站 WebSocket 上传递原生 `Request`、`Response` 和 mux 文本。节点与 Runtime 的归属、认证、心跳及重连由调用方负责。每个 `GatewayTunnel` 仅使用构造时传入的连接；断线不重试请求。

服务端使用 `new GatewayTunnel(ws)`、`fetch(request)`、`openMux(sendToBrowser, signal?)` 和 `close()`。`openMux` 返回 `send(text)` 与 `close()`。节点使用 `serveSurface(ws, surface)`，其中 `surface` 实现 `handle(request)` 和 `openMux(send, signal)`；节点 mux 返回 `receive(text)` 与 `close()`。`serveSurface` 返回带 `close()` 和 `health` 的句柄。`GatewayTunnel.health` 提供连接状态、请求数和 mux 数，`isOpen` 提供连接状态。

传输不解释 URL 路径、查询参数或 mux 文本。HTTP 方法、状态、响应头及二进制正文通过原生 Web API 传递；HEAD 和无正文状态不会创建正文流。请求取消会取消节点请求和流；读取响应正文时调用 `cancel()` 也会释放该请求。

## 边界

- 协议版本为 1。JSON 控制帧携带版本、通道编号和操作；正文使用二进制帧，格式为 1 字节版本、4 字节大端通道编号及最多 32768 字节正文。
- 每个正文方向最多允许 32768 字节未消费数据。接收端读取时授予字节额度；发送端先等待额度，再读取源流。源流自行产生的单个块不由此包分配或限制。
- 默认最多 128 个请求与 mux 通道，控制帧最多 262144 字节，WebSocket 待发送缓冲上限为 8 MiB。超限或无效协议会失败并释放资源。调用方应给两个 WebSocket 端点设置 `maxPayload: 262144`，以在帧组装阶段限制内存；建议关闭压缩。
- `requestTimeoutMs` 默认 120000，覆盖整个请求和响应流；长时间流可由调用方配置更大的有限值。mux 生命周期由信号、显式关闭或连接断开控制。
- `GatewayTransportError.code` 为 `DISCONNECTED`、`TIMEOUT`、`PROTOCOL`、`REMOTE` 或 `CAPACITY`；`status` 对超时为 504，其他传输错误为 502。浏览器主动取消保留其 abort 原因。响应头已返回后的错误通过正文流报告。

真实本地 WebSocket 测试覆盖大二进制上传下载、背压、双节点和多 mux 隔离、取消、断线、超时、无正文响应及协议错误清理。
