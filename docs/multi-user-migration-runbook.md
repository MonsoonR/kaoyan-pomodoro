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

## 1. 先选择正确路径

统一入口是 `scripts/k8s-update.sh`，固定生产 context 为 `nzfklii-kite`。不要根据旧 Runbook 假设 API/Web 仍在运行；先执行：

```bash
bash scripts/k8s-update.sh --status --namespace kaoyan-pomodoro
```

随后只能选择以下一种路径：

- 日常保留数据库更新：API/Web 正常运行，现有数据和管理员必须保留，使用默认 `preserve`。
- 一次性空库重建：API/Web 已为 0、Backup 已挂起、无活动 Job，而且 SQLite/WAL/SHM 已经由单独维护动作删除，才显式使用 `--database-mode reset-empty`。
- 中断续跑：`ConfigMap/kaoyan-update-state` 已记录未完成阶段，使用 `--resume`，不能重新发起 `--execute`。

`reset-empty` 不会删除数据库；如果数据 PVC 仍有主文件、WAL 或 SHM，它会拒绝。不得通过增加自动删除逻辑、关闭外键或跳过检查来绕过拒绝。

## 2. 共同预检

1. 变更已经合并到应用仓库 `main`；API/Web/Backup 三张正式镜像来自同一个完整 40 位 main SHA，并分别取得真实 OCI digest。
2. 不把 feature/PR tag、短 SHA、`latest` 或只带 tag 未固定 digest 的镜像传给脚本。
3. 完整 lint、typecheck、test、build、Drizzle check 和部署脚本测试已通过。
4. 两个 PVC `Bound`、Certificate `Ready`、API 为 `Recreate`；API/Web/Backup 模板固定到 `guilyrh` 并包含 edge toleration。
5. Backup CronJob 没有活动 Job；确认 GitOps 不会在维护窗口内覆盖直接 kubectl 变更。
6. migrations `0007`—`0009` 全程保持 foreign keys，禁止手工编辑 schema、down migration 或跳过 migration 版本。

Plan 严格只读，不创建 PVC 检查 Pod。API 为 0 时，Kubernetes API 本身无法显示 PVC 内文件；因此 `reset-empty` 的 Plan 只判定“候选路径”，正式执行在改变 Deployment/CronJob 之前才用受限临时 Pod 强制验证空数据卷和安全备份。

## 3. 日常 preserve 迁移

先使用新 SHA 和真实 digest 运行 `--plan`。正常现场必须看到 `selected flow: new-preserve`，API/Web healthy，数据库主文件存在：

```bash
bash scripts/k8s-update.sh --plan \
  --namespace kaoyan-pomodoro \
  --main-sha <MAIN_SHA> \
  --api-image 'ghcr.io/monsoonr/kaoyan-pomodoro-api:sha-<MAIN_SHA>@sha256:<API_DIGEST>' \
  --web-image 'ghcr.io/monsoonr/kaoyan-pomodoro-web:sha-<MAIN_SHA>@sha256:<WEB_DIGEST>' \
  --backup-image 'ghcr.io/monsoonr/kaoyan-pomodoro-backup:sha-<MAIN_SHA>@sha256:<BACKUP_DIGEST>'
```

使用最新已验证生产备份的离线副本演练 `0007`—`0009`，确认旧数据兼容、关键记录计数、管理员归属、`integrity_check=ok` 和 `foreign_key_check` 无结果。完成后执行：

```bash
bash scripts/k8s-update.sh --execute \
  --namespace kaoyan-pomodoro \
  --confirm-context nzfklii-kite \
  --confirm-execute 'UPDATE kaoyan-pomodoro ON nzfklii-kite TO <MAIN_SHA> USING preserve' \
  --migration-check-passed \
  --main-sha <MAIN_SHA> \
  --api-image 'ghcr.io/monsoonr/kaoyan-pomodoro-api:sha-<MAIN_SHA>@sha256:<API_DIGEST>' \
  --web-image 'ghcr.io/monsoonr/kaoyan-pomodoro-web:sha-<MAIN_SHA>@sha256:<WEB_DIGEST>' \
  --backup-image 'ghcr.io/monsoonr/kaoyan-pomodoro-backup:sha-<MAIN_SHA>@sha256:<BACKUP_DIGEST>'
```

脚本在停写前完成镜像拉取检查；随后挂起 Backup，停止 Web 和 API，创建确定名称且可复用的升级前 Backup Job，切换三张镜像，先启动 API 并等待 migrations/rollout/readiness，再启动 Web、验证 HTTPS，最后恢复原 CronJob suspend 状态。只停 Web 不构成停写。

## 4. 当前空库现场的一次性重建

2026-07-16 已知维护现场是 API/Web=0、Backup `suspend=true`、无活动 Job、数据目录空，并保留已验证安全备份 `kaoyan-20260716T023824338082865Z-daily.sqlite.gz`。这些是现场交接信息，正式操作前仍要重新运行 Status/Plan；不要写死任何旧应用提交。

完成后续本地开发、合并 `main`、等待新镜像发布并核对 digest 后，使用：

