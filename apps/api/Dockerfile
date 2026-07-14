FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.js ./
COPY packages/contracts/package.json packages/contracts/tsconfig*.json ./packages/contracts/
COPY apps/api/package.json apps/api/tsconfig*.json ./apps/api/
RUN pnpm install --frozen-lockfile
COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api
RUN pnpm --filter @kaoyan/contracts build && pnpm --filter @kaoyan/api build && pnpm --filter @kaoyan/api deploy --legacy --prod /opt/api

FROM node:22-bookworm-slim AS runtime
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="Kaoyan Pomodoro API" \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.created=$BUILD_DATE \
      org.opencontainers.image.source="https://github.com/MonsoonR/kaoyan-pomodoro"
ENV NODE_ENV=production DATABASE_PATH=/var/lib/kaoyan/kaoyan.sqlite HOST=0.0.0.0 PORT=3000 TRUST_PROXY_HOPS=1
RUN groupadd --gid 10001 kaoyan && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin kaoyan
WORKDIR /app
COPY --from=build --chown=10001:10001 /opt/api ./
USER 10001:10001
EXPOSE 3000
CMD ["node", "dist/server.js"]
