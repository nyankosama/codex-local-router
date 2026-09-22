# Codex Local Router Gateway Core Qualification Goal Spec

Status: approved execution contract for the next Goal run. This document is not
evidence that the Gateway currently passes. The previous run remains recorded in
[`acceptance.md`](acceptance.md) and must not be retroactively reclassified.

Contract revision: 2

## 1. Objective

Bring Codex Local Router to a quality level that can be safely enabled for local
Codex CLI and App use while keeping official subscription behavior transparent
and rollback reliable.

The next Goal must separate product correctness from external channel health:

```text
Gateway Core hard gates
  ├─ official subscription transparency
  ├─ deterministic third-party routing and isolation
  ├─ App protocol, tools, history, lifecycle and rollback
  └─ normal local performance health

Channel qualification
  ├─ ai.feei Sol / Astra
  └─ OpenCode Go / DeepSeek
       HEALTHY | EXTERNAL_DEGRADED | GATEWAY_DEFECT | UNVERIFIED
```

An external provider outage, timeout, quota failure, or provider-side refusal
does not by itself fail Gateway Core. It must still fail that channel's health
claim unless a later bounded run succeeds. A routing, identity, replay, protocol,
cleanup, or local-overhead defect attributable to the Gateway is a Core blocker.

The work is complete only when all Core gates have recorded verdicts, the exact
candidate has passed independent review, rollback has been verified, and the
real-machine gray run has passed with user sign-off. A pending user action must
be reported honestly and leaves this Local Use Ready objective incomplete.
GitHub or npm publication is not authorized by this Goal.

## 2. Harness Strategy

Use `$codex-harness-strategy` with `均衡 Auto + Auto` for the Goal run.

Requested role configuration:

| Role | Requested model / thinking | Scope |
| --- | --- | --- |
| Root / owner | `gpt-5.6-sol` / `xhigh` | Sole Writer; owns scope, risk, routing, implementation, evidence, and final judgment. |
| Independent Reviewer | `gpt-5.6-sol` / `xhigh` | Fresh, independent, read-only review of each frozen critical candidate. |
| Optional consultant or escalated Reviewer | `gpt-6-astra` / `xhigh` | Read-only diagnosis or review only after a concrete capability/evidence conflict is recorded. |

The same model family for Root and Reviewer is allowed only when the Reviewer has
an independent context and genuinely read-only boundary. It is not Root
self-review.

Preflight requirements:

- Observe and record the actual Root model and thinking. If they are not exactly
  `gpt-5.6-sol/xhigh`, stop before downstream execution; do not substitute.
- Confirm native Codex agents can dispatch an independent
  `gpt-5.6-sol/xhigh` Reviewer. Confirm `gpt-6-astra/xhigh` only if escalation is
  actually needed.
- Keep one Writer per scope. Reviewer and consultant cannot implement, commit,
  merge, deploy, publish, or expand authority.
- Work in a new Git worktree created from a committed baseline that contains this
  contract. If this contract has been integrated, use the then-current clean
  `master`; otherwise use the exact `codex/quality-gate-v2-contract` commit and
  record its one-document-only divergence from `master`. The authoring code
  baseline was `a4e579b`; if `master` has moved, inspect and reconcile the
  intervening diff before relying on prior evidence.
- Freeze candidate identity before every Review Gate. Bind a clean candidate to
  exact HEAD and tree hash; bind a dirty candidate to baseline, changed files,
  task diff, and artifact hashes.
- A mutation after PASS invalidates that PASS and requires deterministic
  re-verification and re-review.

Required start receipt:

```text
Runtime: Codex
策略: 均衡 Auto
预设: Auto + explicit Root override
Root: gpt-5.6-sol / xhigh (observed, not assumed)
计划角色: Root sole Writer + independent read-only Sol/xhigh Reviewer; Astra/xhigh only on documented escalation
Review Gate: capability-profile baseline; final exact candidate
升级链: affected review or unresolved hard unit only -> gpt-6-astra/xhigh
能力缺口: none or exact unsupported model/thinking/isolation/evidence capability
```

Required Review Gates:

1. **Capability-profile baseline**: after resolving the Standard Responses versus
   Responses Lite product contract and before dependent App/live work. Freeze the
   configuration semantics, deterministic tests, and compatibility behavior.
