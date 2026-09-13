# 配置空间候选验收报告

日期：2026-09-13
实施基线：`de0548d`

已审查实现：`74752c6485a754dd6b55100d47b609839533c1c1`

发布候选：`v0.3.0`

## 结果

| 范围 | 结果 | 证据 |
|---|---|---|
| 功能实现 | 本机 v1 范围完成 | 不可变空间、受保护 official 历史、事务切换、一次性协调器、CLI 与文档均已实现 |
| 确定性自动验收 | PASS | 220/220 隔离 Node 测试通过 |
| 依赖审计 | PASS | 临时指定 npm 官方 registry 后报告 0 个漏洞 |
| 包与公开源码审计 | PASS | manifest 与完整公开树未发现禁止路径、绝对用户路径或凭证形态内容 |
| 干净公开导出 | PASS | 全新 `npm ci`、220/220 测试、包/公开树审计、pack、安装及双命令版本检查通过 |
| 真实模型调用 | 未执行 | live turn 为 0；按计划不运行 `e2e:focused -- --run` |
| 本机候选生效 | 未执行 | 未安装候选、未初始化真实空间、未启动服务、未改集成、未写 Keychain |
| Codex App UI | 未执行 | CLI/app-server 结果不替代菜单与 UI 签核 |

全部自动测试使用临时 Codex Home、Router Home、配置/状态/LaunchAgent 路径、测试实例 ID、模拟 launchctl、本地上游和随机端口。测试总入口固定 `CODEX_APP_RUNNING=0`；pending 用例只在自己的临时 fixture 内覆盖该值。

## 覆盖边界

- fresh、legacy applied/disabled、pending 与歧义迁移。
- 永久保留 `official@1`、official 自动追加、Router 不可变 revision、克隆、历史、diff、默认模型和 drift capture。
- official→Router、Router→Router、Router→official、历史版本激活，以及“上一次成功激活”回滚。
- App 运行只挂起、单次执行、登录恢复定义、切换互斥、协调器等待期间可取消、活跃轮次排空、来源/目标哈希核验、并发改动拒绝和可恢复失败。
- 凭证缺失、候选失败、服务失败与活跃轮次超时。
- 保留非受管 Codex 配置；revision/transaction 不包含订阅凭证、`auth.json`、用户 MCP、Skills、Hooks、提示与历史。
- 干净安装包中的正式命令与兼容别名。

## 真实环境保护

最终源码门禁前的只读检查显示：Router 与切换器 LaunchAgent 均未加载、8788 未监听、integration 为 `disabled`、Codex 使用内置 `openai` Provider。最终门禁后必须再次核对。用户当前选择的官方模型不是验收不变量，本候选不会改写它。

独立 `gpt-6-astra/high` 审查已在上述冻结实现提交上通过。仅包含版本和文档的发布提交会再次经过确定性测试与干净导出门禁；两者都不代表真实渠道或 App UI 已验收。
