# Release Readiness

- Task 1–10 完成状态：已完成并通过合同、数据库、认证、同步、Timer、PWA 与部署维护审查。
- `/api/export` 完成状态：已完成认证下载、版本化合同、单一 SQLite 一致快照、按账号隔离、稳定排序及完整历史导出。
- PWA 离线测试：已通过离线重开、IndexedDB 副本与待同步队列恢复；所有 `/api/*`（含 export）均为 NetworkOnly，未进入 CacheStorage 或静态 precache。
- 双设备 Timer 测试：已通过并发启动、跨设备暂停/继续/退出、离线分歧与人工 reconciliation，服务端保持唯一活动 Timer。
- 手机/桌面测试：Desktop Chrome 与 390px Chromium 行为验收均通过，无整页横向溢出或阻塞关键控件的问题。
- Docker smoke：真实 Compose 构建、HTTPS、健康检查、数据持久化、容器重建与三阶段 export 校验均通过。
- 备份/恢复/回滚：在线备份、完整性校验、恢复、损坏备份拒绝、无账号备份回滚及 30 天保留策略均通过。
- 安全检查：export 不含密码/会话哈希、Cookie、同步协议内部记录或路径；文件名不含用户输入；成功与错误响应均 no-store；敏感产物未进入 Git 或 Docker context。
- 当前 release commit：`feature/multi-device-sync` 的 HEAD（提交主题 `feat: complete data export and release validation`）。
- 已知但明确接受的限制：仅支持预置单账号且不开放注册；同步版从空数据开始且不自动迁移旧浏览器数据；PWA 离线重开要求至少一次成功在线访问；不兼容的离线 Timer 状态需要用户人工确认。
