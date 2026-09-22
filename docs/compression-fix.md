# HTTP 压缩请求恢复修复（2026-09-11）

> 本文记录 `3364720` 基线修复当时的范围和证据。后续持久历史、400K DeepSeek 配置和 Codex 主导的单次摘要适配已经在 [多模型与历史恢复](./multimodel-history.md) 实现；下文“未实现”只描述该基线提交当时的状态。

## 问题与范围

Codex 的远程上下文压缩通过 HTTP 发送 zstd 编码的 JSON；旧入口忽略 Content-Encoding，把压缩字节直接作为 UTF-8 JSON 解析，返回 invalid_json。普通 WebSocket 对话能正常运行，不能证明此 HTTP 路径可用。

本次只修复请求解码与错误分类，不继续上下文持久化、容量判断或模型切换方案；保留原任务未接入的 archive.mjs。

## 修复

- HTTP 按 identity、zstd、gzip、deflate 流式解码，再解析 JSON。zstd 需要运行环境提供 Node.js createZstdDecompress；本机 Node.js 22.23.2 已验证。
- 传输字节与解压字节分别受 maxBodyBytes 限制，默认 20 MiB，取消请求会停止解码。
- 区分 invalid_json、invalid_compressed_body、unsupported_content_encoding、content_decoder_unavailable、request_too_large 和 cancelled。
- WebSocket 非法 JSON 也返回 invalid_json。
- HTTP 错误日志记录时间、传输、阶段、编码类别及字节数，不记录正文或凭证。

## 验证

- npm test：54/54 通过，包括 4 个新增回归测试；git diff --check 通过。
- 大段中文和 emoji 的压缩请求经真实 HTTP 入口逐项比较，JSON 与 SSE 均通过。
- 覆盖碎片化 zstd、损坏压缩流、非法 JSON、不支持的编码、解压膨胀限制、取消与 WebSocket 错误分类。
- 线上修复前，同一合法 zstd 请求返回 400 invalid_json；加载修复后进入订阅认证检查，返回 401 subscription_auth_required（探针未携带凭证）。
- 已加载线上 Gateway；未改 Codex 历史文件、账号或模型目录。


## 同 GPT 压缩阻塞修复

同一会话曾在 7 分 44 秒和 4 分 36 秒后被用户停止，对应分别启动 17 次和 10 次迁移摘要调用，均未进入官方原生压缩。原逻辑在每次重试中重新串行处理迁移摘要。

现在 GPT 压缩直接请求官方后端；可迁移文字副本只做本地转换，不额外调用模型。迁移不兼容（例如图片、官方专有状态）或迁移副本超过缓存上限，不阻塞原生压缩。缺失迁移副本时跨供应商请求仍明确失败。

官方压缩项在本地缓存缺失时可原样传给使用请求者认证的官方后端，由官方验证有效性。Gateway 自己的虚拟检查点不会走此透传路径，也不将未知官方状态转发到第三方。

回归 58/58 通过，覆盖大历史只有一次官方压缩调用、重启后继续和再次压缩、图片、缓存上限及跨供应商失败边界。未实现原计划中的持久归档、目标预算迁移或 DeepSeek 摘要策略变更。

真实旧会话恢复验证：`01a090da-2873-7fa2-bb64-7cd7edde7dbb` 的 `01a0911f-3314-7881-916a-80349d7e2893` 轮完成，耗时 114046 ms（包含原生压缩及回答）。Gateway 请求 `0314762a-b17c-4f70-a947-86bc52356aed` 记录 native 路由及 compaction_completed，没有 portable_summary 调用。会话回复“同 GPT 压缩续接成功，原任务暂停。”，无工具执行。此结果证明该长会话可恢复，不代表所有长历史都在固定时限内完成，也未真实验证跨供应商或重启后的再次压缩；后两者应区分对应的自动化覆盖范围。
