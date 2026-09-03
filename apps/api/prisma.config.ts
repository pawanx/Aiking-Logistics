/**
 * Prisma CLI configuration — Prisma 7 moved the connection URL out of
 * schema.prisma's datasource block and into this file.
 *
 * This governs the CLI only (`prisma migrate`, `prisma db push`, `prisma studio`).
 * At runtime the application supplies its own connection through the
 * node-postgres driver adapter — see src/common/prisma/prisma.service.ts.
 */
import path from 'node:path';
import dotenv from 'dotenv';
import { defineConfig, env } from 'prisma/config';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '.env') });

export default defineConfig({
  schema: 'prisma/schema.prisma',

  datasource: {
    url: env('DATABASE_URL') || process.env.DATABASE_URL || 'postgresql://aiking:aiking@localhost:5432/aiking?schema=public',
  },

  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node --transpile-only prisma/seed.ts',
  },
});