2. **Final candidate**: after all authorized fixes and automated gates. Freeze
   exact HEAD/tree and receipt hashes before the independent final review.

If a required Reviewer cannot run, report `待 Review Gate`; do not call the
candidate qualified, merge-ready, or ready for local activation.

## 3. Qualification Outcomes

Every final report and machine-readable receipt must provide these independent
outcomes:

| Outcome | Values | Meaning |
| --- | --- | --- |
| Gateway Core | `PASS` / `FAIL` | Product invariants and deterministic behavior. |
| Official Subscription | `PASS` / `FAIL` / `NOT_RUN` | Real official generation, search, relay, and identity behavior. |
| Channel Qualification | `HEALTHY` / `EXTERNAL_DEGRADED` / `GATEWAY_DEFECT` / `UNVERIFIED` | One verdict per provider/model path. |
| Local App Gray Run | `PASS` / `FAIL` / `NOT_RUN` | Real installed CLI/App behavior after user-approved activation. |
| Local Use Ready | `YES` / `NO` | Requires Core PASS, Official PASS, final review PASS, verified rollback, and Local App Gray Run PASS. |
| Release Ready | `YES` / `NO` | Requires Local Use Ready plus packaging/public-export gates; it does not publish anything. |

Do not collapse these into one PASS. In particular:

- `EXTERNAL_DEGRADED` does not fail Gateway Core, but that channel is not
  `HEALTHY` and must not be advertised as qualified.
- `UNVERIFIED` does not fail Core when deterministic coverage proves the same
  Gateway path and no invariant is violated; it still prevents a claim that the
  affected live channel is usable.
- `GATEWAY_DEFECT` always fails Core when the defect is in an in-scope product
  path.
- `Local Use Ready=YES` cannot be inferred from isolated App-server tests.

## 4. Product Capability Contract

### 4.1 Official subscription

Official subscription models and helper APIs remain transparent:

- Explicit third-party model mappings use the Engine only where required.
- All other `/subscription/v1/**` HTTP and WebSocket traffic uses the fixed-origin
  official relay to `https://chatgpt.com/backend-api/codex/`.
- Query strings, bodies, status, compression, SSE/WS ordering, cancellation, and
  error bodies are preserved within hop-by-hop transport rules.
- `/subscription/v1/alpha/search` remains official independent search and is not
  subjected to third-party Plugin filtering.
- `/v1/**` never receives subscription identity.
- Unknown future official helper paths must not require a local endpoint table.

### 4.2 Third-party GPT App profiles

The current Lite-only search constraint must be made explicit rather than hidden
inside validation. Qualify two product profiles:

| Profile | Required behavior | Default claim |
| --- | --- | --- |
| `standard-tools` | Standard Responses; Codex core tools, allowed Codex Plugins, and user MCP preserved according to policy. | Default third-party GPT App profile. Standalone search is not advertised unless the combined path is deterministically and live proven. |
| `lite-search` | Responses Lite plus configured independent search, normally the user's official subscription search. | Explicit opt-in. A reduced Plugin/MCP surface must be disclosed and must not be reported as full tool compatibility. |

Implementation may reuse the existing `app.useResponsesLite` representation, but
CLI/status/catalog/doctor output must expose the effective capability profile and
must not imply that both full Plugin/MCP and independent search were proven when
only one was observed.

Compatibility rules:

- Existing explicit Lite configurations retain their current behavior; do not
  silently migrate them to Standard Responses.
- New third-party GPT App configurations default to `standard-tools` unless the
  user explicitly selects Lite search.
- Do not switch profiles after an upstream failure, retry, reconnect, or tool
  request.
- If investigation proves that the current Codex client supports Standard
  Responses, the full tool surface, and independent subscription search together,
  the two profiles may share one implementation only after the capability-profile
  Review Gate passes with direct evidence.
- Official subscription models are outside this profile split and retain full
  transparent official behavior.

### 4.3 Plugin and user-defined behavior

- Codex core tools, `codex_app`, `cua_repl`, and Router-internal search tools are
  not treated as third-party Plugins.
- User-configured MCP, Skills, Hooks, and prompt text are not filtered or
  rewritten by the Codex Plugin allowlist.
- Confirmed Codex Plugin tools follow the configured allowlist. Unknown source or
  naming collisions are passed through with sanitized diagnostics.
