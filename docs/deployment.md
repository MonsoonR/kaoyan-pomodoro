# 考研番茄钟生产部署与更新

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

部署清单的基准位于 `lose-af/losenone-deploy` 的 `feat/kaoyan-pomodoro`，当前生产状态基准提交为 `71eb512dc56ce0852428e5d95111ed4f4174e19c`。清单和真实集群状态都要核对；不得只依据其中一方猜测生产状态。

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

## Kubernetes 更新脚本

默认入口是 `scripts/update.sh`，它只转发到 `scripts/k8s-update.sh`。不带 `--execute` 时脚本只做只读预检并输出计划。

在 Kite Kubectl Terminal 中先填写三张已经发布的完整引用：

```bash
bash scripts/update.sh --plan \
  --namespace kaoyan-pomodoro \
  --main-sha <MAIN_SHA> \
  --api-image 'ghcr.io/monsoonr/kaoyan-pomodoro-api:sha-<MAIN_SHA>@sha256:<API_DIGEST>' \
  --web-image 'ghcr.io/monsoonr/kaoyan-pomodoro-web:sha-<MAIN_SHA>@sha256:<WEB_DIGEST>' \
  --backup-image 'ghcr.io/monsoonr/kaoyan-pomodoro-backup:sha-<MAIN_SHA>@sha256:<BACKUP_DIGEST>'
```

Plan 会检查并记录：

- 当前 kubectl context 和固定 Namespace；
- API/Web 是否健康，API 是否单副本和 `Recreate`；
- Deployment、CronJob、PVC、Ingress、Certificate 是否存在；
- 两个 PVC 是否 `Bound`，Certificate 是否 `Ready`；
- Ingress 是否由 Traefik 服务正式域名；
- API、Web、Backup 模板的 node affinity 与 taint toleration；
- 当前 API/Web Pod 是否位于 `guilyrh`；
- Backup CronJob 是否有活动 Job、上次调度/成功时间和 `suspend` 状态；
- 三张旧镜像完整引用、API/Web 副本数和目标镜像。

Plan 不运行 `apply`、`patch`、`scale`、`set image`、`rollout`、`create` 或 `delete`。

## 上线前门禁

执行模式前必须全部满足：

1. 多用户改动已合并到应用仓库 `main`，三张正式镜像已发布并取得真实 digest。
2. lint、typecheck、unit/integration、build、Drizzle check 和脚本测试通过。
3. migrations `0007`—`0009` 已在最新已验证生产备份的离线副本上完整演练；升级后 `integrity_check=ok`、`foreign_key_check` 无结果、旧管理员及关键记录计数正确。
4. API 当前单副本且策略为 `Recreate`，API/Web 健康，Backup 没有活动 Job。
5. 两个 PVC `Bound`，Certificate `Ready`，三个工作负载都固定到 `guilyrh` 并包含既定 toleration。
6. 已准备短维护窗口、通知、操作者、复核人和人工失败处置方案。
7. 已确认 GitOps 不会与维护窗口内的 kubectl 变更竞争。

`--migration-check-passed` 是操作者对第 3 项的显式确认，不会替代离线演练。`--confirm-context` 必须逐字等于 `kubectl config current-context`，防止在错误集群执行。脚本显示完整 Plan 和旧镜像后，还要求 `--confirm-execute` 逐字匹配它打印的第二次确认字符串。

## 执行顺序

确认 Plan 后才允许增加 `--execute`：

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

执行模式按以下顺序运行：

1. 在 `guilyrh` 创建三张目标镜像的短生命周期拉取探针；全部成功后删除探针。
2. 以 mode `0600` 写入本地状态记录，包含 context、Namespace、旧/新镜像、原副本数和原 CronJob `suspend`。
3. 挂起 `kaoyan-backup` 并再次确认没有活动 Backup Job。
4. 先将 Web 缩容到 0，再将 API 缩容到 0，等待所有 Web/API Pod 消失。只停 Web 不构成完整停写，因为已安装的 PWA 或客户端仍可直接访问 API。
5. 从现有 CronJob 创建 `kaoyan-backup-pre-update-<timestamp>`，等待 Job 成功。备份脚本本身完成 SQLite、gzip 和解压后完整性验证。
6. 保持 API/Web 为 0，分别更新 API、Web 和 Backup 的完整镜像引用。
7. 只恢复原 API 单副本。API 启动会执行 Drizzle migrations `0007`—`0009`；等待 rollout 和 readiness 成功，并确认 Pod 仍在 `guilyrh`。
8. API 成功后恢复 Web 原副本数，等待 rollout，确认 Pod 仍在 `guilyrh`。
9. 验证正式 HTTPS 的 live、ready 和首页，再次确认 Certificate `Ready`。
10. 恢复更新前记录的 CronJob `suspend` 状态，保留升级前 Backup Job 和状态记录用于审计。

## 失败边界与人工处置

脚本不提供 SQLite down migration，也不自动恢复旧数据库或旧镜像。

- 镜像拉取探针失败发生在停写前，不改变业务工作负载。
- 一旦停写开始，任一步失败都会再次把 API/Web 保持在 0，并把 Backup CronJob 保持为 suspended。
- API 新镜像一旦启动，就必须假设 migrations 可能已经提交。此后绝不能只把 API 镜像改回旧版，否则旧代码可能读取不兼容 schema。
- 失败时记录升级前 Backup Job、三张旧镜像、原副本数和 CronJob 状态，保留失败数据库现场，先判断是向前修复还是“旧应用 + 升级前数据库”成对恢复。
- 只有确认尚未接受升级后写入、明确接受丢弃升级后数据，并经单独审核后，才能人工恢复升级前备份。恢复前仍需创建失败现场备份。
- 不使用 `kubectl rollout undo` 作为多用户数据库升级的自动回滚方式。

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

`.github/workflows/deploy.yml` 是仓库原有的独立 GitHub Pages 发布用途；本次没有证据证明该用途废弃，因此保留原文件。它不属于 `pomodoro.losenone.cn` 的 Kubernetes 生产更新流程。
