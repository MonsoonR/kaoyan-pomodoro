FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.js ./
COPY packages/contracts/package.json packages/contracts/tsconfig*.json ./packages/contracts/
COPY apps/web/package.json apps/web/tsconfig.json ./apps/web/
RUN pnpm install --frozen-lockfile
COPY packages/contracts ./packages/contracts
COPY apps/web ./apps/web
RUN pnpm --filter @kaoyan/contracts build && pnpm --filter @kaoyan/web build

FROM node:22-bookworm-slim AS runtime
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="Kaoyan Pomodoro Web" \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.created=$BUILD_DATE \
      org.opencontainers.image.source="https://github.com/MonsoonR/kaoyan-pomodoro"
ENV NODE_ENV=production PORT=8080
RUN groupadd --gid 10002 web && useradd --uid 10002 --gid 10002 --no-create-home --shell /usr/sbin/nologin web
WORKDIR /app
COPY --chown=10002:10002 apps/web/server.mjs ./server.mjs
COPY --from=build --chown=10002:10002 /workspace/apps/web/dist ./dist
USER 10002:10002
EXPOSE 8080
CMD ["node", "server.mjs"]
