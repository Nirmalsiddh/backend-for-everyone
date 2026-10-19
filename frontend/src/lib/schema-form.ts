import { z } from 'zod';
import type { Field, FieldType } from './contracts';
export type FieldForm = {
  id?: string;
  name: string;
  type: FieldType;
  nullable: boolean;
  unique: boolean;
  length: string;
  precision: string;
  scale: string;
  defaultKind: 'none' | 'literal' | 'current_timestamp';
  defaultText: string;
};
export const emptyField = (): FieldForm => ({
  name: '',
  type: 'text',
  nullable: true,
  unique: false,
  length: '200',
  precision: '12',
  scale: '2',
  defaultKind: 'none',
  defaultText: '',
});
export function toForm(field: Field): FieldForm {
  return {
    ...emptyField(),
    ...field,
    nullable: field.nullable ?? true,
    unique: field.unique ?? false,
    length: String(field.options?.length ?? 200),
    precision: String(field.options?.precision ?? 12),
    scale: String(field.options?.scale ?? 2),
    defaultKind: field.default?.kind ?? 'none',
    defaultText:
      field.default?.kind === 'literal'
        ? field.type !== 'jsonb' && typeof field.default.value === 'string'
          ? field.default.value
          : JSON.stringify(field.default.value)
        : '',
  };
}
export function toField(f: FieldForm): Field {
  z.string()
    .regex(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/)
    .max(63)
    .parse(f.name);
  const field: Field = {
    ...(f.id ? { id: f.id } : {}),
    name: f.name,
    type: f.type,
    nullable: f.nullable,
    unique: f.unique,
  };
  if (f.type === 'varchar')
    field.options = {
      length: z.number().int().min(1).max(10000).parse(Number(f.length)),
    };
  if (f.type === 'decimal') {
    const precision = z
      .number()
      .int()
      .min(1)
      .max(38)
      .parse(Number(f.precision));
    field.options = {
      precision,
      scale: z.number().int().min(0).max(precision).parse(Number(f.scale)),
    };
  }
  if (f.defaultKind === 'current_timestamp') {
    if (f.type !== 'timestamp')
      throw new Error('Current timestamp requires a timestamp field');
    field.default = { kind: 'current_timestamp' };
  }
  if (f.defaultKind === 'literal') {
    let value: unknown = f.defaultText;
    if (f.type === 'integer' && !/^-?\d+$/.test(f.defaultText))
      throw new Error('Integer default must be a whole number');
    if (f.type === 'integer')
      value = z
        .number()
        .int()
        .min(-2147483648)
        .max(2147483647)
        .parse(Number(f.defaultText));
    if (f.type === 'boolean') {
      if (!['true', 'false'].includes(f.defaultText))
        throw new Error('Boolean default must be true or false');
      value = f.defaultText === 'true';
    }
    if (f.type === 'jsonb') value = JSON.parse(f.defaultText);
    if (f.type === 'bigint') {
      if (!/^-?\d+$/.test(f.defaultText))
        throw new Error('Invalid bigint default');
      const n = BigInt(f.defaultText);
      if (n < -(2n ** 63n) || n > 2n ** 63n - 1n)
        throw new Error('Bigint outside supported range');
    }
    if (f.type === 'decimal' && !/^-?\d+(?:\.\d+)?$/.test(f.defaultText))
      throw new Error('Invalid decimal default');
    if (f.type === 'uuid') z.uuid().parse(value);
    if (f.type === 'date') z.iso.date().parse(value);
    if (f.type === 'timestamp') z.iso.datetime({ offset: true }).parse(value);
    field.default = { kind: 'literal', value };
  }
  return field;
}

export function validateFields(fields: FieldForm[]) {
  const names = new Set<string>();
  return fields.map((f) => {
    if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(f.name) || f.name.length > 63)
      throw new Error(
        `Field ${f.name || '(unnamed)'} must use lowercase letters, digits and single internal underscores`,
      );
    if (
      f.name === 'id' ||
      /^(pg_|sql_|platform_|internal_|schema_)/.test(f.name)
    )
      throw new Error(`Field name ${f.name} is reserved`);
    if (names.has(f.name)) throw new Error(`Duplicate field: ${f.name}`);
    names.add(f.name);
    if (f.type === 'jsonb' && f.unique)
      throw new Error('JSONB fields cannot be unique');
    return toField(f);
  });
}

export const ownershipWarning =
  'Add the ownership UUID field before the first Apply. Existing fields cannot be changed or removed after the first apply in this version.';
export function tasksPreset(kind: 'owned' | 'server') {
  return {
    name: 'tasks',
    fields: [
      {
        ...emptyField(),
        name: 'title',
        type: 'text' as const,
        nullable: false,
      },
      {
        ...emptyField(),
        name: 'done',
        type: 'boolean' as const,
        defaultKind: 'literal' as const,
        defaultText: 'false',
      },
      ...(kind === 'owned'
        ? [
            {
              ...emptyField(),
              name: 'owner_id',
              type: 'uuid' as const,
              nullable: false,
            },
          ]
        : []),
    ],
  };
}
export function mayReplacePreset(
  dirty: boolean,
  confirmReplace: () => boolean,
) {
  return !dirty || confirmReplace();
}
