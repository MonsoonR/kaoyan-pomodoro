# 一事生产部署与更新

当前生产环境是 Kubernetes。生产更新只通过 Kite 的 Kubectl Terminal 按本页流程执行；Docker Compose 仅用于本地集成测试和已停止的旧服务器短期回滚，不是生产更新目标。

## 当前生产拓扑

- 域名：`https://pomodoro.losenone.cn`
- Namespace：`kaoyan-pomodoro`
- API Deployment：`kaoyan-api`，单副本，`Recreate`
- Web Deployment：`kaoyan-web`
- Backup CronJob：`kaoyan-backup`
- 数据 PVC：`kaoyan-data`
- 备份 PVC：`kaoyan-backups`
- Ingress：`kaoyan-pomodoro`，由 Traefik 提供 80/443 与 HTTPS
- Certificate：`kaoyan-pomodoro-certs`
- API、Web 和 Backup 固定到 `deploy.sagirii.me/node-id=guilyrh`
- 三者容忍 `deploy.sagirii.me/edge=true:NoSchedule`

部署清单位于独立的 `lose-af/losenone-deploy` 仓库。部署仓库提交、镜像 digest 和集群对象都是时点信息，每次更新前必须重新核对；不得把本文中的历史现场描述当成当前事实，也不得只依据清单或集群其中一方猜测另一方状态。

API 启动时自动运行 Drizzle migration。SQLite 数据位于 `kaoyan-data`，Backup CronJob 同时挂载 `kaoyan-data` 和 `kaoyan-backups`，使用 SQLite `.backup`、完整性检查、gzip 校验、`flock` 和原子 rename。

## 镜像发布约束

`.github/workflows/container-images.yml` 只在应用仓库 `main` push 时发布三张正式镜像：

```text
ghcr.io/monsoonr/kaoyan-pomodoro-api:sha-<40位Git SHA>@sha256:<64位digest>
ghcr.io/monsoonr/kaoyan-pomodoro-web:sha-<40位Git SHA>@sha256:<64位digest>
ghcr.io/monsoonr/kaoyan-pomodoro-backup:sha-<40位Git SHA>@sha256:<64位digest>
```

生产引用必须同时固定完整 Git SHA tag 和 OCI digest。三张镜像必须来自同一个已经合并到 `main` 的提交。禁止 `latest`、分支名 tag、PR/feature 临时镜像、短 SHA，以及尚未由 registry 返回的猜测 digest。

部署仓库中的正式镜像引用也只能在 `main` 镜像真实发布并核对 digest 后修改。若集群由 Flux 或其他 GitOps 控制器协调，维护窗口前必须确认它不会在脚本执行期间把镜像、副本数或 CronJob 状态改回；GitOps 暂停和恢复必须遵循部署仓库的运维流程，不由本仓库脚本猜测或自动操作。

## Kubernetes 半自动更新状态机

正式入口是 `scripts/k8s-update.sh`；`scripts/update.sh` 仅保留为兼容转发。固定生产 context 是 `nzfklii-kite`，脚本在任何模式下发现其他 context 都会拒绝。状态机不读取 Secret，也不操作 Flux、DNS、PVC 对象或 Ingress 配置。

### 只读状态与 Plan

查看当前资源和持久阶段：

```bash
bash scripts/k8s-update.sh --status --namespace kaoyan-pomodoro
```

`--status` 显示 ConfigMap 状态阶段、三张镜像、副本/available/Pod 数、CronJob、PVC、Certificate 和数据库证据。API 正在运行时，脚本通过只读 `exec` 检查主文件、WAL 和 SHM；API 为 0 且还没有持久状态时，Kubernetes API 无法直接查看 PVC 文件，因此会明确显示 `unknown-no-running-api-pod`，而不会为了“只读”创建检查 Pod。

日常保留数据库更新的 Plan：

