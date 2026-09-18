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

第三方标准 Responses target 可以显式把同一订阅搜索暴露为有界普通函数。Gateway 只向固定 OpenAI 目的地执行内部调用，在 App 对话中隐藏内部工具生命周期，并立即流式转发客户端可见文本和普通工具。单轮可多次搜索，上限由 `webSearch.maxRounds` 控制（默认 3，范围 1-10）；超限返回 `tool_loop_limit`。用户自行配置的 MCP 搜索仍由 Codex 持有并执行。详见[通用搜索](docs/public/universal-search.zh-CN.md)。

新建 App-enabled 第三方模型在具备 Responses、工具调用和 freeform 工具能力且 preset 已通过 Provider 准出时，默认采用版本化 `codex-general-v1` 模板：简短中性指令、标准 Responses、Code mode、多代理 v2 元数据和标准 Plugin 白名单。不兼容目标使用 `legacy`；当前 OpenCode Go DeepSeek preset 明确只允许 legacy，已有模型也不会在加载时迁移。官方 GPT 指令快照、Lite、搜索和缓存亲和仍为可选能力。详见[第三方模型模板](docs/public/third-party-templates.zh-CN.md)。

Plugin 白名单只裁剪结构化 Plugin 定义；Codex 核心工具和用户 MCP 保留，嵌入 `exec` 说明的 schema 仍不透明。这是上下文控制策略，不是安全沙箱，也不保证 Code mode 必然减少字节。

兼容的第三方 Responses Provider 还可以显式启用匿名缓存亲和：适用于 `openai-gpt`，或已显式物化通用模板的非 GPT target；既有 Provider 不会因升级被自动开启。Router 会把 Codex 的缓存/会话身份替换为按 Provider、模型与谱系隔离的 HMAC 键。账号池中转站可以把该匿名键用于稳定选择账号或 Cache Shard；只有 Gateway 侧亲和并不能保证缓存命中。详见[缓存亲和契约](docs/public/provider-cache-affinity.zh-CN.md)。

## 支持范围

- macOS
- Node.js 22 或更高版本
- [兼容矩阵](docs/public/compatibility.md)列出的 Codex CLI / App 版本
- Responses 与 Chat Completions
- ChatGPT 订阅、OpenCode Go、ai.feei GPT 预设、BigModel GLM 5.3/Flash 和通用 OpenAI 兼容渠道
- 用户自行持有的 MCP 工具，以及面向已准出第三方标准 Responses target 的显式 OpenAI 订阅搜索桥接

v0.5.6 不声明 Linux、Windows 或未知供应商私有协议已受支持。

## 从 GitHub Release 安装

下载 `v0.5.6` Release 中的 `.tgz` 与 SHA-256 文件：

```bash
shasum -a 256 -c codex-local-router-0.5.6.tgz.sha256
npm install -g ./codex-local-router-0.5.6.tgz
codex-local-router --version
```

`codex-local-router` 是正式命令；旧的 `llm-auto-gateway` 继续作为兼容别名保留。

## 首次接入

全新 setup 不再默认任何个人 Provider，必须显式选择 preset。例如，通过终端隐藏输入将 OpenCode Go 凭证保存到 macOS Keychain：

```bash
codex-local-router setup --preset opencode-go/deepseek-v4.1-flash --credential-prompt
```

非交互安装可以通过 stdin 传入凭证；凭证不会进入配置正文或命令参数：

```bash
printf '%s' "$OPENCODE_GO_API_KEY" | codex-local-router setup \
  --preset opencode-go/deepseek-v4.1-flash --credential-stdin --yes
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

符合条件的第三方 GPT target 可固定官方 catalog 基础指令。标准 Responses 保持客户端交付；Responses Lite 需要显式开启 `gateway-lite`，且快照不能含运行时变量。已有 target 不会自动迁移。详见[基础指令快照](docs/public/instruction-snapshots.zh-CN.md)。

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
codex-local-router history recover --thread THREAD_ID --json
```

同一已验证账号下，直接 fork 可以继承父线程中密文完全匹配且含原文的可移植 checkpoint。存量 rollout 只有在完整来源链能够无损重建时才可预览并显式恢复；应用要求 App 已退出且 Gateway 空闲。详见 [Fork 与压缩历史恢复](docs/public/compaction-recovery.zh-CN.md)。

跨 Provider 续聊时，Provider 私有的动态工具搜索控制项会转换成不含 schema 的固定历史标记；已完成的函数/custom-tool 调用与结果保持顺序，原始加密归档不改写。详见[工具搜索历史迁移](docs/public/tool-search-history-migration.zh-CN.md)。

更多信息见[配置空间指南](docs/public/configuration-spaces.zh-CN.md)、[CLI 说明](docs/public/cli.zh-CN.md)、[配置说明](docs/public/configuration.zh-CN.md)、[第三方模型通用搜索](docs/public/universal-search.zh-CN.md)、[架构](docs/public/architecture.zh-CN.md)、[数据流向](docs/public/data-flow.zh-CN.md)、[兼容性](docs/public/compatibility.zh-CN.md)、[开源维护边界](docs/public/open-source-maintenance-boundaries.zh-CN.md)与[验收工具链](docs/public/acceptance.zh-CN.md)。

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