- A filtered explicit `tool_choice` fails as `tool_policy_conflict` before send.
- A disallowed direct Plugin call is blocked before client execution and never
  triggers model fallback.

### 4.4 History, retries, and switching

- Preserve immutable original history separately from target views.
- Cross-provider history restoration fails closed when required evidence is
  incomplete; no silent summary or truncation.
- Once visible output or a tool side effect exists, do not retry, replay, fall
  back, or duplicate tool execution.
- Freeze route and capability profile per turn. Configuration reload affects only
  later turns.
- Official-to-third-party and third-party-to-official switching must preserve
  supported messages and tool results without leaking provider credentials.

## 5. Channel Attribution Contract

Classify each real third-party channel independently.

### `HEALTHY`

The bounded live case completes and proves destination, credential isolation,
protocol completion, cleanup, retry/reconnect counts, and required feature
evidence.

### `EXTERNAL_DEGRADED`

Use only when all of the following are true:

- The Gateway selected the expected target and sent the request only to the
  configured provider origin.
- Subscription credentials did not cross to the provider and the provider key
  did not cross to OpenAI.
- Local route/policy/setup and lifecycle health stayed within the health line or
  have a specific non-Gateway explanation.
- The upstream produced a stable provider-side status, timeout, reset, quota, or
  refusal category, or an equivalent direct isolated probe reproduces the same
  failure shape without weakening identity rules.
- No hidden retry, fallback, profile switch, duplicate side effect, or leaked
  active turn occurred.

Provider model-list visibility is not inference authorization and cannot prove a
channel healthy.

### `GATEWAY_DEFECT`

Use when routing, payload adaptation, identity, response handling, replay,
cleanup, observability, or local overhead violates this contract. Enter the
patch loop and fail Gateway Core.

### `UNVERIFIED`

Use when evidence cannot distinguish provider, network/proxy, Codex client, or
Gateway ownership. Preserve the evidence and do not retry until a new concrete
hypothesis exists. This is not a channel PASS.

## 6. Gate Sequence

### G0 - Safety, isolation, and reversibility

Required:

- Tests isolate the full process tree with temporary `HOME`, `CODEX_HOME`, XDG,
  Router home, config/state/history paths, instance ID, workdir, and random ports.
- Provider, proxy, shell-agent, app-tools-pipe, and other ambient credential
  variables are stripped unless a fixture explicitly supplies a harmless value.
- Tests cannot write the real Codex, Router, LaunchAgent, Keychain, MCP, Skills,
  Hooks, prompts, or session-history roots.
- Official direct mode has one documented rollback command or script and a
  verified source snapshot/hash.
- Real `config.toml`, integration state, Router config, LaunchAgents, and port
  state are recorded before and after every real-machine phase.

`models_cache.json` is an App-owned mutable cache, not a stable configuration
authority. Its hash drift is an observation, not an automatic FAIL, when all of
these are true:

- Codex App was running or a known App refresh occurred;
- the test process tree was write-denied from the real Codex root;
- no Gateway/integration operation targeting the real installation ran;
- authoritative managed files and service state stayed unchanged; and
- the receipt records before/after hash, size, mtime, and the lack of direct
  writer attribution.

It remains a hard FAIL if a test or unauthorized Gateway action writes the cache,
if authoritative files drift, or if the cache introduces Router state while the
real installation is required to remain official-direct. Process-level writer
attribution is useful diagnostics but is not required for G0 PASS under the
conditions above.

### G1 - Deterministic Core

Use local fixtures only. Cover:

- HTTP/WS official relay fidelity, future helper paths, query preservation,
  compression, streaming, errors, cancellation, backpressure, and cleanup.
- Path/origin constraints and bidirectional credential isolation.
- Third-party Responses and Chat routing, model mapping, image/freeform tools,
  reasoning levels, and no silent fallback.
- Search lease selection for official, provider, disabled, expired, missing, and
  concurrent-session cases.
- Plugin source classification, allowlist, user MCP preservation,
  `additional_tools`, idempotence, tool-choice conflict, and blocked call/result
  closure.
- History observation, restart, duplicate request, cross-provider recovery,
  compression, prewarm, and virtual-state boundaries.
