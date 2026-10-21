import type { FieldDefinition, Plan } from '../../modules/schema-builder/types.js';
import { conflict } from '../../modules/schema-builder/errors.js';
import { validateScalar } from '../../modules/schema-builder/validation.js';

export type DefaultField = Pick<FieldDefinition, 'name' | 'type' | 'options'>;
// Bounded constant grammar, never an SQL evaluator. No calls, operators, or unapproved casts.
export function normalizeManagedDefault(expression: unknown, descriptor: DefaultField): unknown {
  if (expression === null) return null;
  if (typeof expression !== 'string' || expression.length > 50000) throw conflict('Unsupported managed default expression');
  const casts: Record<string, string[]> = {
    text: ['text'], varchar: ['character varying', 'text'], integer: ['integer'], bigint: ['bigint'], decimal: ['numeric'], boolean: ['boolean'],
  };
  let source = expression;
  // pg_get_expr may parenthesize negative numeric constants.
  if (/^\(-\d+(?:\.\d+)?\)$/.test(source)) source = source.slice(1, -1);
  const cast = source.match(/::([a-z ]+)(?:\(\d+(?:,\d+)?\))?$/);
  if (cast) {
    if (!casts[descriptor.type]?.includes(cast[1]!)) throw conflict('Unsupported managed default cast');
    source = source.slice(0, cast.index);
  }
  let value: unknown;
  const quoted = source.match(/^'((?:[^']|'')*)'$/s);
  if (quoted) value = quoted[1]!.replaceAll("''", "'");
  else if (descriptor.type === 'boolean' && /^(true|false)$/.test(source)) value = source === 'true';
  else if (['integer', 'bigint', 'decimal'].includes(descriptor.type) && /^-?\d+(?:\.\d+)?$/.test(source)) value = source;
  else throw conflict('Unsupported managed default expression');
  if (descriptor.type === 'integer' && typeof value === 'string' && /^-?\d+$/.test(value)) value = Number(value);
  if (descriptor.type === 'bigint' && typeof value === 'string' && /^-?\d+$/.test(value)) value = BigInt(value).toString();
  if (descriptor.type === 'decimal' && typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const negative = value.startsWith('-');
    const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
    const scalar = `${whole!.replace(/^0+(?=\d)/, '')}${fraction.replace(/0+$/, '') ? '.' + fraction.replace(/0+$/, '') : ''}`;
    value = negative && scalar !== '0' ? '-' + scalar : scalar;
  }
  try { validateScalar({ ...descriptor, id: '', position: 0, nullable: true, unique: false, default: null }, value); }
  catch { throw conflict('Managed default does not match its scalar type'); }
  return { kind: 'literal', value };
}
export function expectedDefault(field: FieldDefinition) {
  if (!field.default) return null;
  // Feed our own exact scalar through the same normalization, without SQL execution.
  const text = String(field.default.kind === 'literal' ? field.default.value : '').replaceAll("'", "''");
  return normalizeManagedDefault(field.type === 'boolean' ? String(field.default.kind === 'literal' && field.default.value) : `'${text}'`, field);
}
export function v4CatalogContext(plan: Plan) {
  if (plan.evolution?.version !== 4) throw conflict('Expected v4 field evolution');
  const old = plan.evolution.before?.catalog as { managedDefaultFields?: DefaultField[] } | undefined;
  const fieldId = plan.evolution.bundle.fieldId;
  const changed = plan.definition.fields.find((candidate) => candidate.id === fieldId)!;
  // Only deliberately evolved defaults adopt structured verification; historical defaults stay frozen.
  const descriptors = [...(old?.managedDefaultFields ?? [])];
  if ((plan.evolution.bundle.defaultChanged || plan.evolution.bundle.addition) && !descriptors.some((candidate) => candidate.name === changed.name)) descriptors.push({ name: changed.name, type: changed.type, options: changed.options });
  return { version: 4, managedDefaultFields: descriptors.sort((a, b) => a.name.localeCompare(b.name)) };
}
