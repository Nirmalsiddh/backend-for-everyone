export class RuntimeError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) { super(message); }
}
export const badRequest = () => new RuntimeError(400, 'INVALID_REQUEST', 'Invalid runtime request');
export const unauthorized = () => new RuntimeError(401, 'UNAUTHORIZED', 'Valid project API key required');
export const unavailable = () => new RuntimeError(503, 'RUNTIME_UNAVAILABLE', 'Customer database or applied schema is unavailable');
export const notFound = () => new RuntimeError(404, 'NOT_FOUND', 'Resource or row not found');
