FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 gzip util-linux findutils tzdata ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 kaoyan && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin kaoyan
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="OneThing Backup" \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.created=$BUILD_DATE \
      org.opencontainers.image.source="https://github.com/MonsoonR/onething"
WORKDIR /app
COPY --chown=10001:10001 docker/backup/scripts ./scripts
RUN chmod 0555 /app/scripts/*.sh
ENV DATABASE_PATH=/var/lib/kaoyan/kaoyan.sqlite BACKUP_DIR=/backups BACKUP_HOUR=3 TZ=Asia/Shanghai RETENTION_DAYS=30
USER 10001:10001
CMD ["/app/scripts/daily.sh"]
