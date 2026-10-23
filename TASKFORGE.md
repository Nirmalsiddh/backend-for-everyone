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

## Prepare the demo

Follow the [local setup](README.md#run-locally). Start both applications, sign in, create a fresh project and save a dedicated noncritical PostgreSQL connection. The database and schema must already exist, with privileges to create Tasks storage and perform CRUD.

Keep all four actions selected for the full walkthrough. Create a demo API key explicitly on Ready and copy it privately before closing the dialog. In Playground choose **API key** credentials and POST:

```json
{"title":"Finish assignment","completed":false}
```

Expect HTTP 201. Open **Test View Tasks**, select API key mode and paste the same key again; GET/list should return the same task ID and values. Credentials clear when leaving Playground. Reload Guided Builder to demonstrate that saved matching configuration is recognized without recreation.

Playground uses a same-origin relay. A separate browser frontend needs its origin in the runtime CORS allowlist; Playground success does not verify that integration. Keep write keys in trusted code.

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

## Limitations

- PostgreSQL and the target schema must already exist; database provisioning is not part of the prototype.
- The connection must permit required DDL/CRUD operations; connectivity alone is insufficient.
- No application-user authentication or owner-level private task isolation is configured by Taskforge.
- Project write keys are trusted credentials; never embed them in public production frontend bundles.
- Keys are shown once, held in component memory and cleared on dialog close. Clipboard and browser tooling are outside that guarantee.
- Selections reset before setup on reload; saved completed configurations are recognized from metadata. Partial failures require manual review.
- Advanced platform features intentionally stay outside the hackathon flow.
- Focused accessibility checks do not establish formal WCAG compliance.

## Contribution and disclosure

The underlying BaaS/backend platform existed before Taskforge: projects, PostgreSQL connections, schema and CRUD engines, API keys, platform authentication, the original dashboard, Playground/Docs and advanced platform features. The whole platform was not created during this hackathon.

Taskforge adds the focused Guided Builder, fixed Task Manager questions and field/action explanations, review and setup sequence, matching-configuration recognition, Backend Ready, explicit key handoff, Playground links and placeholder-based fetch example. Work also covered navigation, progress/status wording, keyboard focus, responsive presentation and focused setup/failure/reload tests. It reuses the existing management APIs rather than implementing another backend engine.

ChatGPT assisted with product planning, scope reduction, review and prompt design. Codex assisted with repository inspection, implementation support, debugging, review and automated validation. The developer selected the product direction, reviewed the work and made final decisions. Automated execution with Codex assistance is disclosed; independent developer testing is not claimed where it has not been recorded.

Recorded acceptance includes real PostgreSQL Tasks creation, POST/GET persistence and reload recognition. See [testing](docs/testing.md#recorded-evidence) for evidence boundaries and reproduction. Prepared PostgreSQL and trusted key handling remain requirements, not capabilities the Guided Builder supplies.