- Configuration spaces, drift/capture, rollback, service guards, both CLI aliases,
  public export, package install, and test isolation.

Any invariant failure is Gateway Core FAIL.

### G2 - App protocol and capability profiles

Use the current App-bundled Codex binary with isolated roots and local simulated
upstreams. Record binary version and SHA-256.

Required:

- CLI and `app-server --stdio` coverage, including HTTP and WebSocket paths.
- Same-connection official/third-party switching, prewarm, cancel, disconnect,
  reconnect semantics, and active-turn cleanup.
- `standard-tools`: direct evidence that core tools, one allowed Plugin, and one
  user MCP definition/call/result reach the correct participants and affect the
  subsequent answer; one forbidden Plugin is absent.
- `lite-search`: completed independent search item/result/source evidence and a
  truthful reduced-tool capability report.
- If a combined Standard+search path is claimed, both evidence sets must occur in
  the same frozen profile and turn chain. Separate turns cannot be combined into
  one capability claim.

`turn.completed`, menu visibility, HTTP 200, or final prose alone is insufficient.

### G3 - Isolated live canary

Run only after G0-G2 and the capability-profile Review Gate pass. Use temporary
Router home, `CODEX_HOME`, state/history, random port, synthetic public inputs,
and redacted artifacts. No automatic live retry.

#### G3A - Blocking official canary

At minimum:

1. Official subscription CLI generation and independent search without forcing a
   user search setting that normal Codex usage would not require.
2. Official subscription WS/App-protocol turn, cancel/close, and cleanup.

Both must prove OpenAI-only destination and completed search/tool evidence where
applicable. Failure blocks Official Subscription and Local Use Ready.

#### G3B - Non-blocking channel qualification

Probe each configured third-party family only within the approved budget:

- ai.feei Sol or Astra: generation and the explicitly selected App profile.
- OpenCode Go/DeepSeek: multimodal/reasoning path and explicit search policy.

Each path receives one channel verdict. `EXTERNAL_DEGRADED` and `UNVERIFIED` do
not fail Core unless a Core invariant is violated; `GATEWAY_DEFECT` does.

Default budget for the entire G3 run:

- at most 5 short turns and 10 model generations;
- search helper calls counted separately, at most 4;
- at most one manually justified rerun after preserving the first failure and
  recording a new hypothesis;
- no private mail, history, repository content, raw tool schemas, raw search
  results, credentials, or full local paths in artifacts.

Changing this budget requires explicit approval.

### G3.5 - Performance health

This is a normal-health and attribution gate, not a performance-optimization
goal. Record per case:

- local route, policy, request-setup, archive, and relay setup time;
- upstream time to first byte, first substantive event, first token, search time,
  and total time;
- request/response/tool byte counts;
- retry/reconnect count;
- health p95, event-loop p99, active turns after completion, and remaining WS
  connections.

Soft health lines:

- Local route + policy + setup p95 should normally be <= 300 ms.
- Health endpoint p95 should normally be <= 1000 ms.
- Event-loop delay p99 should normally be <= 200 ms.
- Active turns should return to zero and WS connections should close within 30 s.
- One reconnect is a warning requiring cause; two or more in one turn is an
  anomaly.
- Tool schemas above roughly 250 KiB require attribution but are not by
  themselves a failure.

An explained provider/network delay can classify a channel as
`EXTERNAL_DEGRADED` without failing Core. Unexplained local amplification,
blocking archive/identity work, leaked lifecycle state, repeated hidden retries,
or Gateway-dominated latency is a Core FAIL. Do not require third-party latency
to match official latency.

### G4 - User-approved real-machine gray run

G4 is required for `Local Use Ready=YES`, but it requires a separate explicit
user confirmation immediately before real-machine activation.

Before asking:

- G0-G3.5 and the final candidate Review Gate must pass for Core and official
  paths.
- Prepare and verify the exact rollback command against an isolated copy.
- Record the installed CLI/source version and detect any candidate/install drift.

After approval:

1. Confirm there are no other active Codex tasks and no Gateway active turns.
2. Record authoritative config/integration/catalog metadata, LaunchAgents, port
   state, active space, and rollback command.
3. Enable the reviewed candidate transactionally. Never force-quit or
   automatically reopen Codex App.
