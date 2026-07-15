# Release Readiness

> 本页是功能验证摘要，不是生产更新 Runbook。当前生产运行在 Kubernetes；操作步骤以 `docs/deployment.md` 和 `docs/multi-user-migration-runbook.md` 为准。

- Task 1–10 完成状态：已完成并通过合同、数据库、认证、同步、Timer、PWA 与部署维护审查。
- `/api/export` 完成状态：已完成认证下载、版本化合同、单一 SQLite 一致快照、按账号隔离、稳定排序及完整历史导出。
- PWA 离线测试：已通过离线重开、IndexedDB 副本与待同步队列恢复；所有 `/api/*`（含 export）均为 NetworkOnly，未进入 CacheStorage 或静态 precache。
- 双设备 Timer 测试：已通过并发启动、跨设备暂停/继续/退出、离线分歧与人工 reconciliation，服务端保持唯一活动 Timer。
- 手机/桌面测试：Desktop Chrome 与 390px Chromium 行为验收均通过，无整页横向溢出或阻塞关键控件的问题。
- 容器集成 smoke：Compose 构建、HTTPS、健康检查、数据持久化、容器重建与三阶段 export 校验曾通过；该结果不代表 Kubernetes 生产部署已验证。
- 备份/恢复/回滚：在线备份、完整性校验、恢复、损坏备份拒绝、无账号备份回滚及 30 天保留策略均通过。
- 安全检查：export 不含密码/会话哈希、Cookie、同步协议内部记录或路径；文件名不含用户输入；成功与错误响应均 no-store；敏感产物未进入 Git 或 Docker context。
- 当前多用户候选仍位于 `feature/invite-multi-user`。feature 分支提交不是可直接用于生产的 main 镜像来源；发布前仍需合并 main、完成镜像发布并记录真实 digest。
- 多用户生产门禁：migrations `0007`—`0009` 必须在生产备份副本离线演练；Kubernetes 更新必须同时停止 Web/API、创建升级前 Backup Job，并按 API 后 Web 的顺序恢复。
- 已知限制：PWA 离线重开要求至少一次成功在线访问；不兼容的离线 Timer 状态需要用户人工确认；SQLite migration 没有安全原地 down migration。
