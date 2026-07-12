import { z } from 'zod';

const AppOriginSchema = z.url().transform((value, context) => {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    context.addIssue({
      code: 'custom',
      message:
        'APP_ORIGIN must be an HTTP(S) origin without credentials, path, query, or fragment',
    });
    return z.NEVER;
  }
  return url.origin;
});

export type TrustProxyHops = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
const TrustProxyHopsSchema = z.coerce
  .number()
  .int()
  .min(0)
  .max(10)
  .transform((value) => value as TrustProxyHops);

export const EnvSchema = z.object({
  APP_ORIGIN: AppOriginSchema,
  DATABASE_PATH: z.string().min(1),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  TRUST_PROXY_HOPS: TrustProxyHopsSchema.default(1),
});

export const readEnv = () => EnvSchema.parse(process.env);
