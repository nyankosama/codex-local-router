# 配置空间

配置空间是一组可版本化的 Router 配置组合。它把 Provider、模型集合、第三方创建模板、默认模型、路由、Plugin 策略、搜索、压缩和订阅接入设置作为一个整体，支持查看、克隆、切换和回滚。

它不是独立 Codex 账号或完整沙箱。监听与访问控制、加密历史、资源限制、用户 MCP、Skills、Hooks、提示和会话仍属于机器或 Codex 自身，不会复制进空间。

```text
机器配置（共享）
  ├─ official@REV（受保护的官方订阅直连投影）
  ├─ default@REV （Router 渠道、模型和策略）
  └─ work@REV    （另一套 Router 组合）
          │
          └─ 唯一 active 引用；最多一个 pending 切换
```

## 安全初始化

`setup` 会在同一个确认事务中初始化空间；已有安装也可以显式执行：

```bash
codex-local-router space init
codex-local-router space current
codex-local-router space list
```

第一份可信官方投影成为永久保留的 `official@1`，已有 Router 配置导入为 `default@1`。如果当前状态存在歧义，例如 Codex 已被自定义但没有可信官方 baseline，初始化会失败关闭，不猜测应该恢复什么。

`official` 是保留空间，不能删除、改名或通过 Provider/model 命令编辑。从当前官方状态切出前，Router 会比较受管 Codex 字段；发生变化时自动追加一个不可变 official revision，但永远不会替换 `official@1`。

## 创建和编辑组合

先克隆空间，检查差异，再编辑非活动副本：

```bash
codex-local-router space create work --from default --yes
codex-local-router provider add --space work --id my-provider \
  --base-url https://api.example.com/v1 --credential-prompt --yes
codex-local-router model add --space work --id my-model \
  --provider my-provider --upstream-model upstream-model \
  --protocol responses --context-window 200000 \
  --input-modalities text --compression unsupported --yes
codex-local-router space set-default-model my-model --space work --yes
codex-local-router space diff default work
```

每次确认修改 Provider、模型、路由、Plugin、搜索、压缩或默认模型时，只有内容实际变化才追加不可变 revision。修改非活动空间不会改变当前安装。只在 Codex 会话里临时选择其他模型不会生成版本。

第三方 GPT 的独立搜索默认来源也属于 revision 和 drift 边界：

```bash
codex-local-router space set-search-source subscription --space work --yes
```

逐 target 覆盖和 Provider 搜索 endpoint 随 target/Provider 一起版本化；查询、结果、ChatGPT Token 和 Provider Key 永远不会复制进空间。

空间只保存凭证引用。隐藏输入会把 Provider 密钥存入 macOS Keychain，revision 只记录 service/account；使用环境变量时也只记录变量名。

## 不打断 Codex App 的切换

```bash
codex-local-router space use work --yes
codex-local-router status
```

切换会先验证目标和凭证引用，在随机回环端口预检候选，并把事务绑定到来源与目标哈希。若 Codex App 正在运行，命令只记录 pending 事务：不改 Codex 配置、不重启 Router、不强退也不重开 App。

一次性 `com.nyankosama.codex-local-router.space-switcher` LaunchAgent 会等待 App 正常退出，再排空 Router 活跃轮次、精确应用并验证事务，最后提交 active/previous 指针后退出。它的 `KeepAlive=false`。

可以显式查看或控制事务：

```bash
codex-local-router space current
codex-local-router space resume
codex-local-router space cancel --yes
```

`resume` 只重试同一个哈希绑定目标。目标不同、来源文件或 revision 已变化、已有另一个 pending 事务时都会拒绝。`cancel` 只能删除尚未应用的事务，或已经成功恢复的失败事务；不会丢弃尚未解决的恢复材料。

## 历史版本、回滚与 drift

```bash
codex-local-router space history work
codex-local-router space show work@2
codex-local-router space use work@2 --yes
codex-local-router space rollback --yes
```

省略 `@REV` 表示最新版本；显式 revision 会选择那份不可变内容。`rollback` 返回上一次成功激活的引用，不等于当前版本号减一。

手工修改活动 `config.json` 中的 Router 空间字段会形成 drift。此时切换停止，不会静默覆盖。审阅并确认改动有效后，再显式接纳：

```bash
codex-local-router space current
codex-local-router space capture
```

`space capture [NAME]` 会从验证后的 Router 空间字段创建不可变 revision；机器全局字段仍不进入该版本。

## 返回官方订阅

正常路径仍是事务切换：

```bash
codex-local-router space use official --yes
```

活动空间为 `official` 时 Router 服务不能启动。若正常协调器不可用，先正常退出 Codex App，再使用独立救援入口：

```bash
codex-local-router rescue --subscription --yes
```

救援会直接恢复永久保留的 `official@1` 并停止服务，不依赖 Router；因此明确要求 App 已关闭。

## 空间永远不包含什么

- ChatGPT 订阅 Token 或 `auth.json`；
- 明文 Provider 凭证；
- 用户配置的 MCP、Skills、Hooks 或提示；
- 会话历史或加密历史密钥；
- 机器监听、访问控制、历史存储、连接数、请求体和超时限制。

自动化可以使用 `codex-local-router status --json` 和 `doctor --json`。它们不调用模型，会报告 active、pending、latest revision、drift、默认模型和协调器状态。

全部命令见 [CLI 说明](cli.zh-CN.md)，Schema 与策略字段见[配置说明](configuration.zh-CN.md)。
