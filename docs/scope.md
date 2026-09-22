# 范围与交付边界

本项目是自研本地多模型 Gateway，支持确定性路由、Codex 对话级模型选择和可恢复历史。

```text
Codex App / CLI（内置 openai、ChatGPT 订阅登录）
              → /subscription/v1 → GPT：官方订阅后端
                                 → 自定义模型：配置的第三方渠道
Codex CLI（ai.feei.cn profile）
              → /v1 → 配置的 OpenCode Go 目标
```

原 CLI-only 阶段与本次扩展分开验收。两条入口复用执行层，但认证、默认路由和 fallback 边界不同。ai.feei.cn 在这里是 CLI 入口配置名称，不是 Gateway 下游，也不代表订阅认证。

## 包含

- App 保持内置 openai Provider；GPT 使用订阅认证，自定义模型使用各自渠道凭证；默认接入包含 OpenCode Go 的 `deepseek-v4.1-flash`。
- 同一模型菜单、不同对话并发、下一 turn 双向切换；切换前的旧模型压缩与新模型回答分开路由，正在执行的回答/工具循环保持原路由。
- HTTP Responses、普通 JSON、SSE、WebSocket；模型目录、健康检查、取消、有限资源和脱敏日志。
- 原 API 入口透传、固定、第一条命中的确定性规则、默认目标与显式备用目标。
- Responses 原生转发、Chat Completions JSON function tools 适配、工具结果回放。
- 原生搜索透传、Tavily/Exa 搜索与定长正文提取回退，以及确定性 Fake Adapter。
- 环境变量/Keychain 凭证、原子配置重载、可回滚 App 配置和本地服务脚本。
- Codex 主导的原生压缩、单次摘要适配与可迁移 checkpoint；跨 Provider 原文/工具历史、图片说明和 Responses Lite 前缀恢复。
- SQLite 加密持久历史、重启恢复、账号/分支隔离、精确 rollout 导入导出及显式清理。
- 基于现有 Responses、Chat Completions、OpenCode Go 和 OpenAI 兼容 adapter 的配置化扩展。

## 不包含

动态插件执行、未知供应商协议预实现、语义路由、自学习、自迭代、质量评估、Shadow Critic、多模型协作；Gateway 不执行 Codex 的文件和命令工具，不管理用户任务。

Gateway 不建立自己的固定阈值或递归摘要策略。token 估算不能单独触发有损压缩；未验收的能力不能只靠配置声明为可用。

不修改 App 客户端、不使用模型名伪装、不依赖或启动 opencode-go-proxy。不会为了接入而中断用户正在运行的任务或擅自停止旧服务。

## 技术与验收约束

Node.js 22+、锁定版本的 ws、系统 curl HTTP/1.1；不关闭 TLS 校验，不强制设置 NO_PROXY。HTTP/1.1 是本机已验证的网络规避方案，不代表解决了所有网络稳定性问题。

首次加载 App 配置可能需要一次完整退出/重开；之后模型切换不应重启。真实 App UI 由用户在安全窗口人工验收，后端通过不能替代 UI 通过。未获得 UI 确认前，不报告完整 App 交付。
