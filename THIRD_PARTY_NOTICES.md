# 第三方软件与上游声明 / Third-Party Notices

DSH Hub 是独立维护的社区项目，不是 DeepSeek 官方产品。本文件不会改变任何组件原有的许可证条款；精确安装版本以 `pnpm-lock.yaml` 为准。

DSH Hub is an independently maintained community project, not an official DeepSeek product. This notice does not alter any component's license terms. `pnpm-lock.yaml` is authoritative for exact installed versions.

## DeepSeek Harness 与官方 Web 快照

本项目复用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Cordis／Host 接口及其浏览器交互层。DeepSeek Harness 按 MIT License 发布，版权归 DeepSeek 及各贡献者所有。

仓库中的 `third_party/official-web` 是经测试的浏览器构建快照，不是完整上游源码镜像。`snapshot.json` 固定上游提交和 Hub 兼容提交，`hub-compat.patch` 保存相对于该上游提交的可复现源码修改，`dist` 保存运行时浏览器制品。Hub 不会执行节点临时上传的 JavaScript。

This project reuses the Cordis/Host interfaces and browser interaction layer from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). DeepSeek Harness is distributed under the MIT License; copyright remains with DeepSeek and its contributors.

`third_party/official-web` is a tested browser build snapshot, not a complete upstream source mirror. `snapshot.json` pins the upstream and Hub compatibility commits, `hub-compat.patch` records the reproducible source changes relative to that upstream commit, and `dist` contains the runtime browser artifacts. Hub never executes JavaScript uploaded temporarily by a node.

The browser snapshot includes MIT, BSD, Apache-2.0, and similarly permissive frontend dependencies used by the upstream Web build, including React, React DOM, KaTeX, Shiki, Zustand, Immer, and their transitive closures. Their notices and license files remain available from their package distributions and the pinned upstream source tree.

## Hub 运行时直接依赖 / Direct Hub runtime dependencies

| Package | Role | Declared license |
| --- | --- | --- |
| `@deepseek-ai/cordis` | DSH plugin and service runtime | MIT |
| `@deepseek-ai/schemastery` | Connector configuration schema | MIT |
| `@deepseek-ai/dsh-*` | Public DSH Host, client, session, invariant, and atomic-write contracts | MIT |
| `jose` | Cloudflare Access JWT verification | MIT |
| `node-pty` | Explicit operator rescue terminal | MIT |
| `react`, `react-dom` | Hub client extension rendering | MIT |
| `ws` | Hub and Node Agent WebSocket transport | MIT |
| `zod` | Wire and durable-state validation | MIT |

`node-pty@1.1.0` carries the local portability patch recorded in [`patches/node-pty@1.1.0.patch`](patches/node-pty@1.1.0.patch). The complete npm transitive closure and integrity values are recorded in [`pnpm-lock.yaml`](pnpm-lock.yaml).

## 仅开发使用 / Development-only tooling

TypeScript, Vitest, Testing Library, Playwright, esbuild, tsdown, oxlint, lightningcss, jsdom, js-yaml, and their transitive dependencies are used to build, test, lint, package, or document the project. They are not independently loaded by the published Hub server at runtime. License metadata can be audited from the immutable lockfile with:

```bash
pnpm licenses list --long
```

DeepSeek names, logos, and other marks belong to their respective owners. The MIT License does not grant permission to use them to imply official endorsement.
