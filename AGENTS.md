# Repository Guidelines

## Product & Scope

Build a Backend-as-a-Service/API builder incrementally. Customers retain application data in their own PostgreSQL databases. Our platform database stores users, projects, schema and endpoint metadata, encrypted connection credentials, workflow configuration, API key metadata, and sanitized logs. The implemented system includes customer connections, schema evolution, runtime APIs, application authentication, bounded workflows and the Taskforge Guided Builder. Keep the guided hackathon flow focused; document advanced capabilities separately.

## Architecture & Organization

Backend code lives in `backend/src/`. Keep `app.ts` independently testable and put process startup in `server.ts`. Management routes use `/internal`; customer runtime routes use `/api/{project-slug}`. Keep route handlers thin, business rules in services, and platform queries in repositories under `modules/`. Platform database schema and lifecycle code belong in `database/platform-db/`; reviewed SQL migrations belong in `backend/migrations/`. Dashboard code lives in `frontend/src/`; shared public contracts live in `shared/`. Keep public DTOs separate from persistence models.

## Development & Validation

Use Node.js 24 LTS, TypeScript strict mode, Fastify, PostgreSQL, and Drizzle for platform persistence. From `backend/`, run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`. Use `npm run dev` for local development, `npm run db:generate` for migrations, and `npm run db:migrate` to apply them. Database integration tests require explicit, separate disposable platform/customer databases; optional upgrade fixtures need additional empty databases. See [testing](docs/testing.md). Run frontend checks from `frontend/` as well when affected. Keep setup instructions and environment examples current.

## Coding & Testing

Use two-space indentation, ESM imports, descriptive names, and small modules. Validate all external input. Use Fastify JSON Schema for developer-authored management routes; never compile customer-provided schemas as code. Test business behavior, ownership isolation, invalid input, authorization failures, and database constraints. Tests use Node’s test runner and Fastify injection; integration tests exercise real PostgreSQL.

## Security Boundaries

Never expose database credentials, log secrets, interpolate values into SQL, or accept unrestricted SQL. Dynamic queries must allowlist identifiers against project schema metadata, parameterize values, and enforce limits and timeouts. Keep project ownership checks in persistence queries. Do not execute arbitrary customer code. Preserve bounded workflow branching, ownership checks and atomic database operations. Never automatically replay uncertain writes or DDL; use the recovery runbook.

## Contributions

Explain major architectural changes and new major dependencies before introducing them. Use focused imperative commits. Pull requests should explain behavior, scope, validation, and configuration changes. Never commit credentials or `.env` files. Do not claim unimplemented features or unrun checks work.

## Documentation

Keep [README](README.md) as the setup/product entry point and [Taskforge](TASKFORGE.md) as the hackathon walkthrough. Maintain technical contracts in `docs/` and operator procedures in `deploy/`. Preserve pre-existing-work and AI-assistance disclosures. Label historical evidence; never present old test totals as current validation.
