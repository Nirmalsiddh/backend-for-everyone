'use client';
import { maxFilterClauses, maxInValues } from '../../../shared/runtime-query.js';
import type {
  QueryCapabilities,
  PublicFilter,
  FilterOperator,
} from '../../../shared/runtime-query.js';

export interface FilterRow {
  field: string;
  operator: FilterOperator;
  value: string;
  values: string[];
}

export function publicFilters(
  rows: FilterRow[],
  capabilities?: QueryCapabilities,
): PublicFilter[] {
  if (rows.length > maxFilterClauses)
    throw new Error('Maximum five filter clauses');
  const seen = new Set<string>();
  return rows.map((row) => {
    const field = capabilities?.fields.find((field) => field.name === row.field);
    const pair = `${row.field}:${row.operator}`;
    if (!field?.operators.includes(row.operator) || seen.has(pair))
      throw new Error('Choose valid, unique field/operator pairs');
    seen.add(pair);
    if (row.operator === 'in') {
      if (!row.values.length || row.values.length > maxInValues)
        throw new Error('IN requires 1–25 values');
      return { field: row.field, operator: 'in', values: row.values };
    }
    return { field: row.field, operator: row.operator, value: row.value };
  });
}

export function QueryFilters({
  rows,
  capabilities,
  disabled,
  onChange,
}: {
  rows: FilterRow[];
  capabilities?: QueryCapabilities;
  disabled: boolean;
  onChange: (rows: FilterRow[]) => void;
}) {
  const fields = capabilities?.fields ?? [];
  const update = (index: number, patch: Partial<FilterRow>) =>
    onChange(rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  return (
    <fieldset disabled={disabled}>
      <legend>Filters (AND, maximum five clauses)</legend>
      {rows.map((row, index) => (
        <fieldset key={index}>
          <legend>Filter {index + 1}</legend>
          <label>
            Field {index + 1}
            <select
              aria-label={`Field ${index + 1}`}
              value={row.field}
              onChange={(event) => update(index, {
                field: event.target.value, operator: 'eq', value: '', values: [''],
              })}
            >
              {fields.map((field) => (
                <option key={field.name} value={field.name}>{field.name}</option>
              ))}
            </select>
          </label>
          <label>
            Operator {index + 1}
            <select
              aria-label={`Operator ${index + 1}`}
              value={row.operator}
              onChange={(event) => update(index, {
                operator: event.target.value as FilterOperator,
                value: event.target.value === 'is_null' ? 'true' : '',
                values: [''],
              })}
            >
              {(fields.find((field) => field.name === row.field)?.operators ?? [])
                .map((operator) => <option key={operator}>{operator}</option>)}
            </select>
          </label>
          {row.operator === 'in' ? (
            <fieldset>
              <legend>IN values (maximum 25)</legend>
              {row.values.map((value, item) => (
                <div className="row" key={item}>
                  <label>
                    Filter {index + 1} value {item + 1}
                    <input
                      value={value}
                      onChange={(event) => update(index, {
                        values: row.values.map((old, i) => i === item ? event.target.value : old),
                      })}
                    />
                  </label>
                  <button
                    type="button"
                    aria-label={`Remove filter ${index + 1} value ${item + 1}`}
                    disabled={row.values.length === 1}
                    onClick={() => update(index, {
                      values: row.values.filter((_, i) => i !== item),
                    })}
                  >Remove value</button>
                </div>
              ))}
              <button
                type="button"
                disabled={row.values.length >= maxInValues}
                onClick={() => update(index, { values: [...row.values, ''] })}
              >Add IN value</button>
            </fieldset>
          ) : row.operator === 'is_null' ? (
            <label>
              NULL selection {index + 1}
              <select
                aria-label={`NULL selection ${index + 1}`}
                value={row.value}
                onChange={(event) => update(index, { value: event.target.value })}
              >
                <option value="true">NULL</option>
                <option value="false">Non-NULL</option>
              </select>
            </label>
          ) : (
            <label>
              Value {index + 1}
              <input
                value={row.value}
                onChange={(event) => update(index, { value: event.target.value })}
              />
            </label>
          )}
          <button
            type="button"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >Remove filter {index + 1}</button>
        </fieldset>
      ))}
      <button
        type="button"
        disabled={!fields.length || rows.length >= maxFilterClauses}
        onClick={() => onChange([
          ...rows,
          { field: fields[0]!.name, operator: 'eq', value: '', values: [''] },
        ])}
      >Add filter</button>
    </fieldset>
  );
}
