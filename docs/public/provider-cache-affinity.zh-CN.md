# 第三方 GPT 缓存亲和协议

Prompt Cache 与账号池粘连是两层能力：

```text
Codex 会话谱系
    │ 本机 HMAC
    ▼
Gateway 匿名键
    │ 选账号前一致性哈希
    ▼
Provider 池账号 / Cache Shard
```

Codex Local Router 能保证第一层稳定且不暴露原始身份。背后使用多 API Key 或订阅账号池的中转站可以利用第二层改善缓存局部性；否则同一个 Gateway 键仍可能落到不同账号作用域的缓存。

## Gateway 契约

第三方 `openai-gpt` Responses target 所属 Provider 显式设置 `gateway-opaque` 后，Router 会：

- 使用本机 32-byte secret、账号哈希、已验证谱系、Provider ID 和上游模型派生 `clr-pc-v1-*`；
- 依次优先使用客户端 cache key 的 HMAC、同账号已存在的父线程映射、当前 thread；
- 在一个 turn 内冻结结果，覆盖 HTTP、WebSocket 与工具结果续接；
- 严格隔离不同账号、Provider、模型和无法验证关系的 fork；
- 不向第三方发送原始 cache key、ChatGPT 账号、thread、turn、session、installation 或 window 标识；
- 不扫描或哈希 Prompt，不增加网络请求，不因字段拒绝而去掉字段重试，也不改变 Provider/模型。

缺少稳定谱系时安全地不注入键；专用 Keychain secret 不可用时在发送前明确失败。密钥轮换、TTL 过期、Provider 或模型切换允许一次冷启动。

## 账号池中转站互操作建议

希望尽可能保留上游缓存局部性的中转站，建议：

1. 在 Responses endpoint 接受顶层标准 `prompt_cache_key`；
2. 转发请求前把匿名键作为稳定选择上游账号或 Cache Shard 的输入；
3. 在完整 turn 内冻结所选账号，包括工具结果续接；
4. 映射至少在声明的 30 分钟亲和 TTL 内保持稳定；
5. 账号故障时在替代账号上冷启动一次，同一 turn 不再切回；
6. 转发或真实重建 `usage.input_tokens_details.cached_tokens`，使效果可观测；
7. 不把匿名键记录或暴露为面向客户的身份。

一致性哈希可以作为实现方式，但不是本项目已经验证的协议要求。本轮 ai.feei 实验只证明标准字段带来的外部可观察效果，不披露、也不验证 ai.feei 内部账号池算法。匿名键不能被解析；中转站不得假设其中包含账号、用户、thread 或模型名称，也不得结合 Prompt 反查身份。

## 验收边界

Gateway 确定性验收证明键的稳定/隔离、原始身份删除、安全参数裁剪、HTTP/WS、加密重启/fork 谱系、有界状态、零重试和本地性能护栏；它不能证明远端中转站尊重该键。

当前缓存对照门最多交错执行 24 次合成生成：Sol、Astra 各包含 6 次原始直连形态和 6 次候选匿名亲和，每组首个样本作为预热。候选预热后要求 5 次中至少 4 次缓存非零、加权命中率至少 70%，且不比同期直连低超过 15 个百分点。另一组当前 App 二进制协议门最多 6 次 Provider 生成，分别完成两款模型的只读 MCP call/result 续接，并要求逐 frame Responses Lite 协商和匿名键指纹稳定。

如果中转站拒绝或忽略该字段，结论必须是 `EXTERNAL_UNRESOLVED`：Gateway 候选可以完成，但端到端缓存亲和尚未验收，不能据此启用生产配置空间。

从源码维护候选时，`scripts/maintainer/cache-affinity-activate.mjs` 及其回滚命令会绑定精确安装包、server、配置、target ID 和来源空间哈希。这些工具不进入 npm 安装包。替换仍被已保存 rollback 引用的旧全局安装前，必须按[开源维护边界](open-source-maintenance-boundaries.zh-CN.md)准备并校验独立恢复包。独立逃生路径仍是退出 App 后执行 `codex-local-router rescue --subscription --yes`。
