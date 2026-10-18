import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/platform-db/schema.ts',
  out: './migrations',
});
