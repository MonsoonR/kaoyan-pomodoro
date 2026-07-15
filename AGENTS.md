# AGENTS.md

本文件适用于仓库根目录及所有子目录。若更深层目录存在自己的 `AGENTS.md`，以更深层文件为准。

## 项目目标与优先级

这是一个面向考研复习的本地优先、单账号多设备同步番茄钟 PWA。核心闭环是：长期任务库 → 今日任务 → 番茄专注 → 完成确认 → 每日复盘；离线时仍可使用，联网后通过服务端同步，并支持自托管、备份和恢复。

实现和评审改动时，依次优先保证：

1. 计时与全局活动计时器状态正确。
2. 学习记录、同步版本和幂等凭据可信，不重复、不丢失。
3. 认证、Cookie、设备会话和用户数据不泄露。
4. IndexedDB、SQLite、备份和恢复路径不会静默丢数据。
5. 桌面、390px 手机和离线 PWA 均可使用。

不要为了抽象、换技术栈、视觉重构或清理历史代码扩大任务范围。

## 技术栈与目录

- 运行时：Node.js 22，包管理器固定为 `pnpm@10.33.2`。
- `apps/web/`：React 19、Vite 6、原生 CSS、Dexie/IndexedDB、Workbox PWA、Vitest 与 Playwright。
- `apps/api/`：Fastify 5、TypeScript、Zod、Drizzle ORM、better-sqlite3、Argon2id。
- `packages/contracts/`：Web 与 API 共享的严格 Zod 合同和 TypeScript 类型。
- `apps/api/drizzle/`：只追加的版本化 SQLite migration 与 Drizzle 元数据。
- `docker/backup/`：在线备份、校验、保留和数据库替换脚本。
- `scripts/`：Kubernetes 生产更新、遗留 Compose 维护、容器 smoke 及其脚本级回归测试。
- `scripts/update.sh`：当前生产更新兼容入口，转交 `scripts/k8s-update.sh`；默认 Plan，只有显式 `--execute` 才允许 kubectl 变更。
- `scripts/k8s-restore-backup.sh`：Kubernetes 数据库恢复辅助；必须保持 API/Web 为 0，且不得自动启动工作负载或切换镜像。
- `compose.yml`、`Caddyfile`：本地容器集成和已停止旧服务器的短期回滚参考；不是当前生产拓扑。`compose.test.yml` 和 `compose.smoke-volumes.yml` 仅用于测试。
- `docs/deployment.md`：生产部署、备份和恢复操作；`docs/release-readiness.md`：发布验收摘要。
- `docs/superpowers/`：批准的设计与实施背景。代码、migration 和测试结果优先于过时说明。

生产 Kubernetes 清单位于独立的 `lose-af/losenone-deploy` GitOps 仓库，不属于本仓库。本仓库负责应用代码、镜像构建、更新脚本和应用侧 Runbook；部署仓库负责声明式集群资源。涉及部署时必须分别核对两个仓库的当前分支、工作树和真实实现，不能用一方替代另一方。

## 开始工作前

1. 确认当前项目根目录、分支和工作树：

   ```powershell
   git status --short --branch
   git branch --show-current
   git worktree list
   ```

2. 保留用户已有改动。不要 reset、stash、覆盖、格式化或提交与当前任务无关的文件。
3. 若任务明确指定某个 worktree，就以该 worktree 为项目根目录；否则不要读取或修改 `.worktrees/` 中的其他工作树。
4. 阅读与任务直接相关的源码、测试、共享合同、migration 和文档，不要默认计划文档已经实现。
5. 若任务涉及 GitOps 清单，独立确认部署仓库的当前分支和目标 overlay。不要假设应用分支、部署分支和集群正在协调的分支相同，也不要因为本机部署仓库当前 checkout 缺少某个 overlay 就断言远端或集群不存在它。
6. 核对工具版本：

   ```powershell
   node --version
   pnpm --version
   ```

   Node 必须为 22.x。切换 Node 主版本后若原生依赖出现 ABI 不匹配，应重装或重建依赖，不要把环境错误误判为业务失败。

7. 目标、验收标准、数据迁移或冲突语义不清晰时，先与用户对齐。若存在更短、更安全的实现路径，应直接说明。

