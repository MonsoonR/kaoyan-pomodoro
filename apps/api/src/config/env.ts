import { z } from 'zod';
export const EnvSchema=z.object({APP_ORIGIN:z.url(),DATABASE_PATH:z.string().min(1),HOST:z.string().default('127.0.0.1'),PORT:z.coerce.number().int().min(1).max(65535).default(3000)});
export const readEnv=()=>EnvSchema.parse(process.env);
