import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('self-hosted deployment configuration', () => {
  it('preserves the Compose integration topology without Kubernetes coupling', () => {
    const compose = read('compose.yml');
    expect(compose).not.toMatch(/kubectl|kubernetes/i);
    expect(compose).toMatch(/caddy:[\s\S]*ports:[\s\S]*"80:80"[\s\S]*"443:443"/);
    for (const service of ['web', 'api', 'backup']) {
      const section = compose.split(new RegExp(`^ {2}${service}:`, 'm'))[1]
        ?.split(/^ {2}\w[\w-]*:/m)[0] ?? '';
      expect(section).not.toMatch(/^\s+ports:/m);
    }
    expect((compose.match(/logging: \*bounded-logging/g) ?? [])).toHaveLength(4);
    expect(compose).toContain('max-size: "10m"');
  });

  it('uses online SQLite backup, integrity checks, locking and safe retention', () => {
    const backup = read('docker/backup/scripts/backup.sh');
    const retention = read('docker/backup/scripts/retention.sh');
    expect(backup).toMatch(/\.backup/);
    expect(backup).toMatch(/integrity_check/);
    expect(backup).toMatch(/flock/);
    expect(backup).not.toMatch(/\bcp\s+[^\n]*sqlite/);
    expect(retention).toMatch(/RETENTION_DAYS:=30/);
    expect(retention).toMatch(/-mtime "\+\$RETENTION_DAYS"/);
    expect(retention).toMatch(/kaoyan-/);
  });

  it('makes restore strict, traversal-safe and rollback-capable', () => {
    const restore = read('scripts/restore.sh');
    expect(restore).toContain('set -Eeuo pipefail');
    expect(restore).toMatch(/pre-restore/);
    expect(restore).toMatch(/rollback/i);
    expect(restore).not.toMatch(/realpath -e "\$requested"/);
    expect(restore).toMatch(/\/backups\/\$name/);
    expect(restore).toMatch(/integrity_check/);
  });

  it('makes Kubernetes the default resumable update entrypoint with safe execution', () => {
    const update = read('scripts/update.sh');
    const k8sUpdate = read('scripts/k8s-update.sh');
    const adminInit = read('scripts/k8s-admin-init.sh');
    expect(update).toContain('scripts/k8s-update.sh');
    expect(update).not.toMatch(/docker compose/);
    expect(k8sUpdate).toContain('action="plan"');
    expect(k8sUpdate).toMatch(/--status/);
    expect(k8sUpdate).toMatch(/--resume/);
    expect(k8sUpdate).toContain('STATE_CONFIGMAP="kaoyan-update-state"');
    expect(k8sUpdate).toMatch(/requires --confirm-context/);
    expect(k8sUpdate).toMatch(/--migration-check-passed/);
    expect(k8sUpdate).toMatch(/must not use latest/);
    expect(k8sUpdate).toMatch(/sha-\(\[0-9a-f\]\{40\}\)@sha256/);
    expect(k8sUpdate).toMatch(/scale deployment kaoyan-web --replicas=0/);
    expect(k8sUpdate).toMatch(/scale deployment kaoyan-api --replicas=0/);
    expect(k8sUpdate.indexOf('scale deployment kaoyan-web --replicas=0')).toBeLessThan(
      k8sUpdate.indexOf('scale deployment kaoyan-api --replicas=0'),
    );
    expect(k8sUpdate).toMatch(/create job --from=cronjob\/kaoyan-backup/);
    expect(k8sUpdate).toMatch(/No image rollback, SQLite restore or down migration was attempted/);
    for (const script of [k8sUpdate, adminInit]) {
      expect(script).toContain('automountServiceAccountToken: false');
      expect(script).toContain('allowPrivilegeEscalation: false');
      expect(script).toContain('drop: ["ALL"]');
      expect(script).not.toContain('hostPath:');
    }
    expect(adminInit).toContain('dist/cli/account.js", "init"');
  });

  it('keeps Kubernetes database restore explicit, stopped, PVC-scoped and non-restarting', () => {
    const restore = read('scripts/k8s-restore-backup.sh');
    expect(restore).toContain('mode="plan"');
    expect(restore).toMatch(/--execute requires --confirm-restore/);
    expect(restore).toMatch(/API replicas.*"0"/);
    expect(restore).toMatch(/Web replicas.*"0"/);
    expect(restore).toContain('claimName: kaoyan-data');
    expect(restore).toContain('claimName: kaoyan-backups');
    expect(restore).toContain('deploy.sagirii.me/node-id');
    expect(restore).toContain('guilyrh');
    expect(restore).not.toContain('hostPath:');
    expect(restore).not.toMatch(/k scale deployment/);
    expect(restore).not.toMatch(/k set image/);
    expect(restore).toMatch(/PRAGMA integrity_check/);
    expect(restore).toMatch(/stat -c '%u:%g:%a'/);
  });

  it('serializes maintenance and database backup replacement', () => {
    const update = read('scripts/legacy-compose-update.sh');
    const restore = read('scripts/restore.sh');
    const restoreDb = read('docker/backup/scripts/restore-db.sh');
    for (const script of [update, restore]) {
      expect(script).toContain('.maintenance.lock');
      expect(script).toMatch(/flock/);
    }
    expect(restoreDb).toContain('.backup.lock');
    expect(restoreDb).toMatch(/flock/);
  });

  it('sets defensive no-store headers for exact and nested API paths', () => {
    for (const path of ['Caddyfile', 'Caddyfile.test']) {
      const caddy = read(path);
      expect(caddy).toMatch(/@api path \/api \/api\/\*/);
      expect(caddy).toMatch(/header @api Cache-Control "no-store"/);
    }
  });
});
