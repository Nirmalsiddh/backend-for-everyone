// Public documentation DTOs only. No persistence models or credentials.
export interface JsonSchema {
  [keyword: string]: unknown;
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  description?: string;
}
export interface Media {
  schema: JsonSchema;
  example?: unknown;
  examples?: Record<string, { summary: string; value: unknown }>;
}
export interface ApiResponse {
  description: string;
  headers?: Record<string, { description: string; schema: JsonSchema }>;
  content?: Record<string, Media>;
}
export interface ApiOperation {
  operationId: string;
  tags: string[];
  summary: string;
  description: string;
  security: Record<string, string[]>[];
  'x-access-policy': 'public' | 'key_only' | 'authenticated' | 'owner';
  parameters?: {
    name: string;
    in: 'path' | 'query';
    style?: 'form';
    explode?: boolean;
    required?: boolean;
    description?: string;
    schema: JsonSchema;
  }[];
  requestBody?: { required: boolean; content: Record<string, Media> };
  responses: Record<string, ApiResponse>;
}
export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  paths: Record<string, Record<string, ApiOperation>>;
  components: {
    schemas: Record<string, JsonSchema>;
    securitySchemes: Record<
      string,
      {
        type: 'http';
        scheme: 'bearer';
        bearerFormat: string;
        description: string;
      }
    >;
  };
}
