# CLI 说明

正式命令为 `codex-local-router`，`llm-auto-gateway` 是完全等价的兼容别名。`space init/list/current/show/history/diff/create/capture/set-default-model/set-search-source/use/rollback/resume/cancel` 用于管理完整配置组合和不可变 revision。

完整日常流程、pending 切换、drift 恢复和数据边界见[配置空间指南](configuration-spaces.zh-CN.md)。

引用格式是 `NAME@REV`，省略 revision 表示最新版本。`official` 为只读保留空间；`space rollback` 回到上一次成功激活引用，不是版本号减一。`space capture` 是接纳当前 Router 配置 drift 的唯一入口；App/会话临时选模不会创建版本，只有 `space set-default-model` 会。

本次新增的模型参数：

- `--model-family openai-gpt|other`
- `--plugin-policy passthrough|third-party-gpt-default|allowlist`
- `--allowed-plugins github,figma,...`（只用于显式 allowlist）
- `--app-profile standard-tools|lite-search`
- `--search-source subscription|provider|disabled`
- `--supports-search-tool` / `--no-supports-search-tool`（兼容别名，不能与新参数同时使用）
- `--responses-lite` / `--no-responses-lite`（兼容输入；与显式 profile 冲突时拒绝）

新建 App-enabled Responses `openai-gpt` target 会持久化 `standard-tools`、标准 Responses和禁用的独立搜索；非 Responses target 保持未画像。`lite-search` 必须显式选择，使用 Responses Lite 和 target/空间选定的搜索来源。`--no-app` 会清理全部 target 级 App 画像/搜索状态，同时保留 target 的路由能力并从 App 隐藏；不能同时传入 App 画像或搜索参数。既有显式或旧策略推导出的 Lite 配置保持原行为。

`provider add|edit --standalone-search-endpoint RELATIVE_PATH` 显式配置 Provider 搜索端点；`provider edit --no-standalone-search-endpoint` 删除。`space set-search-source subscription|provider|disabled [--space NAME]` 修改该空间的第三方 GPT 默认来源。Provider 模式仍要求 App-enabled Responses target，且不存在自动回退。

`model list --json` 和非 live 的 `model probe --id ID --json` 会输出最终 Plugin 策略、App 能力画像/选择原因/工具面、独立搜索来源/原因、是否向 App 广告、Provider endpoint 与凭证就绪状态、有效名单和来源识别状态，不调用模型；`status --json`、`doctor --json` 也包含能力画像与搜索摘要。只有显式增加 `--live` 才消费 Provider 额度。

Provider、模型与 `config upgrade` 支持 `--space NAME`。缺省修改当前 Router 空间；当前为 `official` 时必须显式指定。每次确认修改生成不可变 revision；修改活动空间会启动切换，修改非活动空间只追加版本。

若 App 正在运行，切换只写 pending 事务并安装 `KeepAlive=false` 的一次性切换器；它等待 App 正常退出、执行一次后退出，不强退也不重开 App。`space resume` 恢复同一哈希绑定事务，`space cancel` 只能取消尚未应用或已成功恢复的事务。活动空间为 `official` 时拒绝启动 Router 服务。

Provider 凭证环境变量只供前台进程使用，不会写入受管 LaunchAgent；后台服务应使用 Keychain。网络边界例外仅包括代理变量，以及安装进程显式设置的 `NODE_EXTRA_CA_CERTS` 路径，以保证 WSS 与 HTTP 使用同一代理信任链；任意 `NODE_OPTIONS` 不会被复制。

完整英文命令参考见 [cli.md](cli.md)。