4. Ask the user to close/reopen the App when required, then validate CLI, a new
   App task, 3-5 short App tasks, one cancel, one fresh task after reconnect, one
   official search, and one model switch if a healthy third-party channel exists.
5. Stop and roll back on credential crossing, repeated reconnect, duplicate side
   effects, unknown local error, service/config drift, or failed rollback guard.
6. Confirm official-direct recovery. Leave Gateway active only after explicit
   user confirmation.

If a third-party provider is externally degraded, G4 may still qualify Gateway
Core and official-through-Gateway operation, but that provider remains
unqualified and must be disabled or clearly excluded from the ready set.

### G5 - Packaging and public-export readiness

Run clean-export install, tests, package audit, secret/path scan, and both command
aliases. Update the bilingual public configuration, capability, compatibility,
data-boundary, acceptance, and Unreleased changelog documentation for the exact
implemented profile semantics. G5 may set `Release Ready=YES`; it does not
authorize merge, tag, GitHub Release, npm publication, or installation outside
G4.

## 7. Required Commands and Evidence

Run the existing commands when valid; repair or add deterministic coverage before
claiming a missing gate is executable:

```bash
npm test
npm audit --omit=dev --registry=https://registry.npmjs.org
npm run audit:package
node scripts/audit-public.mjs
git diff --check
npm run e2e:l0
npm run e2e:l1
npm run e2e:l2
```

Live commands require the G3 budget and real credentials; G4 requires the
separate activation confirmation:

```bash
npm run e2e:official-search -- --run
npm run e2e:third-party-search -- --run
```

Every run writes a new immutable directory under `artifacts/e2e/<runId>/` with:

- exact baseline/candidate HEAD and tree;
- harness binary path/version/SHA-256;
- configuration hashes without credential values;
- per-case route, identity, timings, byte counts, lifecycle, and verdict;
- Core/official/channel/local-use/release outcomes;
- patch records and Review Gate identities;
- redaction scan result.

`docs/e2e/quality-gate/acceptance.md` keeps prior run evidence and receives a new
dated section for the new candidate. Never edit a previous receipt to make a new
candidate pass.

## 8. Patch Loop

For each Core FAIL or performance anomaly:

1. Freeze evidence.
2. Classify layer: config, catalog, identity, router, policy, relay, adapter,
   search, history, archive, App protocol, upstream, proxy, or environment.
3. Decide `GATEWAY_DEFECT`, `EXTERNAL_DEGRADED`, or `UNVERIFIED` using Section 5.
4. Identify the violated criterion and blast radius.
5. Make one coherent in-scope fix only for Gateway defects.
6. Run the affected deterministic test, G0 safety checks, and any dependent gate.
7. Re-run the failed live case only when a new concrete hypothesis justifies the
   single permitted rerun.
8. Update the new receipt and acceptance section.

Do not patch around external instability, forge official-client identity, add a
hidden proxy exception, relax assertions, switch capability profiles silently,
or retry until an upstream happens to pass.

Patch record:

```json
{
  "patch": "",
  "case": "",
  "layer": "",
  "classification": "GATEWAY_DEFECT|EXTERNAL_DEGRADED|UNVERIFIED",
  "rootCause": "",
  "criteria": [],
  "files": [],
  "checks": [],
  "before": "",
  "after": "",
  "reruns": 0
}
```

## 9. Stop and Pause Conditions

Stop and report before expanding scope when a fix would require:

- changing this qualification contract, loosening assertions, or rewriting
  frozen evidence;
- adding a provider, protocol, dependency, external search service, or network /
  proxy / TLS exception outside the current design;
- changing history schema, deleting recovery copies, rotating credentials, or
  modifying user MCP, Skills, Hooks, prompts, or sessions;
- force-quitting/reopening Codex App or interrupting another active task;
- exceeding the approved live budget;
- merging, installing, publishing, tagging, or releasing without separate
  authority.

External channel degradation is not a terminal Goal blocker. Classify it,
preserve evidence, exclude that channel from the ready set, and continue Core and
official qualification. Waiting for the user's G4 action is `NEEDS_USER`, not a
Core failure; keep the Goal active and ask for the action. Declare the Goal
blocked only after the applicable Goal-tool blocked threshold is actually met.

## 10. Completion Contract

The Goal may be marked complete only when:

