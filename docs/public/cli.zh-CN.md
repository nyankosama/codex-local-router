# CLI 说明

新建且能力满足的第三方 App 模型默认采用 `codex-general-v1`，详见[第三方模型模板](third-party-templates.zh-CN.md)。多代理既可用 `--multi-agent-version v1|v2|client-default` 直接配置，也可继续从官方模型采集快照。

正式命令为 `codex-local-router`，`llm-auto-gateway` 是完全等价的兼容别名。`space init/list/current/show/history/diff/create/capture/set-default-model/set-search-source/set-third-party-template/use/rollback/resume/cancel` 用于管理完整配置组合和不可变 revision。

全新 `setup` 必须显式提供 `--preset`；也可用 `--config` 提供已存在的完整配置。两者都缺失时，在写入配置、凭证、空间或服务文件前失败。preset 未定义 ID 时使用中性 Provider/target ID。

完整日常流程、pending 切换、drift 恢复和数据边界见[配置空间指南](configuration-spaces.zh-CN.md)。

引用格式是 `NAME@REV`，省略 revision 表示最新版本。`official` 为只读保留空间；`space rollback` 回到上一次成功激活引用，不是版本号减一。`space capture` 是接纳当前 Router 配置 drift 的唯一入口；App/会话临时选模不会创建版本，只有 `space set-default-model` 会。

本次新增的模型参数：

- `model add|edit --template codex-general-v1|legacy`：选择创建模板；能力不满足时必须显式使用 `legacy`。
- `model apply-template --ids ID,... --template codex-general-v1|legacy`：为已有模型批量物化模板。
- `model add|edit --tool-mode code_mode_only|default`：显式启用代码模式或清除覆盖。
- `model set-tool-mode --ids ID,... --tool-mode code_mode_only|default [--space NAME] [--yes]`：批量预览/修改，一次只生成一个版本，不刷新指令快照。要求 App-enabled 第三方 Responses、工具调用和 freeform 工具支持，不再以 GPT 家族作为准入条件；`--no-app` 清除覆盖，不能与 `--tool-mode` 同传。诊断增加 `appCapabilityProfile.toolMode`。启用前必须检查实际工具上下文体积，详见[代码模式预检](configuration.zh-CN.md#显式启用-code-mode)。
- `--instructions-template codex-generic-v1`、`--instructions-file FILE`、`--instructions-from OFFICIAL_MODEL|none`：互斥的基础指令来源。
- `--subscription-search standard-tool|disabled`：为标准 Responses 选择订阅搜索桥接；它不等于 `--search-source`、`--native-search` 或 Lite。
- `--native-migration-summary` / `--no-native-migration-summary`：独立开启／关闭跨 target 的一次性、关闭工具的迁移摘要；不改变同 target 的 `--compression`，也不允许原生失败回退。
- `--no-freeform-tools`、`--shell-type shell_command|unified_exec`、`--default-reasoning-level LEVEL`：显式收敛 GLM 等 target 的工具和推理声明；冲突会在生成空间 revision 前失败。
- `--multi-agent-version v1|v2|client-default`：直接配置能力元数据；不覆盖用户的代理开关、权限和显式选模。
- `model sync-instructions --ids ID,... [--space NAME] [--yes]`：批量预览/同步，一次确认只生成一个空间版本。见[指令快照与当前 Lite 阻断](instruction-snapshots.zh-CN.md)。诊断会显示来源、哈希、状态和可同步更新；活动 Codex 选模与空间默认不一致时拒绝修改，不重置默认模型。

- `--model-family openai-gpt|other`
- `--plugin-policy passthrough|third-party-gpt-default|allowlist`
- `--allowed-plugins github,figma,...`（只用于显式 allowlist）
- `--app-profile standard-tools|lite-search`
- `--search-source subscription|provider|disabled`
- `--supports-search-tool` / `--no-supports-search-tool`（兼容别名，不能与新参数同时使用）
- `--responses-lite` / `--no-responses-lite`（兼容输入；与显式 profile 冲突时拒绝）

新建且能力满足、preset 已通过 Provider 准出的 App-enabled 第三方 target 会物化通用指令、`standard-tools`、Code mode、多代理 v2 和标准 Plugin 白名单；非 Responses、缺少 freeform 工具能力或 preset 明确收窄时拒绝通用模板。当前 `opencode-go/deepseek-v4.1-flash` 在未指定模板时自动选择 `legacy`，并拒绝 Code mode 与多代理覆盖。`lite-search` 仍需显式选择。旧 target 不因加载或升级被迁移。

`provider add|edit --standalone-search-endpoint RELATIVE_PATH` 显式配置 Provider 搜索端点；`provider edit --no-standalone-search-endpoint` 删除。`space set-search-source subscription|provider|disabled [--space NAME]` 修改该空间的第三方 GPT 默认来源。Provider 模式仍要求 App-enabled Responses target，且不存在自动回退。

远程明文 HTTP Provider 默认拒绝；必须在同次 `provider add|edit` 中显式传入 `--allow-insecure-http`，并可用 `--no-allow-insecure-http` 撤销这一持久授权。启用后，凭证和会话内容在传输途中可能被读取。

`provider add|edit --prompt-cache-affinity none|gateway-opaque` 配置兼容的第三方 Responses 缓存亲和。该能力缺省关闭，对 `openai-gpt`，或已显式物化 `codex-general-v1` 的非 GPT target 生效，并自然进入配置空间 revision、diff、capture 与 drift 检测。

`model list --json` 和非 live 的 `model probe --id ID --json` 会输出最终 Plugin 策略、App 能力画像/选择原因/工具面、独立搜索来源/原因、是否向 App 广告、Provider endpoint 与凭证就绪状态、缓存亲和模式/原因/载体/谱系能力/重启稳定性、有效名单和来源识别状态，不调用模型；`status --json`、`doctor --json` 也包含能力画像、搜索和缓存摘要。只有显式增加 `--live` 才消费 Provider 额度。

Provider、模型与 `config upgrade` 支持 `--space NAME`。缺省修改当前 Router 空间；当前为 `official` 时必须显式指定。每次确认修改生成不可变 revision；修改活动空间会启动切换，修改非活动空间只追加版本。

若 App 正在运行，切换只写 pending 事务并安装 `KeepAlive=false` 的一次性切换器；它等待 App 正常退出、执行一次后退出，不强退也不重开 App。`space resume` 恢复同一哈希绑定事务，`space cancel` 只能取消尚未应用或已成功恢复的事务。活动空间为 `official` 时拒绝启动 Router 服务。

Provider 凭证环境变量只供前台进程使用，不会写入受管 LaunchAgent；后台服务应使用 Keychain。网络边界例外仅包括代理变量，以及安装进程显式设置的 `NODE_EXTRA_CA_CERTS` 路径，以保证 WSS 与 HTTP 使用同一代理信任链；任意 `NODE_OPTIONS` 不会被复制。

完整英文命令参考见 [cli.md](cli.md)。

`history recover --thread THREAD_ID [--source ROLLOUT.jsonl]` 缺省只做脱敏预览。加 `--yes` 后要求 App 已退出且 Gateway 空闲；命令会停止已加载服务、复核所有来源哈希、原子写入可精确恢复的 checkpoint，并恢复原服务状态。`history inspect --thread THREAD_ID --target TARGET_ID --json` 只输出直接兼容、需要摘要和阻塞数量，不输出历史正文。详见 [Fork 与压缩历史恢复](compaction-recovery.zh-CN.md)。
