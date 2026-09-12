# Codex Local Router

[English](README.md)

Codex Local Router 是面向 macOS Codex CLI 和 Codex App 的本地多模型路由工具。官方 GPT 始终走 ChatGPT 订阅后端；只有显式配置的自定义模型才会发送到对应第三方渠道。

```text
Codex CLI / App
       │
       ▼
Codex Local Router（仅监听本机回环地址）
       ├─ 官方 GPT ────────> ChatGPT 订阅后端
       └─ 自定义模型 ID ───> 用户配置的第三方渠道
```

它保留 Codex 原有登录，隔离订阅凭证和第三方凭证，在本机保存可恢复的跨模型历史，并提供不依赖 Gateway 进程的订阅救援路径。不修改 Codex 二进制。

## 支持范围

- macOS
- Node.js 22 或更高版本
- [兼容矩阵](docs/public/compatibility.md)列出的 Codex CLI / App 版本
- Responses 与 Chat Completions
- ChatGPT 订阅、OpenCode Go 和通用 OpenAI 兼容渠道

v0.2.0 不声明 Linux、Windows 或未知供应商私有协议已受支持。

## 从 GitHub Release 安装

下载 `v0.2.0` Release 中的 `.tgz` 与 SHA-256 文件：

```bash
shasum -a 256 -c codex-local-router-0.2.0.tgz.sha256
npm install -g ./codex-local-router-0.2.0.tgz
llm-auto-gateway --version
```

v0.2.0 继续保留 `llm-auto-gateway` 命令，避免破坏已有本机脚本。

## 首次接入

默认预设通过 OpenCode Go 接入 DeepSeek V4.1 Flash。使用终端隐藏输入将渠道凭证保存到 macOS Keychain：

```bash
llm-auto-gateway setup --credential-prompt
```

非交互安装可以通过 stdin 传入凭证；凭证不会进入配置正文或命令参数：

```bash
printf '%s' "$OPENCODE_GO_API_KEY" | llm-auto-gateway setup --credential-stdin --yes
```

前台运行仍可使用环境变量凭证。受管 LaunchAgent 不继承 Shell 环境变量；`doctor` 会报告这一问题并建议改用 Keychain。

`setup` 会发现 Codex home、配置、模型目录和凭证存储方式；展示差异；写入可恢复事务；安装 LaunchAgent；分别报告配置、服务、目录和 App 加载状态。若 Codex App 正在运行，只准备接入文件并标记待应用。正常退出 App 后运行：

```bash
llm-auto-gateway integration sync
```

日常诊断不调用模型：

```bash
llm-auto-gateway status
llm-auto-gateway doctor
llm-auto-gateway model list
```

只有显式 `--live` 才执行会消耗额度的真实模型验收：

```bash
llm-auto-gateway model probe --id deepseek --live
```

## 恢复与历史

Codex 配置使用受管区块和三方比较事务。禁用时只撤销仍等于 Router 上次写入值的字段，保留用户后续增加的无关设置。

Gateway 不可用时，可在不连接 Gateway 的情况下恢复官方订阅直连：

```bash
llm-auto-gateway rescue --subscription
```

历史正文使用 AES-256-GCM 加密，密钥保存在 macOS Keychain。默认导出也加密并要求口令；只有显式指定才允许明文导出。

```bash
llm-auto-gateway history export --thread THREAD_ID --output history.clr.json --passphrase-env HISTORY_PASSPHRASE
llm-auto-gateway history inspect --thread THREAD_ID
```

更多信息见 [CLI 说明](docs/public/cli.md)、[配置说明](docs/public/configuration.md)、[架构](docs/public/architecture.md)与[数据流向](docs/public/data-flow.md)。

## 压缩边界

Codex 决定何时压缩，Router 按模型与渠道声明执行压缩并持续保留原文。目标能容纳时发送原文；只有目标明确拒绝上下文超限、尚未观察到任何输出且同一历史版本没有生成过迁移摘要时，才允许源模型生成一次有损摘要。请求体限制、认证、额度和网络错误不会触发摘要。

## 开发

```bash
npm ci
npm test
npm run audit:package
```

真实渠道验收与无凭证测试分开，必须显式执行。贡献与安全报告方式见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。

## 许可证

MIT
