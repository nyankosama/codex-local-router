# 第三方多代理兼容

`codex-general-v1` 会为能力满足的第三方 Responses target 直接配置多代理 v2 元数据：

```sh
codex-local-router model edit --id TARGET --multi-agent-version v2 --space SPACE
codex-local-router model edit --id TARGET --multi-agent-version client-default --space SPACE
```

需要精确对齐官方元数据时，仍可显式采集快照。

显式采集对应官方模型的 Codex 多代理能力快照：

```sh
codex-local-router model sync-multi-agent --ids feei-sol,feei-astra --space default --yes --json
codex-local-router model edit --id TARGET --multi-agent-from OFFICIAL_MODEL --space SPACE
codex-local-router model edit --id TARGET --multi-agent-from none --space SPACE
```

不带 `--yes` 仅预览。批量同步全部成功后一次写入，内容不变不创建空版本。`none` 移除受管能力声明，不等于禁用 Codex 多代理；禁用仍使用 Codex 自身设置。旧配置不自动迁移。

直接配置要求启用 App、第三方 Responses 且支持工具调用。官方来源仍精确解析，不按渠道名称猜测，也不借用其他模型。

`app.multiAgent` 保存来源和上游模型、快照版本、客户端版本、时间、catalog 哈希、能力哈希，以及 `multi_agent_version` 和可选的 `multi_agent_reasoning_effort`。缺失字段保持缺失。统一 catalog 入口只投影已保存的快照，不在请求时重新采集。list/probe/status/doctor 提示来源更新；显式同步才创建空间版本。快照参与 drift 检测和精确回滚。

collaboration 工具及运行时指令由 Codex 生成。Gateway 不追加多代理 Prompt、不另建调度器、不自动替换子模型或提高并发。用户模型、effort、角色、权限、委派和禁用设置仍有效。默认继承父模型时保留第三方别名；显式选择官方模型时仍走官方。不顺带修改 Plugin 白名单、MCP、Skills、Hooks、默认模型、搜索或缓存策略。

多代理会增加必要的工具／角色上下文及子代理生成调用。能力对齐不保证任务拆分、文风、耗时或费用相同。当前客户端协议、真实父子调用和 App UI 是三项独立验收；候选验收凭据全部通过前不要启用。UI 使用新任务，不重写旧任务历史。

隔离验收通过后才准备安装。App 退出后，保留旧安装包及精确空间，核对 Codex 当前选模和空间默认模型分别未变。关闭 App 后的逃生指令：`codex-local-router rescue --subscription --yes`。
