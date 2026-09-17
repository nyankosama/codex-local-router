# 第三方模型模板

`codex-general-v1` 是新建 App-enabled 第三方模型的默认模板。它要求 Responses、工具调用和 freeform 工具能力，并把以下字段物化进 target 所在的不可变配置空间 revision：

- 简短、与 Provider 无关的 `codex-generic-v1` 基础指令；
- 标准 Responses，独立搜索默认关闭；
- `code_mode_only` 与直接配置的多代理 v2 能力元数据；
- 标准 Plugin 白名单（`github`、`figma`、`sites`、`connected_documents`）。

模板不改上下文窗口、图片能力、思考档位、压缩、凭证、空间默认模型或 Codex 当前选模。是否启用代理、代理权限、显式角色／模型／effort 和并发仍以 Codex 配置为准。加载或升级旧配置不会重新套用模板。

```bash
codex-local-router space set-third-party-template codex-general-v1 --space default
codex-local-router model apply-template --ids compatible-target \
  --template codex-general-v1 --space default
```

Chat Completions 或缺少 freeform 工具能力的 target 必须在创建时显式选择 `--template legacy`；Router 不会静默降级。对已有 target 应用 `legacy` 是无操作，不会删除用户设置。

Provider 的真实准出范围可能比 preset 中的静态能力声明更窄。当前 `opencode-go/deepseek-v4.1-flash` preset 只允许 `legacy`：既有普通路径继续可用，但 `codex-general-v1`、直接 Code mode 和直接多代理元数据都会 fail closed。默认 setup 或新建该 preset 时会为这个 target 选择 `legacy`，不改变空间对其他新模型的通用模板默认值。只有真实 Codex Responses/freeform 报文被 Provider 接受后才能重新准出；仅看到模型列表不足以证明兼容。

基础指令来源互斥。新通用 target 使用内置的中性指令；也可以显式选择 `--instructions-template codex-generic-v1`、`--instructions-file FILE`，或原有的 `--instructions-from OFFICIAL_MODEL`。官方快照是可选能力，不按 Provider 名称推断。`gateway-lite` 仍只是受管指令的显式 Lite 交付适配。

直接多代理配置使用 `--multi-agent-version v1|v2|client-default`。`client-default` 只删除 target 元数据，不覆盖用户全局代理开关。需要精确官方模型元数据时仍可使用官方快照命令。

Code mode 只能裁剪结构化 Plugin 定义，已嵌入 `exec` 说明的工具定义仍然不透明，因此诊断会显示 `structured-only; embedded-exec-opaque`。启用前必须用相同客户端和工具清单比较：首请求增量不得超过 `max(8 KiB, 对照的 10%)`，续接过程中工具定义不得累积。

兼容 Harness 使用当前 App 内置 Codex 二进制、合成输入和本地模拟 Provider。真实渠道验收是另一个有调用预算的显式门禁；App-server 证据不能替代 App UI 签核。
