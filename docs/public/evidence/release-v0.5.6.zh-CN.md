# v0.5.6 发布准出证据

> **冻结证据**  
> 适用范围：`v0.5.6` 发布准出及其累计验收谱系。  
> 此不可变记录不代表当前 Release、本机服务或 Provider 的现状。

配置空间与 v0.4.0 第三方独立搜索报告是冻结的历史记录，不代表当前已安装服务状态：[配置空间](configuration-spaces-v0.3.0.zh-CN.md)、[第三方 OpenAI 搜索](third-party-openai-search-v0.4.0.zh-CN.md)。其中协议证据仍可复用，但 App UI、本机生效和每个新 Release 都需分别签核。

PR 门禁使用 A1-A10 十组等价类：策略解析、来源/名单、工具载体、调用闭环、HTTP 透明性、WS 生命周期、身份边界、历史兼容、产品/隔离、证据/预算。它们由纯函数和本地模拟上游完成，不调用真实模型。

工具搜索历史迁移增加一组聚焦的确定性矩阵：合法单 pair、多 pair、交错与空结果；缺失、重复、反序和畸形 pair；第三方 Responses → 官方 → 第三方 → Chat Completions 切换；函数/custom-tool 结果保留；加密 original/view 分离；schema、查询与 ID 脱敏；以及 10,000 item 的线性扫描 sanity。Engine 只使用本地模拟上游，畸形历史必须在 outbound hook 调用前失败。该门禁不会重试真实存量会话。

发布包同时携带验收 Harness 与运行时测试集；从 `.tgz` 安装后，`npm test`、`npm run audit:package` 和文档列出的 `e2e:*` 脚本都必须可执行。包审计会逐一检查 `package.json` 中声明的 Node 脚本入口及测试文件，缺少任何入口都会失败。三项只适用于完整仓库的公开导出器测试继续在源码/公开导出树强制运行，在安装后的 `.tgz` 中因不存在仓库导出输入而显式跳过。

配置空间补充 fresh/legacy/applied/disabled/pending/歧义迁移、不可变 revision、official 自动追加、克隆/diff/默认模型/drift capture、official↔Router/Router↔Router/历史版本/rollback、一次性协调器、活跃轮次、凭证/候选/服务/哈希失败与分阶段恢复，以及非受管 Codex 数据保留。测试统一使用临时 Codex/Router Home、配置/状态/LaunchAgent、随机端口、模拟 launchctl 和本地上游。

压缩历史恢复补充当前线程查找、精确直接父线程继承与重启持续性；账号、父线程和 compaction 哈希隔离；仅摘要 checkpoint 关闭失败；完整单文件、父子 rollout 链和重复恢复；缺祖先、错边界、工具 pair 断层、损坏 JSON、多文件歧义和已有记录冲突。验证失败必须零写入；恢复后的唯一次本地模拟第三方请求只能收到展开原文，不能收到官方不透明 compaction，也不允许重试。父 checkpoint 本地查找 p95 强制小于 10 ms，且不增加网络请求。

L0-L2 和能力画像门禁均为零凭证、零外网的确定性测试：它们仍会驱动当前 App 内置 Codex core，但官方、Provider 与搜索上游全部由本地注入夹具响应。只有带显式 `--run` 的 live canary 才会读取对应凭证并访问真实上游；默认 `npm test`、`npm run e2e` 和各层门禁不会触发真实渠道。

历史配置空间候选没有运行 `e2e:focused -- --run`，真实模型调用为零；当次记录中的 Router/切换器未加载、8788 未监听、integration 为 disabled，真实 Codex 仍使用内置 `openai`。这些只描述当次运行，App-server 始终不能替代后续 UI 签核。

```bash
npm test
npm run audit:package
npm run e2e:l0
npm run e2e:l1
npm run e2e:l2
npm run e2e:profiles
npm run e2e:tool-search-history      # 当前 app-server + 存量历史迁移，全部本地
npm run e2e                       # 只运行 L0-L2，不包含 live
npm run e2e:live -- --run         # 显式运行已安装服务并发用例
npm run e2e -- --include-live --run
npm run e2e:official-search -- --run    # 官方 cached 默认＋显式 live
npm run e2e:universal-search -- --run   # 三项第三方桥接／MCP 等价类
npm run e2e:release -- --run            # 默认发布门：画像＋第三方＋官方搜索
npm run e2e:prompt-cache             # 零外网派生/适配性能门
npm run e2e:prompt-cache -- --live-feasibility --run  # 最多 8 次 Provider 直连
npm run e2e:prompt-cache -- --live-comparison --run  # Sol/Astra 24 次直连形态与候选对照
npm run e2e:prompt-cache -- --live-app-candidate --run  # 当前 App 二进制，最多 6 次 Provider 生成
```

## GitHub Release 默认准出门

