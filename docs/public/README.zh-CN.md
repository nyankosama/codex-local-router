# 文档总入口

[English](README.md)

按使用者身份选择文档。当前产品行为、维护者准出规则和冻结历史证据有意分层维护。

## 用户

- [Provider 接入与准出状态](providers.zh-CN.md)
- [配置空间](configuration-spaces.zh-CN.md)
- [第三方模型通用搜索](universal-search.zh-CN.md)
- [CLI 参考](cli.zh-CN.md)
- [兼容性与准出](compatibility.zh-CN.md)
- [Fork 与压缩历史恢复](compaction-recovery.zh-CN.md)

安装、验证和订阅救援命令从项目[中文 README](../../README.zh-CN.md)开始。

## 集成者

- [配置参考](configuration.zh-CN.md)
- [架构](architecture.zh-CN.md)
- [数据流向与隐私边界](data-flow.zh-CN.md)
- [第三方模型模板](third-party-templates.zh-CN.md)
- [基础指令快照](instruction-snapshots.zh-CN.md)
- [Provider 缓存亲和](provider-cache-affinity.zh-CN.md)
- [多代理兼容性](multi-agent-compatibility.zh-CN.md)
- [工具搜索历史迁移](tool-search-history-migration.zh-CN.md)

这些文档描述公开契约和限制。配置声明本身不能证明任意 Provider 已实现对应行为。

## 维护者

- [贡献说明](../../CONTRIBUTING.md)
- [Release 准出政策](acceptance.zh-CN.md)
- [开源维护边界](open-source-maintenance-boundaries.zh-CN.md)
- [安全策略](../../SECURITY.md)

真实渠道验收必须显式、预算受限，并与无凭证测试分开。App-server 证据不能替代 App UI 签核。

## 冻结证据

历史报告统一保存在 [evidence](evidence/README.zh-CN.md)。它们只代表标注的版本或候选，不代表当前 Release、本机服务状态或 Provider 当前健康度。
