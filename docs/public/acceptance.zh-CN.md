# 验收说明

本次配置空间候选记录见[配置空间候选验收报告](configuration-spaces-acceptance.zh-CN.md)。
v0.4.0 第三方独立搜索记录见[第三方 OpenAI 搜索验收报告](third-party-openai-search-acceptance.zh-CN.md)。隔离 CLI/App 协议真实门禁已通过；App UI 和本机安装生效仍需单独确认。

PR 门禁使用 A1-A10 十组等价类：策略解析、来源/名单、工具载体、调用闭环、HTTP 透明性、WS 生命周期、身份边界、历史兼容、产品/隔离、证据/预算。它们由纯函数和本地模拟上游完成，不调用真实模型。

发布包同时携带验收 Harness 与运行时测试集；从 `.tgz` 安装后，`npm test`、`npm run audit:package` 和文档列出的 `e2e:*` 脚本都必须可执行。包审计会逐一检查 `package.json` 中声明的 Node 脚本入口及测试文件，缺少任何入口都会失败。三项只适用于完整仓库的公开导出器测试继续在源码/公开导出树强制运行，在安装后的 `.tgz` 中因不存在仓库导出输入而显式跳过。

配置空间补充 fresh/legacy/applied/disabled/pending/歧义迁移、不可变 revision、official 自动追加、克隆/diff/默认模型/drift capture、official↔Router/Router↔Router/历史版本/rollback、一次性协调器、活跃轮次、凭证/候选/服务/哈希失败与分阶段恢复，以及非受管 Codex 数据保留。测试统一使用临时 Codex/Router Home、配置/状态/LaunchAgent、随机端口、模拟 launchctl 和本地上游。

L0-L2 和能力画像门禁均为零凭证、零外网的确定性测试：它们仍会驱动当前 App 内置 Codex core，但官方、Provider 与搜索上游全部由本地注入夹具响应。只有带显式 `--run` 的 live canary 才会读取对应凭证并访问真实上游；默认 `npm test`、`npm run e2e` 和各层门禁不会触发真实渠道。

本轮配置空间候选明确不运行 `e2e:focused -- --run`，真实模型调用为零。门禁前后需确认本机 Router/切换器未加载、8788 未监听、integration 为 disabled、真实 Codex 仍是内置 `openai`。App-server 不能替代后续 UI 签核。

```bash
npm test
npm run audit:package
npm run e2e:l0
npm run e2e:l1
npm run e2e:l2
npm run e2e:profiles
npm run e2e                       # 只运行 L0-L2，不包含 live
npm run e2e:live -- --run         # 显式运行已安装服务并发用例
npm run e2e -- --include-live --run
```

官方搜索另有一个窄范围真实 canary：

```bash
npm run e2e:official-search -- --run
```

它先通过 Router 的生产级官方 WebSocket 客户端执行一次零生成握手探针并要求 HTTP 101，然后只运行两个隔离的官方订阅短 turn：第一轮不设置 `web_search`、不要求用户增加参数，验证 Codex 正常的 cached 默认模式；第二轮使用单次 `--search` 覆盖，验证 live 模式。两轮都必须看到当前 Codex 版本所选择的官方 Responses 传输成功、固定 OpenAI 目的地的 `/alpha/search` 成功、客户端 `web_search` 完成事件、回答中的来源 hostname，以及不存在第三方出站。预算固定为两个 turn、最多六次生成（一次搜索 turn 可能包含多次模型与工具续接），不保存提示或回答正文。

第三方 GPT 搜索路由使用独立的两轮 canary：

```bash
npm run e2e:third-party-search -- --run
```

该 Harness 会在隔离配置中显式选择 `lite-search`。第一轮在 CLI 中选择 ai.feei Sol，不传 `--search`、不写 `web_search`，验证 Codex 的 cached 默认；第二轮通过 `app-server` 选择 ai.feei Astra，并仅在隔离配置设置 `web_search = "live"`。硬预算是两个 turn、十二次模型生成、八次搜索，无重试循环；完全相同的生成 payload 会在第二次发送前被 fail-fast 拦截。该上限覆盖真实观察到的 Responses Lite search/open/read 阶段，同时仍能阻断异常循环；它不证明同一 turn 的 `standard-tools` 工具面。

每轮必须同时看到：客户端搜索 item 完成；搜索请求全部到 `chatgpt.com`；第三方生成全部到 `ai.feei.cn`；订阅凭证和 Provider Key 只出现在各自链路；成功搜索响应中至少一个 URL 的内存哈希能在后续第三方请求中匹配；最终回答包含来源。证据只落 URL/响应哈希、数量、host、状态、字节、耗时和布尔值，不落查询、结果、URL、提示、回答或凭证。Provider Key 可来自 `FEEI_API_KEY` 或只读 Keychain 引用，均不会打印或复制。