## Windows 与命令约束

- Windows 上优先使用 PowerShell 7（`pwsh`）和 `Get-ChildItem`、`Get-Content`、`Select-String`、`Where-Object` 等原生命令。
- 路径包含中文，所有路径参数都必须正确引用；不要假设路径只含 ASCII。
- 不默认使用 WSL、Git Bash、`sed`、`grep` 或 GNU 工具。只有仓库现有 `.sh` 脚本或 Linux/Docker 验收确实需要时才使用 Bash。
- Docker smoke 在 Windows Docker Desktop 上使用 `SMOKE_STORAGE_MODE=volume`；Debian/ext4 权限验收使用 `SMOKE_STORAGE_MODE=bind`。`auto` 会按宿主环境选择并打印实际模式。
- Windows volume smoke 不能替代最终 Debian bind-mount 的 UID/GID 和 mode 验收。

## 架构与业务约束

### 共享合同

- 跨端请求、响应、同步 operation、change、冲突和导出结构应先在 `packages/contracts` 中定义并严格校验。
- 合同变更必须同步更新 Web、API 和合同测试；不要在两端复制略有差异的临时类型。
- 对外 JSON 必须稳定且安全。不得返回密码哈希、会话令牌哈希、Cookie、数据库路径、环境变量或同步内部 receipt。

### 数据库与迁移

- 数据库状态变更必须在事务内保持实体、`sync_changes`、operation receipt 和 conflict result 原子一致。
- 不修改已经提交的 migration；新增 schema 变更必须创建新 migration，并更新相应 Drizzle 元数据和约束测试。
- 保留外键、唯一约束、单账号/单设置/单活动计时器约束和毫秒时间戳语义。
- 软删除历史、幂等 operation、change cursor 和已解决冲突结果不得被静默清理或重写。
- 日期统计使用用户本地日历日；不要用 UTC 日期截断代替本地日期。

### 认证与安全

- 当前产品是单账号，不开放注册；账号初始化和密码重置走现有 CLI。
- 密码继续使用 Argon2id；服务端只保存会话令牌哈希。
- Cookie 必须保持 `HttpOnly`、`Secure`、`SameSite=Lax`；不能削弱 Origin 校验、登录限速、会话撤销或密码修改后的失效语义。
- 所有 `/api` 成功和错误响应都必须保持 `Cache-Control: no-store` 与 `Pragma: no-cache`。
- 不记录或输出密码、token、Cookie、完整导出数据及其他秘密。

### 离线同步与冲突

- Web 端以 Dexie/IndexedDB 为本地副本和离线队列；状态更新必须可恢复，不能因刷新、登录切换或同步失败清空队列。
- 同步 operation 必须幂等、按序处理并使用服务端版本；普通字段遵循已批准的合并规则，删除、完成和归档冲突按现有人工解决语义处理。
- 认证切换、重新认证和会话恢复必须隔离旧的异步请求，避免旧响应污染新会话。
- 冲突解决请求先校验 conflict type 与 resolution 组合；相同重试返回首次持久化结果，不同重试返回稳定 409，且不能产生二次实体修改。

### 计时器

- 服务端只允许一个全局活动计时器，多设备共享同一权威状态。
- 计时使用时间戳差值，不按定时器回调次数累加；必须覆盖暂停、恢复、页面关闭、电脑休眠、过期恢复和跨本地日期边界。
- 服务端确认计时器自动完成时使用服务器时间安全下界，保守扣除时钟 uncertainty；不能因高 RTT 提前完成。
- 离线 provisional 计时器必须通过现有 reconciliation 流程收口；不要绕过冲突或伪装成服务端已确认状态。
- 暂停、继续、退出、完成和 reconciliation 在异步提交期间必须立即防重复。

### Web、可访问性与 PWA

- 保持简体中文术语：长期任务、今日任务、专注、休息、中断、完成确认。
- 复用现有组件、CSS 变量和布局模式；图标按钮提供 `aria-label`，对话框有合理焦点与键盘行为。
- 新交互同时检查桌面和 390px 手机，避免横向溢出、遮挡、滚动陷阱和 PWA 更新提示覆盖计时控件。
- Service Worker 不得缓存 `/api`；API 使用 NetworkOnly，导航 fallback 排除 `/api`。更新必须由用户确认，不能强制刷新或清空 IndexedDB。