```bash
bash scripts/k8s-update.sh --plan \
  --namespace kaoyan-pomodoro \
  --main-sha <MAIN_SHA> \
  --api-image 'ghcr.io/monsoonr/kaoyan-pomodoro-api:sha-<MAIN_SHA>@sha256:<API_DIGEST>' \
  --web-image 'ghcr.io/monsoonr/kaoyan-pomodoro-web:sha-<MAIN_SHA>@sha256:<WEB_DIGEST>' \
  --backup-image 'ghcr.io/monsoonr/kaoyan-pomodoro-backup:sha-<MAIN_SHA>@sha256:<BACKUP_DIGEST>'
```

`--status` 和 `--plan` 都不得运行 `create`、`delete`、`patch`、`scale`、`set image`、`apply` 或 `rollout`。Plan 仅根据 Kubernetes API、正在运行的 API Pod 和已有 `kaoyan-update-state` ConfigMap 判断是新日常更新、空库重建候选、未完成续跑或已完成目标。

### 持久状态与幂等恢复

正式执行在 Namespace 中维护 `ConfigMap/kaoyan-update-state`。它只保存非敏感的目标 SHA、三张 digest-pinned 镜像、数据库模式、备份文件名、目标副本数、最终 CronJob suspend 值和阶段；密码、Token、Cookie、邀请码、kubeconfig 和 Secret 内容不得进入该对象。`/tmp` 或可选的 `--record-file` 都不是恢复依据。

主要阶段如下：

| 阶段 | 含义 | 可重复行为 |
| --- | --- | --- |
| `preflight-complete` | preserve 拉取检查完成，尚未停写 | 可重新挂起并停写 |
| `write-frozen` | API/Web 已停、Backup 已挂起 | 复用确定名称的升级前 Job |
| `backup-verified` / `reset-verified` | 日常备份成功，或空库与安全备份已验证 | 不重复备份或删库 |
| `images-updated` | 三张目标镜像已写入 | 重复 set 前先比较真实引用 |
| `migration-completed` | 空库已用新 API 镜像完成 migrations | 迁移 Pod 可安全幂等重跑 |
| `awaiting-admin-init` | 等待 TTY 内一次性管理员初始化 | API/Web 保持 0 |
| `admin-initialized` | 数据库已确认存在管理员 | 可继续启动 API |
| `api-started` / `web-started` | API 已先就绪，Web 随后就绪 | 按真实副本和 readiness 收敛 |
| `health-verified` | HTTPS 已通过，尚待恢复 Backup | 只补最后阶段 |
| `completed` | 工作负载、HTTPS 和 CronJob 均完成 | 健康重复 resume 是无写入 no-op |

Kite Terminal 断开后使用状态对象续跑，无需本地文件，也可以不再重复提供镜像参数：

```bash
bash scripts/k8s-update.sh --resume \
  --namespace kaoyan-pomodoro \
  --confirm-context nzfklii-kite \
  --confirm-execute 'UPDATE kaoyan-pomodoro ON nzfklii-kite TO <MAIN_SHA> USING <preserve或reset-empty>'
```

`--execute`、未完成的 `--resume` 和管理员 helper 会共同持有命名空间级 `Lease/kaoyan-update-operation-lock`。Lease 记录 owner 和过期 epoch，并通过 `resourceVersion` 抢占过期锁；第二个终端在创建临时 Pod、停写或改镜像前以退出码 73 拒绝。正常退出会把 Lease 释放为空 owner；终端异常消失时，在输出的过期时间之后重试即可，不依赖 `/tmp` 文件锁。

### 日常保留数据库更新

日常更新默认是 `preserve`。执行前要求 API/Web 健康、API `Recreate`、两个 PVC `Bound`、Certificate `Ready`、无活动 Backup Job，并要求操作者已经用安全备份副本离线演练 migrations：

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

