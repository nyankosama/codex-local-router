# Codex Local Router

[English](README.md)

Codex Local Router 是面向 macOS Codex CLI 和 Codex App 的本地多模型路由工具。官方 GPT 始终走 ChatGPT 订阅后端；只有显式配置的自定义模型才会发送到对应第三方渠道。

Codex Local Router 是独立的非官方社区项目，与 OpenAI 不存在隶属、赞助或背书关系。

```text
Codex CLI / App
       │
       ▼
Codex Local Router（仅监听本机回环地址）
       ├─ 官方 GPT ────────> ChatGPT 订阅后端
       └─ 自定义模型 ID ───> 用户配置的第三方渠道
```

它保留 Codex 原有登录，隔离订阅凭证和第三方凭证，在本机保存可恢复的跨模型历史，并提供不依赖 Gateway 进程的订阅救援路径。版本化“配置空间”把 Provider、模型、路由与策略作为一个组合管理，但不复制账号、用户 MCP、Skills、Hooks、提示或历史。不修改 Codex 二进制。

官方订阅流量使用独立透明通道。只有显式配置的自定义模型，或必须恢复 Router 虚拟历史的请求，才进入模型 Engine。这样 `/models`、独立搜索和未来官方辅助接口可以继续兼容，同时不会把订阅身份开放给 `/v1`。

Router 不替用户开启或关闭搜索：Codex 继续使用正常搜索模式（默认 cached，或由用户选择 live）。官方 HTTP 与 WebSocket 会共同继承 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`WS_PROXY`、`WSS_PROXY` 并遵守 `NO_PROXY`。