搜索开启时的流式交付新增为硬门禁：HTTP／WS × 订阅桥接／旧搜索后端 ×
不搜索／两次搜索，共八个小型本地探针，零真实模型调用。模拟上游必须等客户端
收到每段文本才继续，因此“先整轮缓存、终态再一次放出”不能通过。
同时验证单一响应生命周期、输出 ID／顺序、内部调用隐藏、完整历史恢复和发送端日志。
真实桥接用例记录文本 delta 数量和时序，GLM app-server 必须在完成前收到多个文本 delta；
协议通过不等于 App UI 已签核。

原采样器指标改名 `sample_first_output_text`；`downstream_first_output_text`
现在位于 HTTP／WS 成功发送边界，`downstream_stream_completed` 只记录数量、字节和耗时。
发送成功不证明 UI 已渲染。Gateway 不伪造过程消息、不将 reasoning 改成 commentary：
模型只调用工具而不输出进度文字时，仍不会出现过程讲解。

以后每个 `v*` tag 必须先通过两层门禁，才允许创建 Release 资产：

1. GitHub 托管 runner 执行完整单元／协议测试、依赖与包审计、公开源码扫描。
2. 受保护的 `release-live` Environment 在标签为 `codex-local-router-release` 的专用 macOS runner 上执行 `e2e:release`；该机器本地具备当前 Codex App、订阅登录、Router 来源配置、Provider 凭证和 Tavily 凭证。

真实矩阵按等价类覆盖，不做模型 × 客户端 × 搜索源全排列：

| 用例 | 覆盖目的 |
|---|---|
| GLM Flash App＋订阅桥接 | 非 GPT 标准 Responses 函数、固定 OpenAI 搜索和 Provider 续接 |
| ai.feei Sol CLI＋订阅桥接 | GPT／Provider 回归和独立凭证链路 |
| ai.feei Sol App＋Tavily MCP | 客户端拥有的 MCP 发现、调用／结果和续接，Gateway 不接管 MCP 权限 |
| 官方 cached 默认 | 官方默认搜索行为不变 |
| 官方显式 live | 官方 live 覆盖行为不变 |

确定性画像另有五项本地 HTTP／WS、工具、生命周期和性能用例。整个真实门最多五个 turn、十七次模型生成和九次搜索；第三方阶段上限为 `3 / 8 / 3`，其中包含一次客户端 MCP 搜索及 deferred MCP 调用／结果闭环所需的四次发送；官方阶段为 `2 / 9 / 6`。当前 Codex 0.155 的搜索续接在 cached／live 两轮中可能合理多出一次唯一模型发送，但零重试和重复 payload 规则不变。重复 payload、被拦截请求、隐式重试、缺少用例、提交或 Codex 二进制不一致、MCP inventory 不完整、凭证串线或任何非 PASS 阶段都会拒绝 tag。各阶段顺序执行，首个失败即停止，避免本地缺陷继续消耗外部预算。

发布 runner 必须专用并受 Environment 审批保护；PR 不会在它上面运行真实凭证。OpenAI／Provider 凭证只存在于 runner 的本地登录、Keychain 或服务环境，不作为 workflow 输入。runner 服务必须显式具备 `TAVILY_API_KEY`，需要自定义 CA 时同时提供 `NODE_EXTRA_CA_CERTS`。机器回执写在 checkout 外，workflow 日志只记录哈希与脱敏摘要。App UI 仍单独人工签核，不作为 GitHub Release 的自动阻断项。

缓存亲和采用分阶段 fail-closed 门禁。缺省 `e2e:prompt-cache` 零外网，要求 HMAC 派生 p95 小于 5ms、请求体适配 p95 小于 25ms、Wire 增量小于 128 bytes。当前效果门使用 `--live-comparison --run`：Sol/Astra 共 24 次交错、零重试生成，在请求其余部分固定的条件下比较原始直连形态和候选匿名 key。随后 `--live-app-candidate --run` 使用当前 App 内置 Codex 二进制、临时 Codex/Router Home 和隔离 Gateway，Provider 生成不超过 6 次；每款模型必须完成一个只读 MCP call/result 和下一 turn，同时观察到匿名键指纹稳定、逐 frame Lite Header 正确且订阅/Provider 身份不串线。缺失 usage 记为未知，不记作 0。旧的 `--live-feasibility`、`--live-gateway` 和 `--live-app-protocol` 仍用于复查历史候选，不再构成本轮 30 次准出门。

历史 ai.feei 可行性尝试在第 1 次 control 请求收到 HTTP 403 后停止，该记录继续保留。后续 35 次因果诊断没有覆盖它：35 次合成请求全部完成，严格单变量对照中 Sol 从无 key 的 30.11% 加权缓存复用上升到 Gateway 匿名 key 的 98.55%。这证明特定工作负载下 Gateway 可控字段的效果，不证明 ai.feei 内部账号池算法，也不承诺自然会话固定命中率。以后任何修改缓存亲和的 Release 都必须重新通过 Sol/Astra 与 App 协议门，才能进入本机启用。

