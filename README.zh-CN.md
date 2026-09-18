# Codex Local Router

[English](README.md)

[![CI](https://github.com/nyankosama/codex-local-router/actions/workflows/ci.yml/badge.svg)](https://github.com/nyankosama/codex-local-router/actions/workflows/ci.yml)
[![最新版本](https://img.shields.io/github/v/release/nyankosama/codex-local-router)](https://github.com/nyankosama/codex-local-router/releases/latest)
[![许可证：MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Codex Local Router 让 macOS 上的 Codex CLI 和 Codex App 同时使用 ChatGPT 订阅模型与用户显式配置的第三方模型。官方模型始终走 ChatGPT 订阅后端；自定义模型 ID 只会发送到对应的第三方 Provider。

这是独立的非官方社区项目，与 OpenAI 不存在隶属、赞助或背书关系。

```text
Codex CLI / App
       │
       ▼
Codex Local Router（仅监听本机回环地址）
       ├─ 官方模型 ───> ChatGPT 订阅后端
       └─ 自定义模型 ─> 用户配置的第三方 Provider
```

Router 不修改 Codex 二进制。它隔离订阅凭证和 Provider 凭证，用版本化“配置空间”管理完整路由组合，并永久保留一条恢复原始官方订阅配置的救援路径。

## 支持边界

- macOS 与 Node.js 22 或更高版本
- Codex CLI 和 Codex App
- ChatGPT 订阅透明转发
- OpenAI-compatible Responses Provider
- 通过兼容适配器使用 Chat Completions，受 JSON function tool 能力限制
- 用户自行持有的 MCP，以及面向已准出标准 Responses target 的显式订阅搜索桥接

当前不声明支持 Linux、Windows、未知供应商私有协议或所有 Provider／模型组合。存在内置 preset 或可以填写 endpoint，不等于已经完成真实 Release 验收；详见[兼容性与准出矩阵](docs/public/compatibility.zh-CN.md)。

## 安装

从[最新 GitHub Release](https://github.com/nyankosama/codex-local-router/releases/latest)下载 `.tgz` 和对应的 `.sha256` 文件。把下面的 `VERSION` 替换为实际下载版本：

```bash
shasum -a 256 -c codex-local-router-VERSION.tgz.sha256
npm install -g ./codex-local-router-VERSION.tgz
codex-local-router --version
```

`codex-local-router` 是正式命令；`llm-auto-gateway` 继续作为完全等价的兼容别名。

## 添加 Provider

全新 setup 不默认任何个人 Provider。选择一个可用 preset，并通过隐藏输入把凭证保存到 Keychain：

```bash
codex-local-router setup --preset PROVIDER/MODEL --credential-prompt
```

实际 preset 名称见 [Provider 指南](docs/public/providers.zh-CN.md)。接入通用 OpenAI-compatible endpoint 时，应提供显式配置而不是选择 preset。凭证也可以从 stdin 读取，不会进入命令参数或配置 JSON。

setup 会创建受保护的 `official@1` 和第一个 Router 空间。如果 Codex App 正在运行，变更只会进入 pending，直到 App 正常退出；Router 不会强退或自动重开 App。

## 验证与切换

以下命令不会调用模型：

```bash
codex-local-router status
codex-local-router doctor
codex-local-router model list
```

配置空间把 Provider、模型、路由、搜索、Plugin、压缩和默认模型作为一个组合管理：

```bash
codex-local-router space list
codex-local-router space create work --from default --yes
codex-local-router space use work --yes
codex-local-router space diff default work
codex-local-router space rollback --yes
```

只有显式 live probe 才会消耗 Provider 额度：

```bash
codex-local-router model probe --id TARGET_ID --live
```

## 恢复官方订阅

如果 Router 不可用，退出 Codex App 后可在不连接 Gateway 的情况下恢复永久保留的官方配置：

```bash
codex-local-router rescue --subscription --yes
```

该命令停止 Router 服务并恢复 `official@1`，不会删除 Provider 配置、加密历史、MCP、Skills、Hooks、提示或会话。

## 数据与安全边界

- 官方订阅凭证只发送到固定 ChatGPT 后端。
- Provider Key 只发送到对应 Provider origin。
- `/v1` 请求不能借用订阅身份。
- 服务只监听回环地址，原始本地 API 另有 Token 保护。
- Router 历史使用 AES-256-GCM 加密，密钥保存在 macOS Keychain。
- 用户 MCP 配置和凭证继续由 Codex 持有，不复制进配置空间。
- 发送到第三方模型的会话内容受该 Provider 自身数据政策约束。

完整边界见[架构](docs/public/architecture.zh-CN.md)、[数据流向](docs/public/data-flow.zh-CN.md)和 [SECURITY.md](SECURITY.md)。

## 文档

从[文档总入口](docs/public/README.zh-CN.md)开始。它会区分用户指南、Provider／集成参考、维护者材料和冻结历史证据。

常用入口：

- [Provider 接入与准出状态](docs/public/providers.zh-CN.md)
- [配置空间](docs/public/configuration-spaces.zh-CN.md)
- [第三方模型搜索](docs/public/universal-search.zh-CN.md)
- [CLI 参考](docs/public/cli.zh-CN.md)
- [故障恢复](docs/public/compaction-recovery.zh-CN.md)
- [兼容性与准出](docs/public/compatibility.zh-CN.md)

## 开发

```bash
npm ci
npm test
npm run audit:package
```

无凭证确定性测试与需要显式授权的真实渠道验收严格分离。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，Release 准出原则见[验收政策](docs/public/acceptance.zh-CN.md)。

## 许可证

MIT
