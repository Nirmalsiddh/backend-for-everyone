import type {
  CredentialEncryption,
  EncryptedPayload,
} from '../security/encryption.js';
import type { SchemaClient } from '../database/customer-db/schema-executor.js';
import { quoteIdentifier } from '../modules/schema-builder/plan.js';
const prefix = 'platform-recovery-v1:';
export async function writeReceipt(
  client: SchemaClient,
  encryption: CredentialEncryption,
  schema: string,
  table: string,
  context: string,
  catalog: unknown,
) {
  const receipt =
    prefix + JSON.stringify(encryption.encrypt({ catalog }, context));
  await client.query(
    `COMMENT ON TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(table)} IS '${receipt.replaceAll("'", "''")}'`,
  );
}
export async function readReceipt(
  client: SchemaClient,
  encryption: CredentialEncryption,
  schema: string,
  table: string,
  context: string,
): Promise<unknown | undefined> {
  const [row] = (
    await client.query(
      "SELECT obj_description(c.oid, 'pg_class') AS receipt FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2",
      [schema, table],
    )
  ).rows;
  if (typeof row?.receipt !== 'string' || !row.receipt.startsWith(prefix))
    return undefined;
  try {
    return encryption.decrypt<{ catalog: unknown }>(
      JSON.parse(row.receipt.slice(prefix.length)) as EncryptedPayload,
      context,
    ).catalog;
  } catch {
    return undefined;
  }
}
