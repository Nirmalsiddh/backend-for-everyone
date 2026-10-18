export class SchemaError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const invalid = (message: string) =>
  new SchemaError(400, 'INVALID_SCHEMA', message);
export const conflict = (message: string) =>
  new SchemaError(409, 'SCHEMA_CONFLICT', message);
export const missing = () =>
  new SchemaError(404, 'SCHEMA_NOT_FOUND', 'Schema definition not found');