### 部署、备份与恢复

- 当前生产运行在 Namespace `kaoyan-pomodoro`；API/Web Deployments、Backup CronJob、两个 PVC、Traefik Ingress 和 cert-manager Certificate 的真实状态优先于遗留 Compose 说明。
- 生产镜像必须来自已合并的 `main`，使用完整 `sha-<40位Git SHA>@sha256:<digest>`；禁止 `latest`、feature/PR 临时镜像和猜测 digest。
- Git SHA、OCI digest、部署仓库分支尖端、清单基准提交和集群对象状态都是时点信息，每次操作前重新验证；不要把历史部署记录当作当前事实。
- API 保持单副本 `Recreate`；API、Web 和 Backup 固定到 `guilyrh` 并保留既定 edge toleration。
- 多用户 migrations `0007`—`0009` 使用同时停止 Web/API 的短维护窗口；不能把只停 Web 描述为完整停写，也不能自动执行 SQLite down migration。
- Flux/GitOps 协调状态必须在维护窗口前确认。不得让直接 `kubectl` 更新与 GitOps reconciliation 竞争，也不得由本仓库脚本擅自暂停或恢复 Flux。
- Web、API 和 backup 容器保持非 root。Compose/Caddy 安全头、内部网络与日志限制继续作为本地/遗留容器基线，不得放宽。
- 在线备份继续使用 SQLite `.backup`、共享 `flock`、压缩前后完整性检查、`gzip -t`、`0600` 和原子 rename。
- Kubernetes 更新失败后保持 API/Web 停止并挂起 Backup CronJob；不自动切旧镜像或恢复旧数据库。遗留 Compose restore/update 继续持有 maintenance lock。
- 不用 `0777`、忽略 `chmod`、直接复制运行中的 SQLite 文件或跳过 ready 校验来让测试通过。

## 测试与验证

安装依赖：

```powershell
pnpm install --frozen-lockfile
```

常用全仓门禁：

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @kaoyan/api exec drizzle-kit check --config drizzle.config.ts
```

浏览器与 PWA：

```powershell
pnpm --filter @kaoyan/web test:e2e
pnpm --filter @kaoyan/web test:pwa
```

本地容器集成烟雾测试（不是 Kubernetes 生产部署）：

```bash
bash scripts/smoke-test.sh
```

- 共享合同：更新 `packages/contracts/src/contracts.test.ts`。
- API、认证、数据库或同步：添加相应 Vitest/HTTP 集成测试，并至少运行 API 测试与全仓门禁。
- Web 状态、队列、计时或组件：添加 Vitest/Node Test；关键流程继续运行 Desktop、390px mobile 和双设备 Playwright。
- PWA、缓存或离线行为：运行 production PWA Playwright，不能只依赖单元测试或 build。
- migration：验证旧库升级、约束、幂等迁移、foreign key 和 `PRAGMA integrity_check`。
- Kubernetes 更新脚本：先扩展 fake-kubectl 脚本级测试，确保 Plan 无变更、Execute 显式确认和失败停写边界；容器内部备份/恢复再运行 Docker smoke，涉及权限语义时补 Linux/ext4 bind 验收。
- 修复缺陷时优先先写能稳定复现的失败测试，确认失败原因正确，再做最小修复。
- 若某项因环境限制未运行，交付时明确命令、原因和剩余风险；不要声称通过。

## 文件、秘密与交付边界

- 不提交 `.env`、SQLite 数据库、WAL/SHM、备份、证书、私钥、导出 JSON、测试报告、trace、截图、`node_modules` 或 `dist`。
- 不把真实密码、token、Cookie 或生产域名写入测试、文档、提交信息和日志。
- 不仅为排版重写大文件，也不对无关代码做批量格式化。
- 只修改当前目标所需文件；生成 migration 时只纳入该 migration 必需的 SQL、元数据、schema 和测试。
- 未经明确要求，不提交、推送、合并、部署、删除分支/worktree、清空数据或执行其他不可逆操作。
- 完成后报告：改了什么、运行了哪些命令及真实结果、未验证项和剩余风险，并确认最终 `git status`。