- Gateway Core is PASS;
- Official Subscription is PASS;
- required capability-profile and final Review Gates PASS on the exact accepted
  candidates;
- rollback is verified;
- G4 is PASS and therefore Local Use Ready is YES;
- every channel is individually classified and no `GATEWAY_DEFECT` remains;
- G5 passes if `Release Ready=YES` is claimed;
- real installed state and App UI status are reported separately; and
- no pending work is described as complete.

If the user chooses to stop before G4, the deliverable may be an automated-gates
candidate, but the Goal is not complete under this Local Use Ready objective.

## 11. Goal Driver Prompt

Use the prompt below in the new Goal. Do not use it to resume or rewrite the
previous failed receipt.

```text
按 /Users/liangruihe/Workspace/project/side-project/llm-auto-gateway/docs/e2e/quality-gate/goal_spec.md 执行 Codex Local Router Gateway Core 质量准出，目标是最终达到 Local Use Ready=YES，而不是要求所有外部渠道都稳定。

使用 $codex-harness-strategy，策略固定为“均衡 Auto”，预设为 Auto。Root 必须实际运行在 gpt-5.6-sol / xhigh；启动时核验并输出 Skill 要求的 start receipt，若无法观察到或不是该组合，在任何下游执行前停止，不得静默替换。Root 是唯一 Writer。关键能力画像基线和最终候选各设置一次 Review Gate，均使用独立、全新、只读的 gpt-5.6-sol / xhigh Reviewer，并把 PASS/问题绑定到精确 HEAD、tree 和证据哈希；候选变更后必须重新验证和复审。只有记录到明确的能力失败或证据冲突时，才允许用 gpt-6-astra / xhigh 做只读咨询或受影响单元的升级审查。

从包含本契约的已提交基线创建新的 codex/ 分支和同级 Git worktree：若本契约已进入 master，则使用届时干净 master；否则使用 codex/quality-gate-v2-contract 的精确 HEAD，并记录它相对 master 只有本契约文档差异。保留现有 worktree、本机官方直连配置、Codex App、Keychain 和服务状态。先重验基线，再按 G0 -> G1 -> capability-profile Review Gate -> G2 -> G3A/G3B -> G3.5 -> final Review Gate -> G4 -> G5 推进。G3 真实调用受文档预算约束，不得自动重试。G4 修改真实机器前必须停下来取得我的明确确认；不得强退或自动重开 Codex App。

准出结论必须拆分为 Gateway Core、Official Subscription、逐渠道 Channel Qualification、Local App Gray Run、Local Use Ready、Release Ready。ai.feei.cn 或 OpenCode Go 的上游超时、配额、拒绝或偶发不可用，在满足归因契约时记为 EXTERNAL_DEGRADED，不阻断 Gateway Core，但该渠道不得记为 HEALTHY 或纳入 ready set；只有可归因于 Gateway 的路由、身份、适配、重试/重放、清理或本地性能问题才记为 GATEWAY_DEFECT 并进入 patch loop。证据不足记 UNVERIFIED，不靠重试凑 PASS。

把第三方 GPT App 能力明确为 standard-tools 与 lite-search：默认 standard-tools 保留核心工具、允许的 Plugin 和用户 MCP；lite-search 为显式选择并如实披露工具面。若要宣称 Standard Responses、完整工具面和独立订阅搜索可同时工作，必须在同一冻结能力画像中提供确定性和真实证据；不得拼接不同 turn 的证据或失败后静默切 profile。官方订阅路径始终透明，不参与该 profile 拆分。

性能只按正常健康线和归因判定，不做性能优化目标，也不要求第三方延迟等于官方。models_cache.json 作为 App 可变缓存按 G0 条件记录漂移，不再要求必须定位写入 PID；真实权威配置、集成、LaunchAgent、端口或隔离边界发生未授权变化仍为硬失败。

任何修复都遵守 patch loop；外部渠道波动不能通过产品补丁掩盖。新证据写入新的 artifacts/e2e/<runId>/，在 docs/e2e/quality-gate/acceptance.md 追加新候选结论，不改写上一轮 receipt。未获得单独授权不得 merge、安装、发布 GitHub Release 或 npm 包。不得把自动门禁、App-server、待用户操作、待独立审查或外部渠道未验证写成完成。
```
