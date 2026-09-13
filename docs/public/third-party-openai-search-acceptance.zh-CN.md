# 第三方 OpenAI 搜索候选验收报告

日期：2026-09-13  
真实验收候选：最终已提交候选（精确提交由验收驱动记录）
总体结论：**隔离 CLI/App 协议门禁 PASS**

## 已解决的协议边界

首次生成成功的探针暴露了一个关键区别：当 `use_responses_lite: false` 时，Codex 会把顶层 hosted `web_search` 工具发给 ai.feei；ai.feei 在自己的 Responses 请求内完成搜索，因此用户 Codex 订阅的 `/alpha/search` 完全不会被调用。由此也确认：只有客户端搜索 item 完成，不能证明选定的搜索来源生效。

当前 Codex 的独立搜索通过 Responses Lite 的 `input[].additional_tools` 载体，以 `web.run` namespace 暴露。ai.feei 两款预设现已启用 Responses Lite：模型生成仍去 ai.feei，Codex 调用 Gateway 的 `/subscription/v1/alpha/search`，冻结的搜索租约再把请求送到选定的订阅或 Provider endpoint。对未声明原生 hosted search 的 target，选择独立搜索来源后如果收到顶层 hosted-search 载体，Gateway 会返回 `standalone_search_protocol_mismatch`，避免静默改用第三方 hosted search。

运行时配置仍是 Schema 3，配置空间仍是 Schema 1，integration 仍是 Schema 4。通用 CLI 在 App-enabled `openai-gpt` target 启用独立搜索时默认使用 Responses Lite；显式组合不兼容的 `--no-responses-lite` 会被拒绝。

## 真实验收

驱动为 App 内置 `codex-cli 0.154.0-alpha.6.2`，SHA-256 为 `ecad78dbf98adb89ec475edac86630406cbe59d9f3070b17d88065f136b94bcb`。

最终隔离运行完成两个计划 turn：共 4 次模型生成、2 次独立搜索，没有请求被拦截，没有自动重试，也没有重连。

| 用例 | 客户端 | 搜索 | 生成 | 结果续接 | 来源 | 结论 |
|---|---|---|---|---|---|---|
| ai.feei Sol，cached 默认 | CLI 完成 | 1 次成功请求到 `chatgpt.com` | 2 次成功请求到 `ai.feei.cn` | 搜索结果指纹命中第二次生成 | 已呈现 | PASS |
| ai.feei Astra，live | App 协议完成 | 1 次成功请求到 `chatgpt.com` | 2 次成功请求到 `ai.feei.cn` | 搜索结果指纹命中第二次生成 | 已呈现 | PASS |

两例的第一次生成都包含 Responses Lite additional-tool 载体和 `web.run` namespace，没有顶层 hosted `web_search`。所有官方搜索只携带订阅凭证，所有 ai.feei 生成只携带 Provider 凭证。搜索响应只在内存中提取哈希和数量；每例至少有一个结果指纹出现在对应的续接请求中。

此前失败探针作为诊断历史保留而不覆盖：最初的标准 Responses 形态在第三方侧执行 hosted search；后续一次两用例运行已证明搜索/生成拆分正确，但 Astra 在旧的 6 次生成/4 次搜索总预算处被 Harness 截停。最终 Harness 仍有硬上限，但按真实 search/open/read 阶段调整为 2 个 turn、12 次生成和 8 次搜索，正常链路可以完成，异常循环仍会 fail closed。

## 本机隔离

测试使用临时 Router Home、Codex Home、加密状态/归档、工作目录、随机端口和生成 catalog，没有安装或激活候选。真实 Codex 运行配置哈希未变化，两个 Router LaunchAgent 仍未加载，8788 未监听。运行中的 App 可能自行刷新真实 model cache；Harness 对该文件只读，因此不再把它作为“环境哈希不变”的判断项。

App-server 证据不等于 App UI 签核。验收运行本身没有安装或激活候选；发布也不代替本机生效和 UI 签核。
