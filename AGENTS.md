# Repository Guidelines

## Product & Scope

Build a Backend-as-a-Service/API builder incrementally. Customers retain application data in their own PostgreSQL databases. Our platform database stores users, projects, schema and endpoint metadata, encrypted connection credentials, workflow configuration, API key metadata, and sanitized logs. Complete and verify the foundation milestone before adding customer database connections or runtime endpoints.

## Architecture & Organization

Backend code lives in `backend/src/`. Keep `app.ts` independently testable and put process startup in `server.ts`. Management routes use `/internal`; future customer runtime routes use `/api/{project-slug}`. Keep route handlers thin, business rules in services, and platform queries in repositories under `modules/`. Platform database schema and lifecycle code belong in `database/platform-db/`; reviewed SQL migrations belong in `backend/migrations/`. Add customer database and workflow modules only when implementing those milestones.

## Development & Validation

Use Node.js 24 LTS, TypeScript strict mode, Fastify, PostgreSQL, and Drizzle for platform persistence. From `backend/`, run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`. Use `npm run dev` for local development, `npm run db:generate` for migrations, and `npm run db:migrate` to apply them. Database integration tests require an explicit `TEST_DATABASE_URL` pointing to a disposable database. Keep setup instructions and environment examples current.

## Coding & Testing

Use two-space indentation, ESM imports, descriptive names, and small modules. Validate all external input. Use Fastify JSON Schema for developer-authored management routes; never compile customer-provided schemas as code. Test business behavior, ownership isolation, invalid input, authorization failures, and database constraints. Tests use Node’s test runner and Fastify injection; integration tests exercise real PostgreSQL.

## Security Boundaries

Never expose database credentials, log secrets, interpolate values into SQL, or accept unrestricted SQL. Future dynamic queries must allowlist identifiers against project schema metadata, parameterize values, and enforce limits and timeouts. Keep project ownership checks in persistence queries. Do not execute arbitrary customer code. Workflow execution must eventually support bounded conditional branching and atomic database operations.

## Contributions

Explain major architectural changes and new major dependencies before introducing them. Use focused imperative commits. Pull requests should explain behavior, scope, validation, and configuration changes. Never commit credentials or `.env` files. Do not claim unimplemented features or unrun checks work.