顺序固定为：在 `guilyrh` 拉取检查三张镜像；挂起 Backup；停止 Web 再停止 API；创建并验证确定名称的升级前 Backup Job；更新三张镜像；先启动 API 并等待 migration/rollout/readiness；再启动 Web；检查正式 HTTPS 和 Certificate；最后恢复执行前的 CronJob suspend 状态。脚本轮询 Job 的 `Complete`/`Failed` condition，不用只等待 `Complete` 直到 1800 秒。成功 Job直接复用且不删除；Failed Job原样保留，并把确定性的 `-retry-N` 名称、attempt 和失败 Job列表先写入状态 ConfigMap。本次执行安全失败后，调查原 Job并再次 `--resume`，才会创建已记录的重试 Job。

### 一次性空库重建

`reset-empty` 不是日常更新方式。它只接续“API/Web 已是 0、Backup 已挂起、没有活动 Backup Job、数据卷中的 SQLite/WAL/SHM 已经不存在”的维护现场。脚本本身永远不删除数据库文件；只要发现任何一个文件存在就拒绝。

截至 2026-07-16 的特殊现场保留了安全备份 `kaoyan-20260716T023824338082865Z-daily.sqlite.gz`。完成下一轮开发、合并 `main`、发布并核对三张新镜像后，先使用以下模板；不要把任何历史旧提交写入命令：

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

Plan 会打印三条精确确认。正式执行时原样加入 `--confirm-execute`、`--confirm-reset-empty` 和 `--confirm-backup`。拉取检查后，受限临时 Pod 会以只读方式挂载数据/备份 PVC，确认 SQLite/WAL/SHM 均不存在，并对指定备份执行 gzip、完整性和外键检查；通过后才持久化状态并切换镜像。随后新 API 镜像的迁移 Pod 在空数据卷上执行全部 migrations。

### 管理员初始化

空库 migration 完成后主脚本停在 `awaiting-admin-init`，API/Web 都保持 0，Backup 保持 suspended。它会打印下一条精确命令：

```bash
bash scripts/k8s-admin-init.sh \
  --namespace kaoyan-pomodoro \
  --main-sha <MAIN_SHA> \
  --confirm-context nzfklii-kite \
  --confirm-init 'INITIALIZE ADMIN IN kaoyan-pomodoro ON nzfklii-kite FOR <MAIN_SHA>'
```

辅助脚本从持久状态读取新 API 镜像。它先创建固定在 `guilyrh`、只读挂载数据 PVC 的受限状态检查 Pod，运行 `node dist/cli/account.js status`。若数据库已返回 `initialized`（包括 init 已提交、但 Kite 在 ConfigMap patch 前断开的现场），helper 不创建或 attach 初始化 Pod，而是把阶段收敛到 `admin-initialized` 并以 0 退出；只有 `not-initialized` 才创建非 root 一次性 TTY Pod运行 `node dist/cli/account.js init`。用户名和密码不允许出现在命令参数、环境变量、ConfigMap 或日志中。成功后再运行前述 `--resume`；主脚本会再次从数据库事实确认管理员存在，然后先启动 API、再启动 Web。

所有更新临时 Pod 都设置 `automountServiceAccountToken: false`、非 root、`allowPrivilegeEscalation: false`、`drop: ALL`、`RuntimeDefault` seccomp、固定节点和 edge toleration；不使用 HostPath。

## 失败边界与人工处置

