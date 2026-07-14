import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

function shellRun() {
  const command = 'bash scripts/tests/maintenance.test.sh && bash scripts/tests/smoke-test.test.sh';
  if (process.platform === 'win32') {
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(root);
    if (!match) throw new Error(`Cannot convert workspace path: ${root}`);
    const drive = match[1]!;
    const rest = match[2]!;
    const path = `/mnt/${drive.toLowerCase()}/${rest.replaceAll('\\', '/')}`;
    return spawnSync('wsl.exe', ['bash', '-lc', `cd '${path.replaceAll("'", "'\\''")}' && ${command}`], {
      encoding: 'utf8',
      timeout: 30_000,
    });
  }
  return spawnSync('bash', ['-lc', command], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('deployment maintenance scripts', () => {
  it('handle readiness failures and serialize maintenance and backup replacement', () => {
    const result = shellRun();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Deployment maintenance script tests passed');
    expect(result.stdout).toContain('Docker smoke infrastructure tests passed');
  }, 35_000);
});
