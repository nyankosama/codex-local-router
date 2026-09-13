# CLI 说明

正式命令为 `codex-local-router`，`llm-auto-gateway` 是完全等价的兼容别名。新增 `space init/list/current/show/history/diff/create/capture/set-default-model/use/rollback/resume/cancel`，用于管理完整配置组合和不可变 revision。

完整日常流程、pending 切换、drift 恢复和数据边界见[配置空间指南](configuration-spaces.zh-CN.md)。

引用格式是 `NAME@REV`，省略 revision 表示最新版本。`official` 为只读保留空间；`space rollback` 回到上一次成功激活引用，不是版本号减一。`space capture` 是接纳当前 Router 配置 drift 的唯一入口；App/会话临时选模不会创建版本，只有 `space set-default-model` 会。

本次新增的模型参数：

- `--model-family openai-gpt|other`
- `--plugin-policy passthrough|third-party-gpt-default|allowlist`
- `--allowed-plugins github,figma,...`（只用于显式 allowlist）
- `--supports-search-tool` / `--no-supports-search-tool`
- `--responses-lite` / `--no-responses-lite`

`model list --json` 和非 live 的 `model probe --id ID --json` 会输出最终 Plugin 策略、选择原因、有效名单和来源识别状态，不调用模型。只有显式增加 `--live` 才消费 Provider 额度。

Provider、模型与 `config upgrade` 支持 `--space NAME`。缺省修改当前 Router 空间；当前为 `official` 时必须显式指定。每次确认修改生成不可变 revision；修改活动空间会启动切换，修改非活动空间只追加版本。

若 App 正在运行，切换只写 pending 事务并安装 `KeepAlive=false` 的一次性切换器；它等待 App 正常退出、执行一次后退出，不强退也不重开 App。`space resume` 恢复同一哈希绑定事务，`space cancel` 只能取消尚未应用或已成功恢复的事务。活动空间为 `official` 时拒绝启动 Router 服务。

完整英文命令参考见 [cli.md](cli.md)。