- 镜像拉取失败发生在停写前，不改变 Deployment、CronJob 或持久状态对象。
- 停写或空库状态持久化后，任一步失败都会强制 API/Web 为 0、Backup `suspend=true`，并保留最后完成阶段供 `--resume` 使用。
- 管理员未初始化是安全暂停，不启动 Web；终端在初始化成功后、状态 patch 前断开也没关系，`--resume` 会从数据库事实识别已完成初始化。
- preserve 备份 Job出现 `Failed=True` 时会立即失败，不等待满 1800 秒；保留失败 Job，按状态中的 `backupJob`/`backupAttempt`/`failedBackupJobs` 调查，并用同一条 `--resume` 创建已持久化的确定性重试。
- 若提示另一个 owner 持有更新 Lease，不要删除对方临时 Pod或覆盖阶段；先确认对应终端是否仍在运行，只在 Lease 显示的过期 epoch 之后重试。
- 脚本不提供 SQLite down migration，不自动恢复旧数据库，不自动切回旧镜像，也不执行 `kubectl rollout undo`。
- 新 API 镜像可能已经提交 migrations 后，禁止只切回旧应用镜像。人工回退必须单独审核“旧应用镜像 + 匹配的旧数据库”整体方案。
- 若考虑恢复备份，先保存失败现场，确认没有需要保留的升级后写入并明确接受数据损失；再单独运行 `scripts/k8s-restore-backup.sh --plan`。更新脚本不会调用恢复脚本。
- 失败调查不得输出 Secret、密码、Cookie、Token、邀请码、kubeconfig 或生产数据库内容；优先向前修复。

## 日常备份与恢复

生产日常备份由 `kaoyan-backup` CronJob 完成。手动生产备份从 CronJob 创建 Job：

```bash
kubectl -n kaoyan-pomodoro create job \
  --from=cronjob/kaoyan-backup \
  kaoyan-backup-manual-<timestamp>
```

生产恢复会替换 SQLite，必须是单独批准的维护操作；`k8s-update.sh` 永远不会自动调用它。独立辅助脚本默认只做只读 Plan：

```bash
bash scripts/k8s-restore-backup.sh --plan \
  --namespace kaoyan-pomodoro \
  --backup-file kaoyan-<准确时间>-pre-update.sqlite.gz
```

它要求 API/Web 副本数和 Pod 数都为 0、Backup CronJob 已挂起且没有活动 Job、两个 PVC 均为 `Bound`。正式执行还必须提供精确 context 和脚本打印的完整 `--confirm-restore` 字符串。临时恢复 Pod 同时挂载 `kaoyan-data` 与 `kaoyan-backups`，固定到 `guilyrh`，不使用 HostPath；它先验证目标文件和空间，再额外保存当前数据库的 `pre-restore` 安全副本，随后恢复、修复并核对数据库 `10001:10001`/`0600` 权限、检查完整性和外键，最后只删除临时 Pod。脚本不启动 API/Web、不改镜像、不删除目标备份。

恢复升级前备份会永久丢失该备份之后创建的用户和业务数据。必须先决定接受数据丢失，并保持工作负载停止。`scripts/restore.sh` 只控制遗留 Compose 环境，并要求显式 `--legacy-compose`，不能用于 Kubernetes 生产。

## Docker Compose 的保留边界

以下内容继续保留，用于本地集成、Docker smoke 或旧服务器短期回滚参考：

- `compose.yml`、`compose.test.yml`、`compose.smoke-volumes.yml`
- `Caddyfile`、`Caddyfile.test`
- `scripts/smoke-test.sh`
- `scripts/legacy-compose-update.sh`
- `scripts/restore.sh --legacy-compose ...`

旧服务器容器当前是 stopped 状态。除非进入单独批准的遗留回滚流程，不启动、停止、删除或更新这些容器。当前生产入口是 Traefik Ingress，不是旧 Caddy。

本地容器集成测试仍可运行：

```bash
SMOKE_STORAGE_MODE=volume bash scripts/smoke-test.sh  # Windows Docker Desktop
SMOKE_STORAGE_MODE=bind bash scripts/smoke-test.sh    # Linux/ext4 权限语义
```

Compose smoke 验证镜像内非 root、SQLite 备份/恢复、权限、Caddy 安全头和容器集成行为，但它不是 Kubernetes 生产部署证明。

GitHub Pages 部署已经退役，原 `.github/workflows/deploy.yml` 已删除，后续提交和合并不再触发 Pages 构建或发布。应用仓库保留的 CI 和正式镜像发布工作流是 `.github/workflows/container-images.yml`；正式生产更新仍通过上述 Kubernetes 半自动更新流程完成。
