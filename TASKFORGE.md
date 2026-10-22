# Taskforge — Backend for Everyone

## Problem

A student finishes a frontend, then gets stuck building a server, API routes, database tables, SQL queries and CRUD operations. Backend setup becomes a barrier to completing an otherwise small app.

## Intended user

A student, beginner developer, frontend developer or solo builder who can create an interface but needs help connecting it to working data.

## Solution

The Guided Builder translates backend setup into understandable choices: choose Task Manager, confirm its information, choose what the app can do, review, and create a working backend using the existing platform engine.

Before: frontend finished → manually build server, routes, database queries and integration.

After: choose Task Manager → confirm data → select actions → Create Backend → working API.

## Demo flow

Use a prepared project with a dedicated noncritical PostgreSQL connection. Open **Guided Builder** in project navigation (`/projects/<project-id>/guided`).

Task Manager → Tasks storage → CRUD API → explicit demo API key → Playground POST → Playground GET/list → copy fetch example.

The template stores required `title`, optional `description`, required `completed` (default false), and optional `due_date`. The existing engine supplies the UUID primary key. View tasks enables both list and single-task reads; Edit uses PATCH.

**Backend Ready means saved storage and API configuration are confirmed.** Runtime success is demonstrated separately in Playground. Existing matching configurations open Ready after reload without recreating them. Conflicts and incomplete operations stop with links to the existing management pages; there is no automatic repair or mutation replay.

## Run locally

This is a local demo setup, not a one-click deployment. Use Node.js 24 LTS, npm and PostgreSQL 16+. Have two separate databases available: one dedicated platform metadata database and one noncritical customer/demo database with an existing schema (for example `public`). Never use production data for the demo.

