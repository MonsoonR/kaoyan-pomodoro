# 考研番茄钟自托管部署

本文档面向 Debian 13.2 64-bit（包括腾讯云轻量应用服务器），部署目录固定为 `/opt/kaoyan-pomodoro`。生产拓扑只有 Caddy 发布 80/443；Web、API、SQLite 和备份服务仅位于 Compose 网络中。

## 服务器、DNS与防火墙

最低建议为 1 vCPU、1 GiB 内存、10 GiB SSD；构建镜像时建议 2 GiB 内存或临时 swap。为独立子域名添加指向服务器公网地址的 A 记录；只有实际配置 IPv6 时才添加 AAAA。安全组和主机防火墙仅开放 SSH、TCP 80、TCP 443 与 UDP 443。UDP 443 用于 HTTP/3，关闭它不会影响 HTTPS。

按 Docker 官方 Debian 安装说明安装 Docker Engine、Buildx 与 Compose plugin，确认 `docker version` 和 `docker compose version` 均成功。将仓库的已审查版本检出到 `/opt/kaoyan-pomodoro`，不要在服务器上使用浮动的未审查分支。

```bash
sudo install -d -m 0755 /opt/kaoyan-pomodoro
sudo chown "$USER":"$USER" /opt/kaoyan-pomodoro
cd /opt/kaoyan-pomodoro
cp .env.example .env
```

编辑 `.env`：`DOMAIN` 是独立子域名，`APP_ORIGIN` 必须是同域的 `https://` origin，`CADDY_EMAIL` 用于证书通知，`TZ` 默认为 `Asia/Shanghai`，`BACKUP_HOUR` 是本地时区的每日备份小时，`RETENTION_DAYS` 默认为 30。文件中不放账号密码、令牌或私钥。

## 持久目录和权限

API 与 backup 固定使用 UID/GID 10001，Web 使用 10002，Caddy 使用 1000。创建持久目录：

```bash
cd /opt/kaoyan-pomodoro
sudo install -d -o 10001 -g 10001 -m 0750 data backups
sudo install -d -o 1000 -g 1000 -m 0750 caddy-data caddy-config
```

实际数据分别位于 `/opt/kaoyan-pomodoro/data/kaoyan.sqlite`、`backups/`、`caddy-data/` 和 `caddy-config/`。不要用 `cp` 复制在线 SQLite 主文件。

## 首次启动与账号

```bash
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
docker compose run --rm --no-deps api node dist/cli/account.js init
```

CLI 在终端中隐藏密码输入；第二次初始化会安全失败。也支持自动化系统从受保护 stdin 传 JSON，设置 `KAOYAN_ACCOUNT_STDIN=1`，但绝不能把密码放入参数或 `.env`。浏览 `https://你的域名` 登录，浏览器收到的会话 Cookie 为 `HttpOnly; Secure; SameSite=Lax`。

SSH 重置密码会撤销全部现有 session，所有设备需重新登录，本机 IndexedDB 副本和 pending operation 不会被清除：

```bash
docker compose run --rm --no-deps api node dist/cli/account.js reset-password
```

## PWA

首次在线登录并等待“应用已可离线打开”后，可用浏览器的“安装应用”安装。应用壳、构建 JS/CSS、manifest 和本地图标进入 precache；所有 `/api/**` 是 NetworkOnly，任务、计时器、同步响应、密码和会话令牌不会进入 CacheStorage。业务副本和待同步操作仍只在 IndexedDB。新版本会提示，只有点击“更新并刷新”才激活；“稍后”不会中断计时器，并保留重新打开提示的按钮。

## 健康、HTTPS与日志

```bash
curl -fsS https://你的域名/api/health/live
curl -fsS https://你的域名/api/health/ready
docker compose ps
docker compose logs --tail=200 api
```

live 只说明进程响应；ready 运行 `SELECT 1`、迁移表检查和 `PRAGMA quick_check(1)`。失败返回安全的 503，细节只进服务端日志。Caddy 自动申请、续期证书和执行 HTTP→HTTPS 跳转；确保证书续期时 DNS 仍指向服务器且 80/443 可达。所有长期服务使用 `json-file`，单文件 10 MiB、最多 3 个。

