# 开源维护边界

Codex Local Router 保持一个开源仓库，但运行中的所有材料不都应进入源码或 npm 包。

```text
公开仓库  -> 产品代码、测试、CI、公开文档、源码维护工具
npm 安装包 -> 运行时代码、公开 CLI、确定性测试和随包 Harness
本机 Router  -> 配置空间、集成状态、加密历史、验收证据
私有运维    -> 凭证、原始验收数据、rollout 状态和恢复包
```

`package.json.files` 是运行包权威。公开源码导出先读取真实 `npm pack --dry-run --ignore-scripts --json` 清单，再追加测试、CI、贡献材料和源码维护工具，最后逐文件检查。路径越界、入选符号链接、认证/配置/历史/备份文件、原始证据、内部验收记录和疑似凭证内容均被拒绝。导出和审计不会删除或复用含数据或 `.git` 的目标。

验收输出默认进入 Router 数据目录下的 `evidence/`；`--out` 可指定其他私有目录，但不能指向源码树。已进入 Git 历史的证据不改写历史。维护者可执行 `node scripts/audit-public-history.mjs [REF]`，仅输出疑似路径和内容类别；结果需人工复核，必要时单独撤销凭证。

全新 setup 必须显式选择 preset，或用 `--config` 提供完整已有配置。公开示例使用中性 ID。Provider 专用 preset 和示例只是接入便利，不包含项目凭证、背书或对实时兼容性的证明。公开默认值改变不会迁移已有配置和不可变空间。

专项启用/回滚工具位于 `scripts/maintainer/`，必须显式传入 Provider/target ID。它们是公开源码维护工具，不是安装后 CLI 承诺。如果已保存 rollback 状态仍引用旧全局包，升级前先创建独立恢复入口：

```bash
node scripts/maintainer/prepare-legacy-recovery.mjs \
  --installed-root /absolute/path/to/old/codex-local-router \
  --state /absolute/path/to/rollback.json \
  --rollback-script cache-affinity-rollback \
  --out /absolute/private/path/recovery

node scripts/maintainer/prepare-legacy-recovery.mjs \
  --verify /absolute/private/path/recovery
```

回滚时执行 `manifest.json` 记录的命令。恢复包只复制 `package.json`、运行源码、脚本和已安装依赖，不复制 Codex 认证、Router 历史或用户数据目录。运行文件或 rollback 状态哈希变化后校验失败。永久逃生命令仍是：

```bash
codex-local-router rescue --subscription --yes
```

测试通过专用启动器注入 App 和服务替身。生产入口忽略历史测试环境开关。如果进程检查无法确定 Codex App 是否运行，只读状态返回 `appRunning: null`；安装、切换和恢复操作失败关闭。
