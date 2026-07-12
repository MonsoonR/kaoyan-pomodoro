import { defineConfig } from 'drizzle-kit';
import { resolveDatabaseSource } from './src/db/database-source';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: resolveDatabaseSource(process.env.DATABASE_PATH),
  },
  strict: true,
  verbose: true,
});
