import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const localDataDirectory = path.join(rootDirectory, '.local-data');
const databasePath = path.join(localDataDirectory, 'kaoyan.sqlite');
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function spawnPnpm(args, options) {
  if (process.platform === 'win32') {
    return spawn(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', pnpmCommand, ...args],
      options,
    );
  }
  return spawn(pnpmCommand, args, options);
}

function prefixOutput(stream, destination, label) {
  let buffered = '';

  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r\n|\n|\r/);
    buffered = lines.pop() ?? '';
    for (const line of lines) destination.write(`[${label}] ${line}\n`);
  });
  stream.on('end', () => {
    if (buffered !== '') destination.write(`[${label}] ${buffered}\n`);
  });
}

function describeExit(code, signal) {
  if (signal) return `signal ${signal}`;
  return `exit code ${code ?? 'unknown'}`;
}

function checkPortAvailable({ port, host, service }) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} (${service}) is already in use.`));
        return;
      }
      reject(
        new Error(
          `Cannot reserve port ${port} (${service}) on ${host}: ${error.message}`,
        ),
      );
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

function runPnpm(args, { env = process.env, label, interactive = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnPnpm(args, {
      cwd: rootDirectory,
      env,
      stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });

    if (!interactive) {
      prefixOutput(child.stdout, process.stdout, label ?? 'setup');
      prefixOutput(child.stderr, process.stderr, label ?? 'setup');
    }

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${pnpmCommand} ${args.join(' ')} failed with ${describeExit(code, signal)}.`,
        ),
      );
    });
  });
}

async function terminateProcessTree(child, label) {
  if (!child.pid) return;

  if (process.platform === 'win32') {
    process.stdout.write(`[local] Stopping ${label} process tree (PID ${child.pid})...\n`);
    await new Promise((resolve) => {
      const killer = spawn(
        'taskkill.exe',
        ['/pid', String(child.pid), '/T', '/F'],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      killer.once('error', (error) => {
        process.stderr.write(
          `[local] Could not stop ${label} process tree: ${error.message}\n`,
        );
        resolve();
      });
      killer.once('exit', (code) => {
        if (code !== 0 && child.exitCode === null) {
          process.stderr.write(
            `[local] taskkill failed for ${label} process tree (exit code ${code}).\n`,
          );
        }
        resolve();
      });
    });
    return;
  }

  if (child.exitCode !== null || child.signalCode !== null) return;

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function spawnService({ label, args, env }) {
  const child = spawnPnpm(args, {
    cwd: rootDirectory,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  prefixOutput(child.stdout, process.stdout, label);
  prefixOutput(child.stderr, process.stderr, label);
  return { child, label };
}

async function runAccountInitialization() {
  await mkdir(localDataDirectory, { recursive: true });
  process.stdout.write(`[local] Database: ${databasePath}\n`);
  await runPnpm(['--filter', '@kaoyan/api', 'account:init'], {
    env: { ...process.env, DATABASE_PATH: databasePath },
    interactive: true,
  });
}

async function runDevelopmentServers() {
  await mkdir(localDataDirectory, { recursive: true });
  await Promise.all([
    checkPortAvailable({ port: 3000, host: '127.0.0.1', service: 'API' }),
    checkPortAvailable({ port: 5173, host: '0.0.0.0', service: 'Web' }),
  ]);

  process.stdout.write(`[local] Database: ${databasePath}\n`);
  process.stdout.write('[local] Building shared contracts...\n');
  await runPnpm(['--filter', '@kaoyan/contracts', 'build'], { label: 'setup' });

  const services = [
    spawnService({
      label: 'api',
      args: [
        '--filter',
        '@kaoyan/api',
        'exec',
        'tsx',
        'watch',
        'src/server.ts',
      ],
      env: {
        ...process.env,
        APP_ORIGIN: 'http://localhost:5173',
        DATABASE_PATH: databasePath,
        HOST: '127.0.0.1',
        PORT: '3000',
        TRUST_PROXY_HOPS: '0',
      },
    }),
    spawnService({
      label: 'web',
      args: [
        '--filter',
        '@kaoyan/web',
        'exec',
        'vite',
        '--host',
        '0.0.0.0',
        '--port',
        '5173',
        '--strictPort',
      ],
      env: {
        ...process.env,
        KAOYAN_API_ORIGIN: 'http://127.0.0.1:3000',
      },
    }),
  ];

  process.stdout.write('[local] Web: http://localhost:5173\n');
  process.stdout.write('[local] API: http://127.0.0.1:3000\n');

  let shuttingDown = false;
  let pendingUnexpectedExit;

  const shutdown = async (exitCode, message) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (pendingUnexpectedExit) clearTimeout(pendingUnexpectedExit);
    process.stdout.write(`${message}\n`);
    await Promise.all(
      services.map(({ child, label }) => terminateProcessTree(child, label)),
    );
    try {
      await Promise.all([
        checkPortAvailable({ port: 3000, host: '127.0.0.1', service: 'API' }),
        checkPortAvailable({ port: 5173, host: '0.0.0.0', service: 'Web' }),
      ]);
    } catch (error) {
      process.stderr.write(`[local] Shutdown incomplete: ${error.message}\n`);
      process.exit(1);
    }
    process.exit(exitCode);
  };

  const scheduleUnexpectedShutdown = (message) => {
    if (shuttingDown || pendingUnexpectedExit) return;
    pendingUnexpectedExit = setTimeout(() => {
      void shutdown(1, message);
    }, 100);
  };

  for (const { child, label } of services) {
    child.once('error', (error) => {
      scheduleUnexpectedShutdown(
        `[local] ${label} failed to start: ${error.message}`,
      );
    });
    child.once('exit', (code, signal) => {
      if (!shuttingDown) {
        scheduleUnexpectedShutdown(
          `[local] ${label} exited unexpectedly (${describeExit(code, signal)}). Stopping all services.`,
        );
      }
    });
  }

  process.once('SIGINT', () => {
    void shutdown(0, '[local] Ctrl+C received. Stopping API and Web...');
  });
  process.once('SIGTERM', () => {
    void shutdown(0, '[local] Termination requested. Stopping API and Web...');
  });
  if (process.platform !== 'win32') {
    process.once('SIGHUP', () => {
      void shutdown(0, '[local] Terminal closed. Stopping API and Web...');
    });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    await runDevelopmentServers();
    return;
  }
  if (args.length === 1 && args[0] === '--init-account') {
    await runAccountInitialization();
    return;
  }
  throw new Error('Usage: node scripts/dev-local.mjs [--init-account]');
}

main().catch((error) => {
  process.stderr.write(
    `[local] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