最终候选另有显式真实路由与渠道 canary；它不是能力画像准出门禁：

```bash
FEEI_API_KEY=... npm run e2e:focused -- --run
```

它只允许五个短 turn、最多十次可观测模型生成，不做自动重试：官方 CLI 回答与独立搜索；ai.feei Sol/Astra CLI 回答与合成图片；两款模型各一个显式 `lite-search` App 协议搜索 turn。超过预算或搜索去向不是 OpenAI 会立即失败。

真实 turn 前的 `standard-tools` 预检只确认允许 Plugin 和用户 MCP 定义被转发、禁止 Plugin 定义被删除；结果明确标记为 `DEFINITION_PREFLIGHT_ONLY`，不能充当调用/结果闭环。两个 App 用例只要求看到 Responses Lite 搜索载体、官方独立搜索成功且只到 OpenAI，并明确披露 `reduced-responses-lite`，不宣称完整 Plugin/MCP 兼容。summary 明确写明“Standard 完整工具面与搜索组合能力未建立”；缺少任一预期用例或证据就是 FAIL。

完整画像准出由独立的确定性门禁承担：使用当前 App 内置 Codex 二进制和隔离本地夹具，分别证明 `standard-tools` 的核心/允许 Plugin/用户 MCP 实际调用与结果闭环，以及 `lite-search` 的完整搜索闭环。不同画像的证据分开报告，不能拼接成一项能力结论。

所有过程使用临时 `HOME`、`CODEX_HOME`、XDG、Router Home/状态/历史、实例、工作区和随机端口。确定性门禁使用无害的合成 auth，不读取 Provider Key；显式 live canary 只把所需 Codex auth 以 0600 权限复制到隔离根目录，不软链接真实文件。Codex 子进程不会继承环境中的 Provider、代理、shell agent、App tools pipe 或自定义 CA 变量，除非用例显式提供无害夹具值。L0 另行验证整个测试进程树不能写真实 Codex、Router、LaunchAgent、MCP、Skill、Hook、提示或会话目录。

在 macOS 上，G3 live runner 会先在禁止写入真实 Codex、Router、已安装 Skill、LaunchAgent 和 Keychain 根目录的外层 sandbox 中重新启动自身；Codex 保持自身的只读 sandbox，并使用临时 Home。回执记录 sandbox profile 哈希，并把受管 catalog、空间索引和 pending 事务纳入前后权威边界。`models_cache.json` 发生变化时，只有已观察到 App 刷新、测试进程树无法写真实目录、权威状态未变且新缓存没有 Router 状态，Gateway Core 才能继续通过。

证据只保存模型/工具类型、来源标识、哈希、状态、数量、字节和耗时，不保存提示、回答、搜索查询/结果/URL、工具 schema、凭证、图片或本地绝对路径。用于准出的运行还会设置 `ACCEPTANCE_COMMIT`；Harness 会拒绝脏工作树或不一致的提交，并同时记录精确 commit 与 Git tree。run 目录和 JSON 回执只能创建一次，目标已存在时直接失败，不会覆盖旧证据。

G3 性能门禁对阈值保持宽松，但对证据完整性 fail closed。成功用例必须记录适用的本地路由/策略或透明 Relay setup、身份/历史、归档/观察、上游首字节、首个实质事件、首个文本、搜索、总耗时，请求/响应/工具字节，重试/重连、健康采样、event-loop 和最终生命周期。取消用例只有在已证明生成请求发出、随后在首字节/文本前关闭、响应字节与总时长仍完成结算且资源归零时，才能把未观察到的首字节/文本标成预期缺失；其他必填指标缺失直接阻断 Gateway Core。

真实渠道归因同样 fail closed。单次 HTTP 200 后流提前结束只能记为 `UNVERIFIED`，不能据此认定 Provider 降级。只有稳定的 Provider 状态/传输类别或等价隔离直连复现，并且身份、生命周期和重试/重放证据均干净时，才能记为 `EXTERNAL_DEGRADED`。

`UNVERIFIED` 只用于责任确实无法区分的外部失败。若本地路由、目的地凭证、catalog 真实性、图片/思考参数适配、已完成搜索结果回填或资源清理断言失败，必须记为 `GATEWAY_DEFECT` 并阻断 Gateway Core，不能借第三方渠道不稳定降级处理。

自动 app-server 验收不能替代 UI。最终报告必须把“实现完成”“自动验收通过”“本机已生效”“App UI 已确认”分开列出。

英文完整说明见 [acceptance.md](acceptance.md)。