```bash
bash scripts/k8s-update.sh --plan \
  --namespace kaoyan-pomodoro \
  --database-mode reset-empty \
  --backup-file kaoyan-20260716T023824338082865Z-daily.sqlite.gz \
  --main-sha <未来最终MAIN_SHA> \
  --api-image 'ghcr.io/monsoonr/kaoyan-pomodoro-api:sha-<未来最终MAIN_SHA>@sha256:<API_DIGEST>' \
  --web-image 'ghcr.io/monsoonr/kaoyan-pomodoro-web:sha-<未来最终MAIN_SHA>@sha256:<WEB_DIGEST>' \
  --backup-image 'ghcr.io/monsoonr/kaoyan-pomodoro-backup:sha-<未来最终MAIN_SHA>@sha256:<BACKUP_DIGEST>'
```

执行命令必须逐字加入 Plan 打印的三条确认：更新目标、空库模式和安全备份文件。执行前置 Pod 会验证：API/Web 副本和 Pod 都为 0、Backup 已挂起且无活动 Job、SQLite/WAL/SHM 均不存在、指定备份为非符号链接普通文件且 gzip/SQLite 完整性/外键检查通过。随后才切换三张镜像，并用新 API 镜像在 `kaoyan-data` 上执行全部 migrations。

migration 完成后主脚本以退出码 75 安全暂停在 `awaiting-admin-init`，不会启动 API 或 Web。

## 5. 管理员初始化

只运行主脚本打印的精确命令：

```bash
bash scripts/k8s-admin-init.sh \
  --namespace kaoyan-pomodoro \
  --main-sha <未来最终MAIN_SHA> \
  --confirm-context nzfklii-kite \
  --confirm-init 'INITIALIZE ADMIN IN kaoyan-pomodoro ON nzfklii-kite FOR <未来最终MAIN_SHA>'
```

辅助脚本从持久状态读取目标 API 镜像，在挂载 `kaoyan-data` 的一次性 TTY Pod 中运行 `node dist/cli/account.js init`。不要把用户名或密码追加到命令行，也不要通过 env、ConfigMap、Secret 或重定向日志传入。密码只在 TTY 隐藏输入。成功后状态变为 `admin-initialized`，但 API/Web 仍保持 0。

## 6. 中断续跑

Kite Terminal 断开、当前目录变化或 `/tmp` 清空都不会丢失阶段；恢复依据是 `ConfigMap/kaoyan-update-state` 加真实 Deployment/CronJob/Pod 状态。运行：

```bash
bash scripts/k8s-update.sh --resume \
  --namespace kaoyan-pomodoro \
  --confirm-context nzfklii-kite \
  --confirm-execute 'UPDATE kaoyan-pomodoro ON nzfklii-kite TO <MAIN_SHA> USING <preserve或reset-empty>'
```

Resume 会复用确定名称的升级前 Job 或 migration Pod，比较镜像后再决定是否 set image，比较副本后再决定是否 scale，并从数据库事实判断管理员是否已经初始化。支持以下恢复点：正常更新停写后、空库 migration 后等待管理员、API 已就绪但 Web 尚未启动、HTTPS 已通过但 CronJob 尚未恢复。已完成且资源一致时重复 resume 是无写入 no-op。

## 7. 验收

1. API rollout、live 和 ready 成功，API Pod 位于 `guilyrh`，且仍只有一个 SQLite 写实例。
2. Web rollout 与首页成功，Web Pod 位于 `guilyrh`。
3. Certificate 仍为 `Ready`，Traefik Ingress 的正式 HTTPS 可访问。
4. preserve：原用户名和密码可以登录，原任务、记录、设置、冲突、设备和同步历史数量与升级前一致。
5. reset-empty：新管理员能登录，数据库中没有伪造的旧业务数据。
6. 管理员能创建、列出和撤销短期邀请；列表和日志不含完整 token。
7. 使用测试邀请注册普通用户，确认看不到管理员数据和邀请管理，直接请求管理员 API 返回 403。
8. 两个账号分别执行 push/pull 和计时器操作，确认用户隔离。
9. Backup CronJob 已恢复到 preserve 记录值；reset-empty 完成后为 `suspend=false`。

## 8. 失败和人工处置

SQLite schema 没有安全原地 down migration。

- 镜像拉取失败在停写前结束，不改变 Deployment/CronJob；其余任一步失败都把 API/Web 保持为 0、Backup 保持 suspended。
- 管理员未初始化不是回滚条件；保持维护状态，完成一次性初始化后 `--resume`。
- 不自动执行 `kubectl rollout undo`，不自动切回旧镜像，不自动恢复旧 SQLite。
- 保存持久阶段、升级前 Job名称和失败现场，在备份副本上定位问题并优先形成向前修复方案。
- 若决定回旧版本，必须单独审核“旧应用镜像 + 匹配的旧数据库”整体恢复；只换旧镜像会把升级后的 schema 暴露给旧代码。
- 只有确认没有需要保留的升级后写入并明确接受数据损失时，才运行 `scripts/k8s-restore-backup.sh --plan`。恢复前先备份失败现场；恢复脚本不会启动工作负载或切换镜像。
- 旧 Docker Compose 容器不是本次更新目标，启动旧容器、切换入口或恢复旧数据库均需另行批准。

## 9. 上线后观察

关注 4xx/5xx、注册错误、migration/外键错误、同步冲突和数据库增长。日志不得记录密码、密码哈希、Cookie、会话令牌、邀请码 token、完整邀请 URL、kubeconfig、Kubernetes Token 或 Secret 内容。
