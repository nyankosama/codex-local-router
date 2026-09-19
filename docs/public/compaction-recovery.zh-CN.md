# Fork 与压缩历史恢复

Codex 可能用官方不透明 compaction 表示老会话。第三方 Provider 无法解密它。Router 会把完整加密归档、当前有效压缩窗口和目标模型可使用的迁移视图分开保存；只有元数据不能冒充可迁移历史。

直接 fork 会先查当前线程，再查请求明确声明的父线程。部分 Codex 运行时不会在线路上携带父线程元数据；此时 Router 只能在同一已验证订阅账号内，按此前观察到的加密 compaction 精确 SHA-256 恢复谱系，不会根据提示正文猜测，也不会跨账号继承。成功后会把 checkpoint 加密复制到 fork 自己的作用域，后续 turn 和服务重启不再依赖本次查询。谱系缺失或存在无法解释的缺口时返回 HTTP 409，不会发送第三方、重试或回退渠道。

若 fork 在官方 compaction 旁路观察仍提交时到达，跨渠道路由会在有界窗口内等待同账号观察完成后再判断；不会等待其他账号，也不会把这次本地等待变成上游重试。

由于当前 Codex 运行时可能在相邻 turn 间改变线程元数据，官方观察记录会按已验证账号顺序提交。该顺序只约束本地旁路归档，不会让官方响应等待归档 I/O。

官方 WebSocket 预热响应也会作为谱系状态被观察：当前 Codex 客户端可能把 `generate: false` 响应作为下一请求的 `previous_response_id`。原始预热请求和响应仍保持透明转发。

若 Codex 在不同 turn 间改变或省略线程元数据，官方 response ID 也只会在同一已验证账号内按精确 ID 恢复。该 ID 不会跨账号，Gateway 生成的虚拟 response ID 也不会被提升为官方谱系。

官方 compaction 输出会替换压缩前的有效上下文窗口，而不是追加在旧历史之后。Router 同时识别独立压缩请求和普通响应内产生的 compaction，并只按精确位置移除 retained tail，避免误删合法重复消息或工具结果。

## 恢复存量 rollout

预览阶段可以保持 Codex App 打开：

```bash
codex-local-router history recover --thread THREAD_ID --json
```

可用 `--source /绝对路径/rollout.jsonl` 指定唯一文件；未指定时从 `CODEX_HOME/sessions` 选择该线程的最新分段，祖先查找同时覆盖 `CODEX_HOME/archived_sessions`。预览仅输出线程引用、哈希、文件／记录／checkpoint 数量和预计写入数。

审阅后，在安全窗口应用：

```bash
codex-local-router history recover --thread THREAD_ID --yes --json
```

应用要求 Codex App 已退出，Gateway 活跃 turn 与 WebSocket 连接均为零。命令会停止已加载的受管服务，流式读取 JSONL，最多递归 16 层显式 `history_base`（没有 history base 时才使用 `forked_from_id`），支持多段和多级 fork，并严格核对每个 ordinal、exclusive 边界、compaction 及工具 call/result 关系。写入前再次核对所有来源文件哈希，全部通过后才在一个加密 SQLite 事务中提交，最后恢复原服务状态。匹配但尚无可迁移原文的 checkpoint 可以补齐已验证历史。重复执行同一来源保持幂等，不修改 Codex rollout。

被中断的工具调用会保留为“执行结果未知”的历史事实，不会被静默删除或自动再次执行。可见 agent message 和已完成搜索来源可作为不可信历史投影；Provider 私有密文不会发送另一个 Provider。

缺祖先返回 `rollout_history_base_missing`，事件或工具结果不完整返回 `rollout_history_incomplete`，谱系、边界、来源选择或已有 checkpoint 冲突返回 `rollout_lineage_conflict`，且均为零写入。此类会话只能继续使用官方模型，或把经过审阅且不含凭证的必要上下文移入新任务。老会话中已经暴露的凭证仍须在对应平台外部轮换；恢复命令不会复制或验证凭证。

`history inspect --thread THREAD_ID --json` 会报告完整原文、仅元数据、观察中、存在缺口、可复用摘要和摘要失败数量，以及最近恢复来源哈希。增加 `--target TARGET_ID` 可查看该目标下直接兼容、需要受控摘要及仍被阻止的 checkpoint 数量。命令不输出消息、工具内容、compaction 内容或凭证。

## 受控原生迁移摘要

`compression.nativeMigrationSummary` 缺省关闭，只能与 `compression.mode: "summary"` 同时使用。通过 `model edit --id TARGET --native-migration-summary` 为单个目标显式开启，使用 `--no-native-migration-summary` 关闭。

当可信的官方 opaque 窗口无法直接投影时，Router 会让原官方模型在关闭工具的情况下，对保存的有效窗口最多生成一次摘要。摘要按来源窗口哈希和目标持久化，重连或重启后复用，并与未摘要的最新用户输入和必要尾部组合。opaque item 与订阅凭证不会发送第三方。谱系缺失、来源缺口、结果不确定或必要尾部已超过目标预算时，会在目标生成前明确失败；不会自动重试、渠道回退、递归分块，也不会把有损摘要宣称为无损恢复。
