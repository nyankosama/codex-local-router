# 兼容性与准出

[English](compatibility.md)

本矩阵把“可以配置”和“已经取得证据”分开。存在 preset 或可填写 endpoint，不构成完整支持承诺；真实结论只属于精确命名的 Provider、模型与路径。

| 组件或路径 | 可用性 | 确定性覆盖 | 最近运行时真实证据 | App UI |
|---|---|---|---|---|
| macOS / Node.js 22 | 支持 | 默认完整测试 | Release 打包验证 | 本机安装后人工确认 |
| Linux / Windows | 不支持 | 无 | 无 | 无 |
| ChatGPT 订阅 HTTP/WS 与辅助接口 | 内置 | 固定目的地 Relay、身份、历史和搜索 | v0.5.6 官方 cached/live 有界验收 | 每个已安装 App 单独确认 |
| OpenCode Go DeepSeek preset | 内置 preset；legacy 路径 | legacy Responses 适配 | 当前 Release 无真实用例 | 不声明 |
| ai.feei GPT 5.6 Sol | 内置 preset | Responses、GPT 策略、搜索／缓存／指令路径 | v0.5.6 订阅桥接与客户端 MCP 用例 | 每个已安装 App 单独确认 |
| ai.feei GPT 6 Astra | 内置 preset | 同一声明协议族 | 当前 Release 无真实用例 | 当前 Release 不声明 |
| BigModel GLM 5.3 Flash | 支持公开配置 | 标准 Responses、工具、续接与桥接 | v0.5.6 订阅搜索桥接 | 每个已安装 App 单独确认 |
| BigModel GLM 5.3 main | 支持公开配置 | 通用标准 Responses 覆盖 | 当前无模型专项真实用例 | 不声明 |
| 通用 OpenAI-compatible Responses | 支持公开配置 | 通用适配器与协议夹具 | 需要 Provider 专项 probe | 按 Provider 单独确认 |
| 通用 OpenAI-compatible Chat Completions | 支持公开配置 | JSON function-tool 适配 | 需要 Provider 专项 probe | 按 Provider 单独确认 |

精确驱动版本、二进制哈希、调用预算、性能测量和历史失败只保存在对应[冻结证据](evidence/README.zh-CN.md)或 GitHub Release，不进入长期有效的兼容性矩阵。

## 状态术语

- **Preset available**：CLI 内置了命名 preset。
- **Configuration supported**：公开 Schema 与 CLI 能表达该渠道。
- **Deterministic tested**：无凭证本地夹具覆盖声明的 Gateway 行为。
- **Live release-qualified**：指定 Release 的有界真实渠道用例通过。
- **App UI confirmed**：用户安装后另行确认 App 实际显示与交互。

这些状态不能相互推导。渠道健康度也与 Gateway 责任分离：失败可以归类为 `EXTERNAL_DEGRADED`、`GATEWAY_DEFECT` 或 `UNVERIFIED`，但只有完整正向证据才能形成 live-ready 结论。

## 稳定兼容边界

- 运行时配置保持 Schema 3。
- 配置空间保持 Schema 1。
- 集成状态保持 Schema 4。
- 官方订阅走固定目的地透明 Relay；本地 `/v1` 永远不能借用订阅身份。
- 标准 Responses 是第三方 App 的主要接入面；Chat Completions 不能承载 namespace 或 freeform 工具。
- 既有配置不会在加载时自动获得模板、Lite、搜索、缓存亲和或指令快照。
- 用户 MCP 继续由客户端持有，Router 不复制配置和凭证。

## 工具与搜索限制

第三方 Provider 不能假设官方后端存在服务端工具处理。通用 Plugin 策略只缩减已确认的结构化 Plugin 定义；核心工具、允许 Plugin、用户 MCP 和嵌在 `exec` 说明中的不透明 schema 仍可能占用上下文。该策略用于上下文控制，不是安全沙箱，也不承诺固定 token 降幅。

`standard-tool` 订阅搜索桥接与模型家族无关，但仍要求标准 Responses function call 和结果续接。搜索只在固定 OpenAI 目的地使用订阅身份，模型生成只使用 Provider 凭证。Provider 原生 hosted search、Responses Lite 独立搜索和用户 MCP 搜索继续是不同路径，不存在隐藏回退。详见[通用搜索](universal-search.zh-CN.md)。

## 依赖新组合前

1. 在 [Provider 接入](providers.zh-CN.md)中核对 Provider／模型声明。
2. 先运行 `status`、`doctor` 和非 live 的 `model list`。
3. 只有接受额度消耗时才执行显式 live probe。
4. 区分模型菜单可见、app-server 完成与 App UI 人工确认。
5. Codex 客户端、协议、Provider 或工具集合显著变化后重新验收。
