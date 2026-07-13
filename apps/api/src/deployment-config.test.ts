import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('self-hosted deployment configuration', () => {
  it('publishes ports only from Caddy and bounds every long-running log', () => {
    const compose = read('compose.yml');
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

  it('makes update readiness failure explicit before enabling edge traffic', () => {
    const update = read('scripts/update.sh');
    expect(update).toMatch(/wait_ready\(\)/);
    expect(update).toMatch(/if ! wait_ready/);
    expect(update.indexOf('if ! wait_ready')).toBeLessThan(
      update.indexOf('up -d caddy'),
    );
    expect(update).toMatch(/Readiness timed out/);
    expect(update).toMatch(/pre-update/i);
  });

  it('serializes maintenance and database backup replacement', () => {
    const update = read('scripts/update.sh');
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