## 备份

backup 容器启动后做一次在线备份，随后每天在 `BACKUP_HOUR` 执行。它用 SQLite `.backup`、防并发 `flock`、压缩前后两次 `PRAGMA integrity_check`、`gzip -t` 和原子 rename。只有新备份成功后才清理严格匹配本应用命名且超过 30 天的普通文件，并始终保留最新一份。

```bash
docker compose run --rm --no-deps backup /app/scripts/backup.sh manual
docker compose run --rm --no-deps backup /app/scripts/validate-backup.sh /backups/kaoyan-时间-manual.sqlite.gz
ls -lh backups/
```

更新前运行：

```bash
bash scripts/update.sh
```

它先创建并验证 `pre-update`，构建新镜像，停止 API 写入，使用新 API 镜像运行现有 `migrateDatabase` CLI；迁移失败时保持 API 停止，不会启动失败版本。成功后等待 readiness 并启动 Caddy。

## 恢复与回滚

只允许恢复 `backups/` 内符合命名规则的普通非符号链接文件：

```bash
bash scripts/restore.sh backups/kaoyan-20260713T120000000000000Z-manual.sqlite.gz
```

脚本拒绝路径穿越和符号链接，先验证 gzip/SQLite，再在线创建 `pre-restore`。停止 API 后原子替换数据库，清除 WAL/SHM，启动并等待 ready，再验证完整性和唯一账号。替换、迁移、启动、ready 或恢复后验证任一步失败，脚本会停止失败 API、从 `pre-restore` 回滚并再次等待 ready。若回滚也失败，API 保持停止并打印人工恢复命令；绝不会假装成功。

## 迁移与灾难恢复

迁移到新服务器时：在旧机执行 manual backup 并验证；安全复制仓库、`.env`（不含密码）、指定 `.sqlite.gz`、`caddy-data/` 和 `caddy-config/`；在新机创建相同 UID/GID 目录；恢复数据库；更新 DNS；验证 HTTPS、登录和 ready。若不迁移 Caddy 数据，Caddy 会重新签发证书，需注意 CA 限速。

灾难恢复优先选择最新已验证备份。新机先构建镜像、放入备份，再用 `restore.sh`。保留一份异机加密备份；本机 30 天保留不能替代异地备份。

## 故障排查

- Caddy 申请证书失败：检查 A/AAAA、80/443、安全组、域名是否错误代理到别处及 `docker compose logs caddy`。
- API 不 ready：检查 `docker compose logs api`、`data/` UID 10001、磁盘空间和数据库完整性；不要绕过迁移。
- backup 不健康：检查 `backups/` UID 10001、空间和 `.backup.lock`，旧有效备份不会因本次失败被删除。
- 页面能打开但不能同步：检查 ready、浏览器网络与 APP_ORIGIN 是否和外部 HTTPS origin 完全一致。
- PWA 更新不出现：确认 `sw.js` 没被 CDN 永久缓存，生产 Caddy 和 Web 已对它设置 `no-cache/no-store`。

停止并移除容器但保留数据：

```bash
docker compose down
```

完全删除是不可逆操作。先做异地备份，再显式删除 `/opt/kaoyan-pomodoro/data`、`backups`、`caddy-data` 和 `caddy-config`；`docker compose down --volumes` 不会自动删除这些 bind mount 目录。

## 本地生产烟雾测试

`bash scripts/smoke-test.sh` 使用随机 Compose project、临时持久目录、真实三张生产镜像、真实 Fastify/SQLite/Caddy internal CA 与 HTTPS。它验证端口隔离、非 root UID、安全头和 Cookie、账号 CLI、同步写入、在线备份、完整恢复、容器重建持久化、失败恢复自动回滚、29/30/31 天保留边界以及日志不包含测试密码/session token；无论成功失败都会清理。
