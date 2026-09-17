# Fork 与压缩历史恢复

Codex 可能用官方不透明 compaction 表示老会话。第三方 Provider 无法解密它，因此 Router 只有在持有“密文完全匹配且包含原始历史”的可移植 checkpoint 时才允许跨 Provider 续聊。

直接 fork 会先查当前线程；未命中时，只按请求明确声明的父线程增加一次本地查询。继承要求同一已验证订阅账号、加密 compaction 的 SHA-256 完全一致，并且父 checkpoint 具有非空原文。成功后会把 checkpoint 加密复制到 fork 自己的作用域，后续 turn 和服务重启不再依赖父线程。缺失或只有摘要的 checkpoint 返回 HTTP 409 `compaction_history_unavailable`，不会发送第三方、生成摘要、重试或回退渠道。

## 恢复存量 rollout

预览阶段可以保持 Codex App 打开：

```bash
codex-local-router history recover --thread THREAD_ID --json
```

可用 `--source /绝对路径/rollout.jsonl` 指定唯一文件；未指定时只在当前 `CODEX_HOME/sessions` 中按线程 ID 精确查找，零个或多个匹配都会拒绝。预览仅输出线程引用、哈希、文件／记录／checkpoint 数量和预计写入数。

审阅后，在安全窗口应用：

```bash
codex-local-router history recover --thread THREAD_ID --yes --json
```

应用要求 Codex App 已退出，Gateway 活跃 turn 与 WebSocket 连接均为零。命令流式读取 JSONL，最多递归 16 层显式 `history_base`／`forked_from_id`，严格核对 exclusive ordinal 边界、每个 compaction 和工具 call/result；所有现有 checkpoint 预检成功后，才在一个加密 SQLite 事务中写入。重复执行同一来源保持幂等，不修改 Codex rollout。

缺祖先返回 `rollout_history_base_missing`，事件或工具结果不完整返回 `rollout_history_incomplete`，谱系、边界、来源选择或已有 checkpoint 冲突返回 `rollout_lineage_conflict`，且均为零写入。此类会话只能继续使用官方模型，或把经过审阅且不含凭证的必要上下文移入新任务。老会话中已经暴露的凭证仍须在对应平台外部轮换；恢复命令不会复制或验证凭证。

`history inspect --thread THREAD_ID --json` 会增加可移植／不可恢复 checkpoint 数量和最近恢复来源哈希，不输出消息、工具内容、compaction 内容或凭证。

