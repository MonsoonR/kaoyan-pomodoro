import path from 'node:path';

const defaultDatabasePath = './data/development.sqlite';

export function resolveDatabaseSource(input = defaultDatabasePath): string {
  if (input === ':memory:') {
    return input;
  }

  if (path.win32.isAbsolute(input) || path.posix.isAbsolute(input)) {
    return input;
  }

  return path.resolve(input);
}