`e2e:tool-search-history` 先用当前 App 内置 app-server 验证新会话模型切换，再通过真实 Gateway HTTP 身份与加密归档边界复现受影响的存量 response 链。它只使用合成 auth/凭证、本地 Provider、注入的官方响应、随机端口和临时 Home；断言目标只收到一个固定标记，不收到动态 schema、查询或 Provider 标识，同时加密归档中的原 pair 保持字节等价。它不会重试真实会话，也不会连接任何外部上游。

官方搜索另有一个窄范围真实 canary：

```bash
npm run e2e:official-search -- --run
```

它先通过 Router 的生产级官方 WebSocket 客户端执行一次零生成握手探针并要求 HTTP 101，然后只运行两个隔离的官方订阅短 turn：第一轮不设置 `web_search`、不要求用户增加参数，验证 Codex 正常的 cached 默认模式；第二轮使用单次 `--search` 覆盖，验证 live 模式。两轮都必须看到当前 Codex 版本所选择的官方 Responses 传输成功、固定 OpenAI 目的地的 `/alpha/search` 成功、客户端 `web_search` 完成事件、回答中的来源 hostname，以及不存在第三方出站。预算固定为两个 turn、最多九次唯一生成发送和六次搜索（一次搜索 turn 可能包含多次模型与工具续接），不保存提示或回答正文。

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

完整画像准出由独立的确定性门禁承担：使用当前 App 内置 Codex 二进制和隔离本地夹具，分别证明 `standard-tools` 的核心/允许 Plugin/用户 MCP 实际调用与结果闭环，以及同一任务从官方切到第三方后 `lite-search` 的核心工具结果与完整搜索闭环。Lite 用例仍不声明具备 `standard-tools` 的完整 Plugin/MCP 工具面。不同画像的证据分开报告，不能拼接成一项能力结论。

所有过程使用临时 `HOME`、`CODEX_HOME`、XDG、Router Home/状态/历史、实例、工作区和随机端口。确定性门禁使用无害的合成 auth，不读取 Provider Key；显式 live canary 只把所需 Codex auth 以 0600 权限复制到隔离根目录，不软链接真实文件。Codex 子进程不会继承环境中的 Provider、代理、shell agent、App tools pipe 或自定义 CA 变量，除非用例显式提供无害夹具值。L0 另行验证整个测试进程树不能写真实 Codex、Router、LaunchAgent、MCP、Skill、Hook、提示或会话目录。

在 macOS 上，G3 live runner 会先在禁止写入真实 Codex、Router、已安装 Skill、LaunchAgent 和 Keychain 根目录的外层 sandbox 中重新启动自身；Codex 保持自身的只读 sandbox，并使用临时 Home。回执记录 sandbox profile 哈希，并把受管 catalog、空间索引和 pending 事务纳入前后权威边界。`models_cache.json` 发生变化时，只有已观察到 App 刷新、测试进程树无法写真实目录、权威状态未变且新缓存没有 Router 状态，Gateway Core 才能继续通过。

证据只保存模型/工具类型、来源标识、哈希、状态、数量、字节和耗时，不保存提示、回答、搜索查询/结果/URL、工具 schema、凭证、图片或本地绝对路径。默认输出位于 Router 数据目录下的 `evidence/`；`--out` 可指定其他私有目录，但不能指向源码树。原始证据不进入公开导出或 npm 包。用于准出的运行还会设置 `ACCEPTANCE_COMMIT`；Harness 会拒绝脏工作树或不一致的提交，并同时记录精确 commit 与 Git tree。run 目录和 JSON 回执只能创建一次，目标已存在时直接失败，不会覆盖旧证据。

G3 性能门禁对阈值保持宽松，但对证据完整性 fail closed。成功用例必须记录适用的本地路由/策略或透明 Relay setup、身份/历史、归档/观察、上游首字节、首个实质事件、首个文本、搜索、总耗时，请求/响应/工具字节，重试/重连、健康采样、event-loop 和最终生命周期。取消用例只有在已证明生成请求发出、随后在首字节/文本前关闭、响应字节与总时长仍完成结算且资源归零时，才能把未观察到的首字节/文本标成预期缺失；其他必填指标缺失直接阻断 Gateway Core。

真实渠道归因同样 fail closed。单次 HTTP 200 后流提前结束只能记为 `UNVERIFIED`，不能据此认定 Provider 降级。只有稳定的 Provider 状态/传输类别或等价隔离直连复现，并且身份、生命周期和重试/重放证据均干净时，才能记为 `EXTERNAL_DEGRADED`。

`UNVERIFIED` 只用于责任确实无法区分的外部失败。若本地路由、目的地凭证、catalog 真实性、图片/思考参数适配、已完成搜索结果回填或资源清理断言失败，必须记为 `GATEWAY_DEFECT` 并阻断 Gateway Core，不能借第三方渠道不稳定降级处理。

自动 app-server 验收不能替代 UI。最终报告必须把“实现完成”“自动验收通过”“本机已生效”“App UI 已确认”分开列出。

英文记录见 [release-v0.5.6.md](release-v0.5.6.md)。
