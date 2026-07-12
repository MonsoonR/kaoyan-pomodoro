import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveDatabaseSource } from './database-source';

describe('resolveDatabaseSource', () => {
  it.each([
    [':memory:', ':memory:'],
    ['C:\\data\\kaoyan.sqlite', 'C:\\data\\kaoyan.sqlite'],
    ['/var/lib/kaoyan.sqlite', '/var/lib/kaoyan.sqlite'],
  ])('preserves special and absolute path %s', (input, expected) => {
    expect(resolveDatabaseSource(input)).toBe(expected);
  });

  it('resolves a relative path from the current working directory', () => {
    expect(resolveDatabaseSource('./data/test.sqlite')).toBe(path.resolve('./data/test.sqlite'));
  });
});