1. **Backend dependencies and configuration:** from the repository root, run `npm ci --prefix backend`. If `backend/.env` does not exist, copy `backend/.env.example` to it; preserve any existing configuration. Privately configure `PLATFORM_DATABASE_URL` for the platform database and a stable, securely generated 64-character hex `CONNECTION_ENCRYPTION_KEY`. Keep credentials and encryption keys out of source control. Set the public runtime origin to `http://127.0.0.1:3000` for this local demo. The default backend port is 3000. Local development permits local PostgreSQL; hosted destination/TLS restrictions are a separate deployment concern.
2. **Platform migrations:** run `npm run db:migrate --prefix backend` against that explicitly configured platform database. The migration role must have DDL privileges. This prepares platform metadata; it does not provision a customer database.
3. **Start backend:** run `npm run dev --prefix backend` and keep that terminal open.
4. **Frontend dependencies and configuration:** in another terminal, run `npm ci --prefix frontend`. If `frontend/.env.local` does not exist, copy `frontend/.env.example` to it. Configure these non-secret local settings:

   ```text
   BACKEND_ORIGIN=http://127.0.0.1:3000
   PUBLIC_RUNTIME_ORIGIN=http://127.0.0.1:3000
   DASHBOARD_ORIGIN=http://127.0.0.1:3001
   DASHBOARD_COOKIE_MODE=local-http
   ```

   Keep the platform database URL and encryption key exclusively in backend configuration. See [frontend setup](frontend/README.md#run-locally) and [backend setup](README.md#local-setup) for details.
5. **Start dashboard:** run `npm run dev --prefix frontend`. Open `http://127.0.0.1:3001/signup`, create a platform account with a password of at least 15 characters, then sign in. Platform sign-in protects project management; it is separate from application-user authentication, which this demo does not configure.
6. **Prepare project:** create/select a project. Open **Database**, enter the dedicated demo database connection and its existing schema, and use **Test and save**. The database role must be able to create Tasks storage and perform CRUD. Disable SSL only for a trusted local test connection. A successful connection test alone does not prove all DDL/CRUD privileges.
7. **Build:** open **Guided Builder**, confirm the fields/actions, review, and click **Create Backend**. Missing connections or incompatible existing Tasks configurations require manual resolution in the linked pages.
8. **Test:** create a demo key and copy it before closing the dialog. Open **Test Create Task**, select **API key** in Playground's Credential mode, paste the key into Runtime credential, and send:

   ```json
   {"title":"Finish assignment","completed":false}
   ```

   Expect HTTP 201. Open **Test View Tasks**, select API key mode and paste the same key again; send GET and confirm the same task appears. Credentials are cleared when leaving Playground, so keep the key privately for the demo session only.

Direct browser integrations must use a runtime-allowed CORS origin; Playground success does not test an external frontend's CORS settings. Write keys belong in trusted code, not a public frontend bundle.

## Pre-existing work

The underlying BaaS/backend platform existed before Taskforge. Pre-existing capabilities include the project system, PostgreSQL connection handling, schema engine, CRUD runtime, API keys, platform authentication, Playground/docs, the dashboard and advanced platform features. The whole platform was **not** created during this hackathon.

## Built/simplified during Taskforge

- H1: project-level Guided Builder, Task Manager questions, plain-language field/action descriptions, review and preview, simplified navigation and keyboard/focus handling.
- H2: a narrow setup sequence reusing existing management APIs, fixed Tasks template, matching-configuration recognition, Backend Ready, explicit API-key handoff, Playground links and placeholder-based fetch integration.
- H3: clearer product story, concise Ready summary, ordered key/test/integration handoff, four-stage progress, disabled-control explanations, scoped contrast/focus/reflow polish, run instructions and submission/demo preparation.
- Focused Taskforge rendering, setup-sequence, failure-stop, reload and credential-storage tests.

## Validation

H2 acceptance passed on isolated local PostgreSQL 18 with two fresh dedicated databases: `dashboard_e2e_taskforge_platform_test` and `dashboard_e2e_taskforge_customer_test`. They were created for testing and removed afterward; the normal local cluster was untouched.

Verified evidence:

- Frontend typecheck, **72 unit/component tests**, production build and `git diff --check` passed at H2 acceptance.
- The focused real PostgreSQL E2E passed: Tasks schema applied, all five runtime operations configured, a read/write key created, POST returned HTTP 201, and GET/list returned the same task ID and values.
- Reload recognized Backend Ready with zero configuration writes.
- No plaintext key appeared in localStorage, sessionStorage or readable cookies. This is a targeted check, not a claim that browser tooling/clipboard cannot retain intentionally displayed secrets.
- H3 frontend typecheck, all 72 tests, production build and whitespace checks passed. The setup sequence, credential handling and request contracts are unchanged, so the database E2E was not rerun for these presentation/documentation changes.
- H3 isolated Chromium checks used synthetic responses: Build/Review/Creating/Ready, keyboard progression, heading focus, status/error wording, disabled explanations and secret-dialog dismissal passed. Desktop (1280px), tablet (768px), mobile (375px) and simulated 200% CSS zoom showed no page overflow; code remains keyboard-focusable and scrolls internally. Synthetic screenshots were visually reviewed. This is not a formal accessibility audit or real browser-zoom certification.

To repeat only the real acceptance test, explicitly supply `E2E_PLATFORM_DATABASE_URL` and `E2E_CUSTOMER_DATABASE_URL` for **two distinct disposable local** databases. The harness accepts only `127.0.0.1`/`localhost` and database names matching `dashboard_e2e_[a-z_]+_test`. With both variables privately configured for the test session, run:

```sh
npm run test:e2e --prefix frontend -- tests/e2e/taskforge.spec.ts --reporter=line
```

Install package dependencies in both packages and Playwright's Chromium before running on a fresh machine. The harness creates a random customer schema, applies platform migrations and starts servers on 3010/3011. It leaves test data in the supplied disposable databases; cleanup is the operator's responsibility. Never substitute application databases or saved product connections. Screenshots, video and traces are disabled in this test to avoid recording the key.

## Limitations

- PostgreSQL and the target schema must already exist; database provisioning is not part of the prototype.
- The connection must permit required DDL/CRUD operations; connectivity alone is insufficient.
- No application-user authentication or owner-level private task isolation is configured by Taskforge.
- Project write keys are trusted credentials; never embed them in public production frontend bundles.
- Keys are shown once, held in component memory and cleared on dialog close. Clipboard and browser tooling are outside that guarantee.
- Selections reset before setup on reload; saved completed configurations are recognized from metadata. Partial failures require manual review.
- Advanced platform features intentionally stay outside the hackathon flow.
- Focused accessibility checks do not establish formal WCAG compliance.

## 2–4 minute judge demo

Prepare before recording: run both applications, sign in, use a fresh project and valid noncritical demo database connection, and keep all four actions selected. Keep secrets and unrelated dashboard pages out of the recording. Avoid reusing an already configured project when demonstrating creation.

| Time | Show and say |
| --- | --- |
| 0:00–0:25 | “I can build my frontend, but now I need a server, routes, database queries and APIs.” Introduce the student/frontend developer. |
| 0:25–1:05 | Open Guided Builder. Show Task Manager, four understandable fields and Create/View/Edit/Delete choices. Mention the database connection was prepared. |
| 1:05–1:40 | Continue → review → Create Backend. Point to the plain-language progress. |
| 1:40–2:15 | Backend Ready: show Tasks storage, available actions and the real API address. Distinguish configured from tested. |
| 2:15–3:05 | Create/copy a demo key privately. Open Test Create Task; choose API key mode, paste the key and POST “Finish assignment.” Show HTTP 201. Open Test View Tasks, paste the same key and GET the list; show the same task. |
| 3:05–3:35 | Return to Ready and show/copy the fetch example. “The developer didn't manually build a server, CRUD routes, SQL queries or API integration. They answered a few simple questions and received a working backend.” |

For screenshots, capture Build, Review, Ready and the successful task response. Never capture the one-time key dialog, connection credentials or browser developer tools. Label screenshots from mock fixtures as mock UI; use the live demo for real API evidence.

## Devpost draft — not submitted

**Project name:** Backend for Everyone

**Tagline:** Turn simple app choices into a working Task Manager backend.

**Problem and intended user:** Students and frontend developers can finish an interface but lose momentum when they need servers, database schemas, CRUD routes and integration.

**Inspiration:** Reduce that transition to one understandable path instead of exposing an entire backend platform to a beginner.

**What it does:** Guides a developer through a fixed Task Manager template, creates storage and selected API actions on an already connected PostgreSQL database, and hands off to Playground plus a fetch example.

**How we built it:** Added a small Next.js/React guided experience over pre-existing Fastify management APIs and a PostgreSQL schema/CRUD engine. Taskforge-specific code translates choices and performs a short sequential setup; it does not implement another backend engine.

**Challenges:** Keeping scope small, communicating configuration versus runtime success, handling one-time credentials honestly, and proving the flow with disposable databases. Partial failures stop for manual review rather than triggering automatic retries.

**Accomplishments:** A real Tasks table and API, verified create/list requests returning the same task, reload without duplicate configuration writes, and a focused keyboard-friendly demo path.

**What we learned:** A useful accessibility/productivity improvement can come from reducing choices and jargon around an existing capability. Clear handoffs and honest status messages matter as much as the setup button.

**What's next:** User-test the current path with beginners and refine wording from observation. Public frontend credential handling and private user data remain future design work, not submitted capabilities.

**Limitations:** Prepared PostgreSQL required; no provisioning, application login or owner privacy in the guided MVP. Write keys stay private. See the limitations above.

**Pre-existing work disclosure:** The underlying BaaS, schema/runtime engines, API keys and original dashboard existed before Taskforge. The hackathon contribution is the focused guided experience, integration and demo/accessibility work listed above.

**AI assistance disclosure:** See the statement below. No external submission has been made by Codex.

## AI assistance

ChatGPT assisted with product planning, scope reduction, review and prompt design. Codex assisted with repository inspection, implementation and automated validation. The developer selected the product direction, mediated development and reviewed the milestone reports. Automated test execution described here was performed with Codex assistance; independent developer testing is not claimed where it has not been recorded.
