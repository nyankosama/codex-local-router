# 官方基础指令快照

Codex Local Router 可以显式把对应官方 catalog 的指令字段固定到第三方 Responses target 的不可变配置空间版本中。快照代表采集时客户端可见的基础指令；它不承诺 Provider 服务端处理、完整运行时上下文或回答文风与官方订阅完全一致。

## 交付模式

`app.instructionDelivery` 支持两种模式：

- `client`（缺省）：Codex 从生成的 catalog 读取快照。标准 Responses 使用此路径，Router 不向请求追加指令。
- `gateway-lite`：仅对用户显式开启、具有有效受管指令来源的第三方 App 可见 Responses Lite target 生效；模型家族不再作为准入条件。Router 把固定正文作为一条 developer 文本输入，插在前置 `additional_tools` 之后、普通输入消息之前。

官方订阅保持透明转发；`/v1`、非 Lite 和内部摘要均不改写。已有 target 不自动迁移。

```sh
# 预览单个 target。
codex-local-router model edit --id vendor-sol \
  --instructions-from gpt-5.6-sol \
  --instruction-delivery gateway-lite

# 在一个空间版本中原子同步并启用两款 ai.feei 模型。
codex-local-router model sync-instructions \
  --ids feei-sol,feei-astra --space default \
  --instruction-delivery gateway-lite --json

# 审阅预览并关闭 Codex App 后再确认应用。
codex-local-router model sync-instructions \
  --ids feei-sol,feei-astra --space default \
  --instruction-delivery gateway-lite --yes --json

# 关闭继承交付；只删除继承管理的正文。
codex-local-router model edit --id vendor-sol --instructions-from none
```

`gateway-lite` 必须绑定有效快照。它优先使用非空 `instructions_template`，否则使用 `base_instructions`。`instructions_variables` 非空时拒绝开启，因为 Router 不猜测运行时 personality。`persistent_instructions` 仍会版本化保存，但不会无条件注入。

每个目标视图都从未修改的请求生成，注入内容不写回原始归档或历史。重复适配和工具续接保持幂等：完全一致的现有载体直接复用；不一致的顶层基础指令返回 `instruction_delivery_conflict`，不重试、不回退。普通 developer 消息原样保留，不按正文猜测来源。指令字节在上下文预算和压缩决策之前计入。日志仅包含模式、来源、哈希、大小和结果类型。

## 快照生命周期与权威边界

官方快照是可选能力。新建且能力满足的 target 默认使用通用模板，只有显式传入 `--instructions-from` 才采集官方来源；普通加载、preset 展开和服务启动都不会采集或刷新。来源必须精确匹配，不借用其他模型。

`app.instructionSource` 区分 `official-snapshot`、`builtin-template`、`custom` 和 `none`。正文仍只保存在原有指令字段中；开源仓库和安装包不内置官方正文。官方快照只继承已声明的基础指令字段，不继承审批、工具、多代理、token budget 或传输能力。

快照随不可变配置空间版本保存。catalog 更新只提示可同步；用户显式同步后才生成版本，正文相同时保持幂等。激活历史版本使用当时保存的快照。批量 target 全部解析成功后才提交一次。上游模型变化会使旧映射失效；不覆盖非受管自定义指令，正文与来源元数据不一致时校验失败。

`model list/probe`、`status`、`doctor` 显示来源、交付模式、哈希、状态和更新提示，不打印指令正文；空间查看和 diff 只展示字段名、字节数和哈希。实际本地配置包含正文，仍需保持私密。Gateway／配置空间／integration Schema 保持 3／1／4。

开启 `gateway-lite` 时，如果当前受管 Codex 配置或选中 profile 可观察到 `model_instructions_file`，则拒绝启用。`AGENTS.md`、用户提示和附加 developer 指令不属于冲突。不会到达 Router 的临时命令行覆盖无法检测；此类场景应使用 `client` 交付。

同一活动 Router 空间只更新指令且空间默认模型不变时，切换事务会分别保留 Codex 顶层当前 `model` 的存在性／值，以及空间默认模型。正常显式切换到另一空间仍沿用目标空间原有的默认模型语义。

## 兼容性证据

`node scripts/e2e/instruction-inheritance.mjs` 是纯 loopback 兼容门禁：使用合成 catalog／登录、临时 HOME/CODEX_HOME/XDG、随机端口和当前 App 内置 Codex；外部模型调用为零，也不读取个人指令或历史。

在 Codex `0.154.0-alpha.6.2`（二进制 SHA-256 `a1d2f191e70023ed7afd619bc70530f26067a085926e03bae50cf5c0f8298bcf`）上，CLI 和 app-server 均得到：

| catalog／Provider 路径 | 标准 Responses | Responses Lite |
|---|---|---|
| 官方模型条目＋`openai` Provider | 模板发送一次 | 客户端 wire 未发送模板（对照观察） |
| 原始模型 ID＋标准自定义 Provider | 模板发送一次 | 模板发送一次 |
| Gateway 别名＋固定快照 | 模板发送一次 | `gateway-lite` 补入同一模板一次 |

除官方 Lite 对照外，全部交付路径的合成指令哈希均为 `d3066106c80edcb8a8c2e86ba34c0e79a09ebfa2059f5c805a83bd2f40d39d40`。AGENTS.md 与用户标记保留，persistent 指令按要求未注入。官方 Lite 的省略仅表示客户端 wire 的观测，不代表官方服务端没有基础指令。

此前“只靠 catalog 的 Lite 路径失败”仍保留为历史证据。新增显式适配后，当前确定性兼容门禁和 359 项完整回归均通过。Sol／Astra 真实对照、App 协议生成、本机安装和 App UI 签核是独立门禁，不能由上述结果替代。

源码维护者可在显式指定全部 target 后使用 `scripts/maintainer/instruction-snapshot-activate.mjs` 及其回滚命令。启用要求 App 已关闭、活动轮次和 WebSocket 为零、无 pending／drift，且来源与候选包哈希未变化。这些工具不进入 npm 安装包；旧 rollback 入口必须先按[开源维护边界](open-source-maintenance-boundaries.zh-CN.md)保存。独立逃生路径仍是在退出 App 后从另一终端执行 `codex-local-router rescue --subscription --yes`。
