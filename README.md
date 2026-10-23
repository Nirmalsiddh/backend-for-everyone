# Backend for Everyone

Backend for Everyone helps students, frontend developers and solo builders turn an app idea into a working PostgreSQL-backed API. The Guided Builder provides a focused Task Manager path: confirm the fields, choose actions, review, and create the backend without writing server routes or SQL.

The problem is the gap between finishing an interface and connecting it to persistent data. The product reduces that setup work while keeping the database under the developer's control.

## What it does

- Platform signup/login and projects owned by individual developers.
- Encrypted connection configuration for customer-owned PostgreSQL databases.
- Guided Tasks storage and Create, View, Edit and Delete actions.
- Explicit API-key creation, Playground requests and a fetch example.
- Recognition of matching Backend Ready configurations after reload.

The platform also supports a schema builder, application authentication and ownership policies, transactional workflows, relationships, bounded queries, generated OpenAPI/TypeScript clients and best-effort runtime history. The Guided Builder offers a simpler path through the core storage and CRUD capabilities. See the [platform reference](docs/platform-reference.md).

## How it fits together

```text
Browser → Next.js dashboard → Fastify management API → Platform PostgreSQL
                             Fastify runtime API    → Customer PostgreSQL
```

Platform PostgreSQL stores accounts, project/configuration metadata, encrypted connection settings and sanitized runtime events. Application rows and application-user accounts stay in customer PostgreSQL. Platform sessions, project API keys and application sessions have separate purposes.

The stack is Node.js 24 LTS, strict TypeScript, Fastify, PostgreSQL and Drizzle on the backend; Next.js, React, TanStack Query, React Hook Form and Zod on the dashboard. Read the [architecture](docs/architecture.md) for trust boundaries and failure handling.

## Run locally

Requirements: Node.js 24 LTS, npm, PostgreSQL 16 or newer, and two separate databases:

- A dedicated **platform database** for metadata. Its migration role needs DDL privileges.
- A noncritical **customer/demo database**, with an existing schema such as `public`. Its role needs table-creation and CRUD privileges.

Create those databases with your PostgreSQL administration tool before continuing. The application does not provision databases or customer schemas. Do not use production data.

From the repository root:

```sh
npm ci --prefix backend
npm ci --prefix frontend
```

If configuration files do not already exist, copy `backend/.env.example` to `backend/.env` and `frontend/.env.example` to `frontend/.env.local`. Preserve existing configuration. These files must remain outside Git.

Configure the backend:

| Setting | Local value / purpose |
| --- | --- |
| `PLATFORM_DATABASE_URL` | Connection URL for the platform database, not the demo database |
| `CONNECTION_ENCRYPTION_KEY` | Stable, securely generated 64-character hexadecimal key |
| `PUBLIC_RUNTIME_ORIGIN` | `http://127.0.0.1:3000` |
| `CUSTOMER_DB_POLICY` | `development` for local disposable databases |
| `RUNTIME_ALLOWED_ORIGINS` | Exact browser-app origins if integrating a separate frontend; no wildcards |

Generate the encryption key privately with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep the key across restarts and back it up separately from PostgreSQL. Losing it makes saved connection credentials unreadable. Hosted connections have different destination/TLS requirements; see [deployment](deploy/README.md).

Configure the frontend's server environment:

```text
BACKEND_ORIGIN=http://127.0.0.1:3000
PUBLIC_RUNTIME_ORIGIN=http://127.0.0.1:3000
DASHBOARD_ORIGIN=http://127.0.0.1:3001
DASHBOARD_COOKIE_MODE=local-http
```

Database URLs and the encryption key belong only in backend configuration. Apply reviewed platform migrations explicitly, then start the backend:

```sh
npm run db:migrate --prefix backend
npm run dev --prefix backend
```

In another terminal:

```sh
npm run dev --prefix frontend
```

Open [local signup](http://127.0.0.1:3001/signup), create an account with a password of at least 15 characters, then sign in. Both development servers bind to loopback. For local production builds, each package has `build` and `start` scripts; hosted operation requires the secure deployment configuration.

## Try the guided flow

1. Create a project and open Database.
2. Test and save the dedicated demo database connection. Use its existing schema; disable SSL only for a trusted local test connection.
3. Open Guided Builder, select the Task Manager actions, review and create the backend.
4. On Backend Ready, create and privately copy a demo key.
5. Open Test Create Task in Playground, choose API key credentials and POST a task. Then open Test View Tasks, supply the key again and GET the list.
6. Return to Guided Builder and reload: matching saved configuration should still show Backend Ready.

The Task Manager template has required `title`, optional `description`, required `completed` (default `false`), optional `due_date`, and an automatically generated UUID primary key. View tasks enables both list and single-task reads; Edit tasks uses PATCH.

For Test Create Task, send:

```json
{"title":"Finish assignment","completed":false}
```

Expect HTTP 201. Open Test View Tasks, choose API key credentials and paste the same key again; GET/list should return the same task ID and values. Credentials clear when leaving Playground. Keys are shown once and clear from component memory when the dialog closes; clipboard and browser tooling are outside that guarantee. Use the placeholder-based fetch example on Ready to integrate from trusted code.

Backend Ready confirms saved storage and API configuration; successful runtime requests verify the API separately. Existing matching configurations open Ready after reload without recreation. Choices reset if setup has not completed. Missing connections, conflicting configurations and incomplete operations require review through the linked management pages; there is no automatic repair or mutation replay.

Playground uses a same-origin relay. A separate browser frontend needs its origin in the runtime CORS allowlist; Playground success does not verify that integration.

## Status and limitations

The project is in private alpha, with local development and one-server deployment tooling. The Guided Builder has recorded real PostgreSQL create/list and reload acceptance; [testing documentation](docs/testing.md) separates historical evidence from commands to rerun checks.

- PostgreSQL and the target schema must already exist. Connectivity checks do not prove every future DDL/CRUD permission.
- The Guided Builder does not configure application login or owner-level private task access. Configure application auth and ownership policies separately for user-specific data.
- Project keys are shared credentials. Keep write keys in trusted code; do not publish them in browser bundles.
- Incomplete or uncertain setup requires review. Submitted writes and DDL are never automatically replayed.
- Advanced schema changes can block traffic and time out. Destructive edits and arbitrary SQL/customer code are unsupported.
- Operational limits are designed for one backend instance and noncritical alpha use, not a production availability guarantee.
- Focused keyboard/responsive checks do not establish formal WCAG compliance.

## Development and documentation

Use [testing](docs/testing.md) for backend/frontend checks, disposable integration databases, browser acceptance and benchmark reproduction. Contributor rules are in [AGENTS.md](AGENTS.md). Hosting and incident procedures live in [deployment](deploy/README.md) and [recovery](deploy/RECOVERY.md).
