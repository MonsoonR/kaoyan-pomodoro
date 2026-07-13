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
    expect(restore).toMatch(/realpath/);
    expect(restore).toMatch(/integrity_check/);
  });
});
