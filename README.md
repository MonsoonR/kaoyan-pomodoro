# 一事

> 此刻，只做一事。

一事（英文名 **OneThing**）是一个支持离线使用和多设备同步的专注学习网页应用，把“长期任务库、今日待办、番茄专注、完成确认、每日复盘”串成一个简单闭环。

## 功能

- 长期任务库：创建、编辑、归档，并一键加入今天
- 今日任务：临时添加、排序、编辑、删除和手动完成
- 计时模式：25/5、50/10、自定义
- 沉浸专注：暂停或退出时必须记录原因
- 完成确认：达到预计番茄数后，确认打钩、追加番茄或暂不完成
- 今日概览：任务完成数、专注时长、完整番茄和中断次数
- 异常恢复：网页关闭或电脑休眠后，可按计划完成、重新开始或记为中断
- 邀请注册：管理员创建一次性邀请链接，不开放公开注册
- 多用户隔离：任务、计时、设置、统计、同步、冲突、设备和会话按账号隔离
- 离线可用：登录后的数据保存在当前账号的浏览器副本中，联网后继续同步
- 响应式界面：支持桌面和手机浏览器

## 运行源码

需要 Node.js 22 和 pnpm 10。

```bash
git clone https://github.com/MonsoonR/onething.git
cd onething
pnpm install
pnpm dev
```

浏览器打开终端中显示的地址。完整自托管环境还需要 API、SQLite 和 `APP_ORIGIN`，见部署文档。

### 本地实时开发

首次使用时安装依赖并交互式创建本地管理员，之后一条命令同时启动 Web 和 API：

```bash
pnpm install
pnpm local:account:init
pnpm dev:local
```

浏览器固定打开 <http://localhost:5273>。修改前端代码后 Vite 会自动热更新；修改 API 代码后 `tsx watch` 会自动重启 API。本地数据仅存放在项目的 `.local-data/`，不会使用生产数据库。按 `Ctrl+C` 会同时停止前后端。

## 生产构建

```bash
pnpm build
pnpm --dir apps/web preview
```

Web 与 API 分别构建；同步版不能只部署静态文件。

## 测试

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

端到端测试使用 Playwright Chromium。普通开发环境首次运行前，可执行：

```bash
pnpm exec playwright install chromium
```

## 项目结构

- `apps/api`：认证、邀请码、业务 API、同步服务与 SQLite 迁移
- `apps/web`：React PWA、IndexedDB 离线副本与同步客户端
- `packages/contracts`：前后端共享的请求、响应与数据校验
- `scripts`：Kubernetes 生产更新与显式恢复、本地/遗留 Compose 维护和容器集成测试

## 自托管同步版

当前生产环境运行在 Kubernetes，更新入口为 `scripts/update.sh`（默认仅 Plan，只有显式 `--execute` 才变更集群）。Kubernetes 拓扑、镜像约束、短维护窗口、备份与失败边界见 [部署文档](docs/deployment.md)；从旧单账号数据库升级前，必须先阅读 [多用户迁移 Runbook](docs/multi-user-migration-runbook.md)。

`compose.yml` 与 Caddy 配置继续用于本地容器集成测试和已停止旧服务器的短期回滚参考，不是当前生产更新方式。

初始化得到的原始账号是管理员。管理员登录后可在“邀请管理”创建一次性链接。本地开发时按用户名安全重置密码：

```bash
pnpm local:account:reset-password --username <username>
```

密码会在终端中隐藏输入两次；命令不会接受密码参数，完成后该用户的已有会话全部失效，并要求下次登录后修改密码。
