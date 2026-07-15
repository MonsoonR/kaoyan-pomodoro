# Multi-Device Sync Implementation Plan

> Historical implementation plan. Its Docker Compose/Caddy deployment target describes the original delivery baseline, not the current Kubernetes production update process. Use `docs/deployment.md` for current operations.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the local-only study timer into a single-account, self-hosted PWA with secure login, offline-first multi-device synchronization, one global timer, conflict resolution, and Docker Compose deployment.

**Architecture:** Keep the existing React experience while moving authoritative data to a Fastify API backed by SQLite and Drizzle. The browser stores a replica and an idempotent operation queue in IndexedDB; Caddy terminates HTTPS and routes static traffic and `/api/*`, while a backup container protects the database.

**Tech Stack:** React, TypeScript, Vite, vite-plugin-pwa, Dexie, Fastify, Zod, Drizzle ORM, SQLite, Argon2id, Vitest, Playwright, Docker Compose, Caddy.

## Global Constraints

- One account only; no registration, email reset, OAuth, sharing, or social features.
- Debian 13.2 64-bit and Docker Compose are the target deployment environment.
- Sessions last 30 days and may coexist across devices.
- Browser edits remain usable offline and synchronize when connectivity returns.
- Ordinary fields use server-accepted last-write-wins; delete, completion, and archive conflicts require user resolution.
- The server permits exactly one active timer.
- SQLite backups run daily and retain the most recent 30 days.
- Existing local-only data is not migrated automatically.

---

### Task 1: Typed workspace and shared contracts

**Files:** `apps/web/**`, `apps/api/**`, `packages/contracts/**`, `pnpm-workspace.yaml`, `tsconfig.base.json`

- [ ] Write failing Zod contract tests for versioned entities and sync operations.
- [ ] Create the pnpm workspace and move the existing Vite application into `apps/web` without changing visible behavior.
- [ ] Define shared `EntityVersion`, `SyncOperation`, `SyncChange`, `ActiveTimer`, and API schemas.
- [ ] Run all existing model tests and workspace builds.
- [ ] Commit: `chore: create typed application workspace`.

### Task 2: SQLite schema and migration lifecycle

**Files:** `apps/api/src/db/schema.ts`, `client.ts`, `migrate.ts`, `drizzle.config.ts`, schema tests

- [ ] Write a failing temporary-database test for all required tables and the unique active-timer rule.
- [ ] Implement users, sessions, devices, tasks, daily tasks, focus sessions, active timer, sync operations, change log, conflicts, and settings.
- [ ] Add integer versions, server timestamps, soft deletion, foreign keys, and sync indexes.
- [ ] Run migrations and `PRAGMA integrity_check` in tests.
- [ ] Commit: `feat: add persistent sync database`.

### Task 3: Authentication and device sessions

**Files:** `apps/api/src/auth/**`, `routes/auth.ts`, `routes/devices.ts`, `cli/account.ts`

- [ ] Write failing tests for login, throttling, 30-day cookies, concurrent devices, password change, and SSH reset.
- [ ] Implement Argon2id password hashing and opaque session tokens stored only as hashes.
- [ ] Set HttpOnly, Secure, SameSite=Lax cookies and validate same-origin JSON writes.
- [ ] Implement device rename/revoke, logout current, and logout other sessions.
- [ ] Commit: `feat: add secure single-account sessions`.

### Task 4: Versioned task and settings services

**Files:** `apps/api/src/services/tasks.ts`, `settings.ts`, related routes and tests

- [ ] Write failing tests for task creation, editing, today planning, completion, restore, archive, soft deletion, and setting limits.
- [ ] Implement transactional writes that increment versions and append change-log entries.
- [ ] Preserve history by soft deleting synchronized entities.
- [ ] Commit: `feat: add versioned study data services`.

### Task 5: Idempotent incremental synchronization

**Files:** `apps/api/src/sync/**`, `routes/sync.ts`, sync integration tests

- [ ] Write failing tests for duplicate operation IDs, cursor pagination, retries, and non-blocking open conflicts.
- [ ] Store operation receipts and apply mutation plus change-log append in one transaction.
- [ ] Apply last-server-accepted-write behavior to ordinary fields.
- [ ] Create conflicts instead of overwriting delete, completion, or archive disagreements.
- [ ] Commit: `feat: add idempotent incremental sync`.

### Task 6: Global server timer

**Files:** `apps/api/src/services/timer.ts`, `routes/timer.ts`, timer tests

- [ ] Write failing tests for simultaneous starts, stale versions, pause/resume math, and completion idempotency.
- [ ] Use an immediate SQLite transaction to enforce one active timer.
- [ ] Return server time for client calibration.
- [ ] Generate exactly one focus record and sync change on completion or exit.
- [ ] Commit: `feat: add globally unique focus timer`.

### Task 7: IndexedDB replica and offline queue

**Files:** `apps/web/src/db/**`, `apps/web/src/sync/**`, engine tests

- [ ] Write fake-IndexedDB tests for optimistic updates, ordered retries, acknowledgement, login expiry, and incremental pull.
- [ ] Add Dexie tables for replicas, queue, metadata, conflicts, and cached timer.
- [ ] Sync after online edits, startup, foreground return, reconnect, manual action, and every 30 seconds.
- [ ] Retain queued work through reloads and authentication expiry.
- [ ] Commit: `feat: add offline-first browser synchronization`.

### Task 8: Account, sync, device, and conflict UI

**Files:** `apps/web/src/features/auth/**`, `sync/**`, `devices/**`, `conflicts/**`, component tests

- [ ] Test login, sync status and queue count, device revocation, password change, and all conflict choices.
- [ ] Implement the approved UI using existing visual tokens and accessible dialogs.
- [ ] Replace direct localStorage reads with the IndexedDB replica.
- [ ] Preserve pending work during reauthentication.
- [ ] Commit: `feat: connect synchronized account experience`.

### Task 9: Multi-device offline-aware timer UI

**Files:** `apps/web/src/features/timer/**`, dual-browser tests

- [ ] Test server clock calibration, another-device changes, existing-timer redirects, stale controls, and offline divergence.
- [ ] Calculate the visible countdown locally from calibrated server timestamps.
- [ ] Queue offline controls and show explicit reconciliation when states are incompatible.
- [ ] Verify two isolated browser contexts share one timer.
- [ ] Commit: `feat: synchronize the global timer across devices`.

### Task 10: PWA, Docker, HTTPS, backup, and recovery

**Files:** PWA configuration, `Dockerfile`s, `compose.yml`, `Caddyfile`, `.env.example`, `scripts/*.sh`, deployment guide

- [ ] Test offline reopening after one successful online visit.
- [ ] Implement application-shell caching; keep API data in IndexedDB.
- [ ] Add non-root Web/API containers, internal networking, Caddy TLS routing, health checks, and bounded logs.
- [ ] Implement SQLite online backup, gzip, integrity check, 30-day retention, restore rollback, and pre-update backup.
- [ ] Run a clean Docker smoke test that creates data, backs up, removes, restores, and verifies it.
- [ ] Commit: `feat: ship self-hosted synchronized PWA`.

## Final Verification

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` passes.
- [ ] Two-browser online/offline/reconnect Playwright tests pass.
- [ ] Docker Compose starts on a clean Debian-compatible environment.
- [ ] Only ports 80 and 443 are public.
- [ ] Secure cookie attributes and secret-free logs are verified.
- [ ] Backup integrity and fresh-directory restoration are verified.
- [ ] Desktop and mobile flows match the approved design.
