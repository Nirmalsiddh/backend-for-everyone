// Cold-process verification: no state from the applying service is reused.
import { createPlatformDatabase } from '../../src/database/platform-db/client.js';
import { PostgresSchemaRepository } from '../../src/modules/schema-builder/repository.js';
import { PostgresProjectRepository } from '../../src/modules/projects/repository.js';
import { PostgresRuntimeRepository } from '../../src/runtime/repository.js';
import { buildApp } from '../../src/app.js';
import { memoryPlatformAuthRepository } from '../platform-auth-helpers.js';
import { env } from '../helpers.js';
const { db, pool } = createPlatformDatabase(process.env.TEST_DATABASE_URL!);
const table = await new PostgresSchemaRepository(db).get(process.env.RESTART_PROJECT!, process.env.RESTART_OWNER!, process.env.RESTART_TABLE!);
const app = buildApp({ env, projectRepository: new PostgresProjectRepository(db), platformAuthRepository: memoryPlatformAuthRepository(process.env.RESTART_OWNER!), runtimeRepository: new PostgresRuntimeRepository(db), logger: false });
const response = await app.inject({ url: `/api/${process.env.RESTART_SLUG}/products?limit=1`, headers: { authorization: `Bearer ${process.env.RESTART_KEY}` } });
process.stdout.write(JSON.stringify({ status: response.statusCode, indexCount: table.indexes?.length, appliedRevision: table.appliedRevision, appliedPhysicalRevision: table.appliedPhysicalRevision, titleNullable: table.appliedDefinition!.definition.fields.find((field) => field.name === 'title')!.nullable }));
await app.close(); await pool.end();
