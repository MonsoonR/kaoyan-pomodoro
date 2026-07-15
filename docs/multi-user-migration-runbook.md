# 单账号升级为邀请码多用户：Kubernetes 生产迁移 Runbook

本文用于当前 Kubernetes 生产 SQLite 从旧单账号结构升级到多用户版本。API 启动时自动执行 Drizzle migrations；`0007`—`0009` 只向前迁移，没有可安全原地执行的 down migration，因此必须使用短维护窗口并同时停止 Web 和 API。

## 迁移内容

`0007_dapper_jackpot.sql`：

- 为现有 `users` 增加标准化用户名、角色、状态和强制改密字段；
- 将原账号原地标记为 `admin/active`，保留账号 ID、用户名、密码哈希和时间字段；
- 创建只保存邀请码 SHA-256 摘要的 `invitations`；
- 从全站单用户/单活动计时器约束迁移为每个用户一个活动计时器；
- 在改约束前验证所有私有表归属以及关联记录的用户一致性，失败时整个 migration 失败。

`0008_neat_doorman.sql` 增加同步查询复合索引。`0009_tearful_proudstar.sql` 将同步回执主键改为 `(user_id, operation_id)`；重建前再次检查设备和冲突所有者，全程不关闭外键，完成后运行 `foreign_key_check`。

## 1. 预检

1. 变更已经合并到应用仓库 `main`；API/Web/Backup 三张正式镜像来自同一个完整 main SHA，并分别取得真实 OCI digest。
2. 不把 `feature/invite-multi-user` 或其他 feature/PR 临时镜像写入生产清单或传给执行脚本。
3. 完整 CI、Drizzle check 和容器集成 smoke 已通过。
4. 使用最新已验证生产备份的离线副本演练 `0007`—`0009`，确认旧数据兼容、关键记录计数、管理员归属、`integrity_check` 和 `foreign_key_check`。
5. 运行 `scripts/update.sh --plan ...`，确认：
   - API/Web 当前健康；
   - API 为 1 副本且策略为 `Recreate`；
   - API/Web/Backup 均固定到 `guilyrh`，并具有 `deploy.sagirii.me/edge=true:NoSchedule` toleration；
   - `kaoyan-data` 与 `kaoyan-backups` 均为 `Bound`；
   - `kaoyan-pomodoro-certs` 为 `Ready`；
   - Backup CronJob 没有活动 Job；
   - 三张旧镜像、API/Web 副本数和 CronJob `suspend` 已记录。
6. 确认 GitOps 控制器不会在维护窗口内覆盖 kubectl 变更。

## 2. 冻结写入

执行脚本先挂起 Backup CronJob，然后按顺序：

```bash
kubectl -n kaoyan-pomodoro scale deployment/kaoyan-web --replicas=0
kubectl -n kaoyan-pomodoro scale deployment/kaoyan-api --replicas=0
```

必须等待旧 API Pod 完全终止，并确认没有 API Pod 仍挂载、写入 SQLite。只停止 Web 不够：已安装 PWA、旧页面或其他客户端仍可能直接访问 `/api`。

## 3. 创建升级前备份

冻结写入后，使用现有 CronJob 创建一次性 Job：

```bash
kubectl -n kaoyan-pomodoro create job \
  --from=cronjob/kaoyan-backup \
  kaoyan-backup-pre-update-<timestamp>
```

等待 Job `Complete` 且 `status.succeeded=1`。现有备份脚本使用 SQLite `.backup`，并在压缩前、gzip 后和解压后验证完整性。保留 Job 名称和状态记录；不要直接复制运行中的 SQLite 主文件。

## 4. 更新与迁移

在 API/Web 都为 0 时设置三张 digest-pinned 镜像。随后只恢复 API 单副本。新 API 启动时自动执行 Drizzle migrations；等待 API rollout 和 `/api/health/ready` 成功后，才恢复 Web。

正式执行统一使用：

```bash
bash scripts/update.sh --execute \
  --namespace kaoyan-pomodoro \
  --confirm-context '<PLAN显示的context>' \
  --confirm-execute 'UPDATE kaoyan-pomodoro ON <PLAN显示的context> TO <MAIN_SHA>' \
  --migration-check-passed \
  --main-sha <MAIN_SHA> \
  --api-image 'ghcr.io/monsoonr/kaoyan-pomodoro-api:sha-<MAIN_SHA>@sha256:<API_DIGEST>' \
  --web-image 'ghcr.io/monsoonr/kaoyan-pomodoro-web:sha-<MAIN_SHA>@sha256:<WEB_DIGEST>' \
  --backup-image 'ghcr.io/monsoonr/kaoyan-pomodoro-backup:sha-<MAIN_SHA>@sha256:<BACKUP_DIGEST>'
```

不要手工编辑 SQLite schema，不要关闭外键，不要在 migration 失败后跳过迁移版本。

## 5. 验收

1. API rollout、live 和 ready 成功，API Pod 位于 `guilyrh`，且仍只有一个 SQLite 写实例。
2. Web rollout 与首页成功，Web Pod 位于 `guilyrh`。
3. Certificate 仍为 `Ready`，Traefik Ingress 的正式 HTTPS 可访问。
4. 原用户名和密码可以登录，`/api/auth/me` 返回原账号 `role=admin`。
5. 原账号的任务、今日任务、专注记录、设置、统计、冲突、设备和同步历史数量与升级前一致。
6. 管理员能创建、列出和撤销短期邀请；列表和日志不含完整 token。
7. 使用一个测试邀请注册普通用户，确认看不到管理员数据和邀请管理，直接请求管理员 API 返回 403。
8. 两个账号分别执行一次 push/pull 和计时器操作，确认用户隔离。
9. Backup CronJob 恢复到更新前记录的 `suspend` 状态。

## 6. 失败和回滚边界

SQLite schema 降级可能破坏多用户数据，因此没有原地 down migration。

- migration 或 readiness 失败时，脚本保持 API/Web 为 0、Backup CronJob suspended，并打印升级前 Backup Job 和状态记录。
- 不自动执行 `kubectl rollout undo`，不自动切回旧镜像，不自动恢复旧 SQLite。
- 先保存失败日志和数据库现场，在备份副本上定位孤立数据、跨用户引用或镜像问题，形成可审核的向前修复方案。
- 若决定回到旧版本，必须把“旧应用镜像 + 升级前数据库”作为一个整体恢复；只换旧镜像不是数据库回滚。
- 只有在尚未接受升级后新用户/新业务写入，或明确批准丢弃这些数据时，才能人工恢复升级前备份。恢复前先备份失败现场。
- 创建任何新用户或业务记录后，恢复升级前备份都会丢数据，应停止回滚并优先向前修复。
- 若经单独审核决定接受数据丢失，使用 `scripts/k8s-restore-backup.sh` 先做 Plan；只有 API/Web 为 0、API Pod 为 0、Backup CronJob suspended、两个 PVC Bound 且精确确认字符串匹配时，才允许创建临时恢复 Pod。恢复脚本不会自动启动服务或切换镜像。

旧 Docker Compose 容器只为短期遗留回滚保留，不是本次更新目标；任何启动旧容器、切换入口或恢复旧数据库的操作都必须另行批准。

## 7. 上线后观察

关注 4xx/5xx、注册错误、migration/外键错误、同步冲突和数据库增长。日志不得记录密码、密码哈希、Cookie、会话令牌、邀请码 token、完整邀请 URL、kubeconfig、Kubernetes Token 或 Secret 内容。
