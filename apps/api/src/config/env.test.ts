import { describe, expect, it } from 'vitest';

import { EnvSchema } from './env';

const base = { DATABASE_PATH: ':memory:' };

describe('authentication environment configuration', () => {
  it('normalizes an APP_ORIGIN trailing slash and parses trusted proxy hops', () => {
    const withoutSlash = EnvSchema.parse({
      ...base,
      APP_ORIGIN: 'https://study.example.com',
      TRUST_PROXY_HOPS: '1',
    });
    const withSlash = EnvSchema.parse({
      ...base,
      APP_ORIGIN: 'https://study.example.com/',
      TRUST_PROXY_HOPS: '1',
    });
    expect(withSlash).toMatchObject({
      APP_ORIGIN: 'https://study.example.com',
      TRUST_PROXY_HOPS: 1,
    });
    expect(withSlash.APP_ORIGIN).toBe(withoutSlash.APP_ORIGIN);
  });

  it.each([
    'https://user:password@study.example.com',
    'https://study.example.com?query=yes',
    'https://study.example.com/#fragment',
  ])('rejects an unsafe APP_ORIGIN: %s', (APP_ORIGIN) => {
    expect(() => EnvSchema.parse({ ...base, APP_ORIGIN })).toThrow();
  });

  it.each(['-1', '11', '1.5'])(
    'rejects invalid trusted proxy hops: %s',
    (TRUST_PROXY_HOPS) => {
      expect(() =>
        EnvSchema.parse({
          ...base,
          APP_ORIGIN: 'https://study.example.com',
          TRUST_PROXY_HOPS,
        }),
      ).toThrow();
    },
  );
});