新建第三方 `openai-gpt` App target 默认使用 `standard-tools`：通过标准 Responses 保留 Codex 核心工具、Plugin 策略允许的工具和用户 MCP，但不向 App 广告独立搜索。用户可以显式选择 `lite-search`，通过 Responses Lite 使用当前官方登录的订阅搜索或已配置的 Provider 搜索 endpoint；其缩减后的 Plugin/MCP 工具面会被明确披露，不会伪装成完整工具兼容。Router 不猜测，也不会在搜索来源间静默回退。Responses 内嵌 hosted search 仍是另一项独立能力。详见[第三方 GPT App 能力画像](docs/public/configuration.zh-CN.md#第三方-gpt-app-能力画像)。

第三方 GPT target 默认采用保守的 Plugin 白名单，以减少 Codex 客户端携带的大体积 Plugin 工具定义；Codex 核心工具和用户自行配置的 MCP 不受裁剪。非 GPT 与未声明模型家族的旧 target 默认仍原样转发。

## 支持范围

- macOS
- Node.js 22 或更高版本
- [兼容矩阵](docs/public/compatibility.md)列出的 Codex CLI / App 版本
- Responses 与 Chat Completions
- ChatGPT 订阅、OpenCode Go、ai.feei GPT 预设和通用 OpenAI 兼容渠道

v0.5.0 不声明 Linux、Windows 或未知供应商私有协议已受支持。

## 从 GitHub Release 安装

下载 `v0.5.0` Release 中的 `.tgz` 与 SHA-256 文件：

```bash
shasum -a 256 -c codex-local-router-0.5.0.tgz.sha256
npm install -g ./codex-local-router-0.5.0.tgz
codex-local-router --version
```

`codex-local-router` 是正式命令；旧的 `llm-auto-gateway` 继续作为兼容别名保留。

## 首次接入

默认预设通过 OpenCode Go 接入 DeepSeek V4.1 Flash。使用终端隐藏输入将渠道凭证保存到 macOS Keychain：

```bash
codex-local-router setup --credential-prompt
```

非交互安装可以通过 stdin 传入凭证；凭证不会进入配置正文或命令参数：

```bash
printf '%s' "$OPENCODE_GO_API_KEY" | codex-local-router setup --credential-stdin --yes
```

前台运行仍可使用环境变量凭证。受管 LaunchAgent 不会继承 Provider 凭证变量，只保留复现安装进程网络信任边界所需的代理变量和 `NODE_EXTRA_CA_CERTS`；`doctor` 会报告凭证引用并建议改用 Keychain。

`setup` 会发现 Codex home、配置、模型目录和凭证存储方式，创建受保护的 `official@1` 与首个 `default@1`，再启动可恢复的激活事务。若 Codex App 正在运行，不修改 Codex 配置和服务文件；一次性切换器只等待 App 正常退出，应用一次后退出，不强退也不自动重开。也可以显式恢复执行：

```bash
codex-local-router integration sync
```

完整配置组合可以创建、查看、切换、比较与回滚：

```bash
codex-local-router space list
codex-local-router space create work --from default --yes
codex-local-router space use work --yes
codex-local-router space diff default work
codex-local-router space rollback --yes
```

每次确认修改 Provider、模型、路由、Plugin、搜索、压缩或默认模型都会生成不可变 revision。用 `--space NAME` 修改非活动 Router 空间。若手工改动当前 `config.json` 的空间字段，系统报告 drift；需先审阅并用 `space capture` 接纳，不会在下次切换时静默覆盖。

日常诊断不调用模型：

```bash
codex-local-router status
codex-local-router doctor
codex-local-router model list
```

只有显式 `--live` 才执行会消耗额度的真实模型验收：

```bash
codex-local-router model probe --id deepseek --live
```

内置的 `feei/gpt-5.6-sol`、`feei/gpt-6-astra` 预设分别使用 `feei-gpt-5.6-sol`、`feei-gpt-6-astra` 作为 App 模型 ID，并声明保守的 272,000 token 配置窗口与第三方 GPT Plugin 策略。CLI 新建 target 默认写入 `standard-tools`；只有更重视独立搜索时才显式增加 `--app-profile lite-search`。既有显式 Responses Lite 配置保持传输行为；若旧配置明确关闭搜索，则保持未画像状态，不会被误标成 `lite-search`。API Key 必须由用户通过 Keychain 或 `FEEI_API_KEY` 单独提供，项目不包含任何凭证。具体配置见[配置说明](docs/public/configuration.zh-CN.md)。

## 恢复与历史

Codex 配置使用受管区块和三方比较事务。禁用时只撤销仍等于 Router 上次写入值的字段，保留用户后续增加的无关设置。

Gateway 不可用时，可在不连接 Gateway 的情况下恢复官方订阅直连：

```bash
codex-local-router rescue --subscription --yes
```

救援命令要求 Codex App 已关闭，直接恢复永久保留的 `official@1` 并停止 Router，不依赖正常切换协调器。

历史正文使用 AES-256-GCM 加密，密钥保存在 macOS Keychain。默认导出也加密并要求口令；只有显式指定才允许明文导出。

```bash
codex-local-router history export --thread THREAD_ID --output history.clr.json --passphrase-env HISTORY_PASSPHRASE
codex-local-router history inspect --thread THREAD_ID
```

更多信息见[配置空间指南](docs/public/configuration-spaces.zh-CN.md)、[CLI 说明](docs/public/cli.zh-CN.md)、[配置说明](docs/public/configuration.zh-CN.md)、[架构](docs/public/architecture.zh-CN.md)、[数据流向](docs/public/data-flow.zh-CN.md)、[兼容性](docs/public/compatibility.zh-CN.md)与[验收工具链](docs/public/acceptance.zh-CN.md)。

## 压缩边界

Codex 决定何时压缩，Router 按模型与渠道声明执行压缩并持续保留原文。目标能容纳时发送原文；只有目标明确拒绝上下文超限、尚未观察到任何输出且同一历史版本没有生成过迁移摘要时，才允许源模型生成一次有损摘要。请求体限制、认证、额度和网络错误不会触发摘要。

## 开发

```bash
npm ci
npm test
npm run audit:package
```

真实渠道验收与无凭证测试分开，必须显式执行。贡献与安全报告方式见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。

默认 L0-L2 与能力画像 E2E 门禁全部使用本地注入上游，不读取 Provider 凭证，也不访问外网。已安装服务与真实渠道 canary 必须显式传入 `--run`；详见[验收说明](docs/public/acceptance.zh-CN.md)。

## 许可证

MIT
