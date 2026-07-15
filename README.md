# 考研番茄钟

一个支持离线使用和多设备同步的考研复习网页应用，把“长期任务库、今日待办、番茄专注、完成确认、每日复盘”串成一个简单闭环。

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
pnpm install
pnpm dev
```

浏览器打开终端中显示的地址。完整自托管环境还需要 API、SQLite 和 `APP_ORIGIN`，见部署文档。

## 生产构建

```bash
pnpm build
pnpm --filter @kaoyan/web preview
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
- `scripts`：备份、恢复、更新和生产烟雾测试

## 自托管同步版

生产自托管、HTTPS、PWA、备份与恢复说明见 [部署文档](docs/deployment.md)。从旧单账号数据库升级前，先阅读 [多用户迁移 Runbook](docs/multi-user-migration-runbook.md)。

初始化得到的原始账号是管理员。管理员登录后可在“邀请管理”创建一次性链接。按用户名安全重置密码：

```bash
pnpm admin:reset-password --username <username>
```

密码会在终端中隐藏输入两次；命令不会接受密码参数，完成后该用户的已有会话全部失效，并要求下次登录后修改密码。
