import { randomUUID } from 'node:crypto';
import { uuidPattern } from '../../config/env.js';
import { invalid } from './errors.js';
import type { DraftInput, DraftField, FieldDefinition, FieldInput } from './types.js';

const reserved = new Set(
  'id table select from where group order user current_user session_user public schema constraint primary unique references check default null true false insert update delete create alter drop index grant revoke returning limit offset join on as and or not case when then else end column all distinct union having into values foreign key timestamp authorization current_date current_time current_timestamp localtime localtimestamp with recursive window over partition by using only lateral fetch for to do in is like between exists any some ctid oid xmin xmax cmin cmax tableoid'.split(
    ' ',
  ),
);
export function validateIdentifier(name: string, allowId = false) {
  if (
    typeof name !== 'string' ||
    !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name) ||
    name.length > 63 ||
    /^(pg_|sql_|platform_|internal_|schema_)/.test(name) ||
    (reserved.has(name) && !(allowId && name === 'id'))
  ) {
    throw invalid(
      'Names must be lowercase snake_case identifiers, at most 63 characters, excluding reserved names',
    );
  }
}
export function validateTargetSchema(name: string) {
  if (
    !name ||
    Buffer.byteLength(name) > 63 ||
    name.includes('\0') ||
    /^(pg_|information_schema$)/.test(name)
  ) {
    throw invalid('Customer schema is not a supported DDL target');
  }
}
function exactKeys(value: object, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw invalid('Unknown schema property');
}
function validDate(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith('0000')
  )
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
function validateDefault(field: FieldDefinition) {
  const def = field.default;
  if (!def) return;
  if (def.kind === 'current_timestamp') {
    exactKeys(def, ['kind']);
    if (field.type !== 'timestamp')
      throw invalid('Current timestamp defaults require a timestamp field');
    return;
  }
  if (def.kind !== 'literal' || !Object.hasOwn(def, 'value'))
    throw invalid('Unsupported default');
  exactKeys(def, ['kind', 'value']);
  validateScalar(field, def.value);
}
export function validateScalar(field: FieldDefinition, value: unknown) {
  let valid = false;
  switch (field.type) {
    case 'text':
    case 'varchar':
      valid =
        typeof value === 'string' &&
        !value.includes('\0') &&
        [...value].length <= (field.options.length ?? 10000);
      break;
    case 'integer':
      valid =
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= -2147483648 &&
        value <= 2147483647;
      break;
    case 'bigint':
      valid =
        typeof value === 'string' &&
        /^-?\d{1,19}$/.test(value) &&
        BigInt(value) >= -9223372036854775808n &&
        BigInt(value) <= 9223372036854775807n;
      break;
    case 'decimal': {
      if (
        typeof value === 'string' &&
        /^-?\d+(\.\d+)?$/.test(value) &&
        value.length <= 42
      ) {
        const [whole = '', fraction = ''] = value.replace(/^-/, '').split('.');
        valid =
          whole.replace(/^0+/, '').length <=
            field.options.precision! - field.options.scale! &&
          fraction.length <= field.options.scale!;
      }
      break;
    }
    case 'boolean':
      valid = typeof value === 'boolean';
      break;
    case 'uuid':
      valid = typeof value === 'string' && new RegExp(uuidPattern).test(value);
      break;
    case 'date':
      valid = validDate(value);
      break;
    case 'timestamp':
      valid =
        typeof value === 'string' &&
        validDate(value.slice(0, 10)) &&
        /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(
          value,
        ) &&
        Number.isFinite(Date.parse(value));
      break;
    case 'jsonb': {
      const walk = (item: unknown, depth: number): boolean => {
        if (depth > 20) return false;
        if (typeof item === 'string')
          return (
            !item.includes('\0') &&
            !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
              item,
            )
          );
        if (item === null || typeof item === 'boolean') return true;
        if (typeof item === 'number') return Number.isFinite(item);
        if (Array.isArray(item))
          return item.every((child) => walk(child, depth + 1));
        if (item && typeof item === 'object')
          return Object.entries(item).every(
            ([key, child]) => walk(key, depth + 1) && walk(child, depth + 1),
          );
        return false;
      };
      valid =
        walk(value, 0) && Buffer.byteLength(JSON.stringify(value)) <= 8192;
      break;
    }
  }
  if (!valid)
    throw invalid('Value does not match field type or supported limits');
}
export function normalizeDraft(
  input: DraftInput,
  existing: FieldDefinition[] = [],
): { name: string; fields: DraftField[] } {
  exactKeys(input, ['name', 'fields', 'indexes']);
  validateIdentifier(input.name);
  if (!Array.isArray(input.fields) || input.fields.length > 100)
    throw invalid('A table supports at most 100 custom fields');
  const names = new Set<string>();
  const ids = new Set<string>();
  const fields = input.fields.map(
    (item: FieldInput, position): DraftField => {
      if (!item || typeof item !== 'object') throw invalid('Invalid field');
      exactKeys(item, [
        'id',
        'name',
        'type',
        'options',
        'nullable',
        'unique',
        'default',
        'relationship',
        'backfillIntent',
      ]);
      validateIdentifier(item.name);
      if (names.has(item.name)) throw invalid('Duplicate field name');
      names.add(item.name);
      if (
        item.id !== undefined &&
        (!existing.some((field) => field.id === item.id) || ids.has(item.id))
      )
        throw invalid('Unknown or duplicate field ID');
      const id = item.id ?? randomUUID();
      ids.add(id);
      const options = item.options ?? {};
      if (!options || typeof options !== 'object' || Array.isArray(options))
        throw invalid('Invalid type options');
      if (item.type === 'varchar') {
        exactKeys(options, ['length']);
        if (
          !Number.isInteger(options.length) ||
          options.length! < 1 ||
          options.length! > 10000
        )
          throw invalid('Varchar length must be 1–10000');
      } else if (item.type === 'decimal') {
        exactKeys(options, ['precision', 'scale']);
        if (
          !Number.isInteger(options.precision) ||
          options.precision! < 1 ||
          options.precision! > 38 ||
          !Number.isInteger(options.scale) ||
          options.scale! < 0 ||
          options.scale! > options.precision!
        )
          throw invalid('Invalid decimal precision or scale');
      } else {
        if (
          ![
            'text',
            'integer',
            'bigint',
            'boolean',
            'uuid',
            'date',
            'timestamp',
            'jsonb',
          ].includes(item.type)
        )
          throw invalid('Unsupported field type');
        exactKeys(options, []);
      }
      if (
        (item.nullable !== undefined && typeof item.nullable !== 'boolean') ||
        (item.unique !== undefined && typeof item.unique !== 'boolean')
      )
        throw invalid('Invalid field constraints');
      if (item.unique && item.type === 'jsonb')
        throw invalid('JSONB uniqueness is not supported');
      if (
        Object.hasOwn(item, 'default') &&
        (!item.default ||
          typeof item.default !== 'object' ||
          Array.isArray(item.default))
      )
        throw invalid('Defaults must be structured objects');
      if (item.relationship !== undefined) {
        const relationship = item.relationship;
        if (
          !relationship ||
          typeof relationship !== 'object' ||
          Array.isArray(relationship)
        )
          throw invalid('Invalid relationship');
        exactKeys(relationship, ['tableId', 'onDelete']);
        if (
          item.type !== 'uuid' ||
          item.unique ||
          item.default ||
          relationship.onDelete !== 'restrict' ||
          typeof relationship.tableId !== 'string' ||
          !new RegExp(uuidPattern).test(relationship.tableId)
        )
          throw invalid(
            'References require UUID, no uniqueness or default, and restricted deletion',
          );
      }
      const field = {
        id,
        ...(item.relationship
          ? { relationship: { ...item.relationship } }
          : {}),
        name: item.name,
        position,
        type: item.type,
        options: { ...options },
        nullable: item.nullable ?? true,
        unique: item.unique ?? false,
        default: item.default ?? null,
      };
      validateDefault(field);
      if (item.backfillIntent !== undefined) {
        const intent = item.backfillIntent;
        if (!intent || typeof intent !== 'object' || Array.isArray(intent)) throw invalid('Invalid fill intent');
        exactKeys(intent, ['kind', 'value']);
        if (intent.kind !== 'literal' || !Object.hasOwn(intent, 'value') || field.type === 'jsonb' || field.nullable) throw invalid('Fill requires a supported requiredness transition');
        validateScalar(field, intent.value);
        return { ...field, backfillIntent: { kind: 'literal', value: intent.value } };
      }
      return field;
    },
  );
  return { name: input.name, fields };
}
