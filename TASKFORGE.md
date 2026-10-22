# Taskforge

## Problem

Beginner/frontend developers can build interfaces but often get blocked when they need to create databases, CRUD APIs and backend integration.

## Intended user

Student, beginner developer, frontend developer, or solo builder.

## Hackathon concept

Backend for Everyone: a small, plain-language path through an existing backend platform.

## Pre-existing work

The underlying BaaS/backend platform existed before Taskforge. It includes project management, PostgreSQL connections, schema application, CRUD runtime, API keys, authentication, a dashboard and advanced capabilities.

## Taskforge work

H1 introduced the Guided Builder (`/projects/:projectId/guided`), fixed Task Manager questions, review, simplified navigation and accessible keyboard/focus behavior.

H2 connects that flow to the existing management adapter and backend engine: saved connection prerequisites, Tasks draft creation, preview/application, selected CRUD configuration and a Backend Ready summary. Matching applied configurations are recognized on reload. Incompatible or unfinished configurations require manual review through existing pages; failed writes are never automatically replayed.

Demo API key creation is explicit and uses the existing one-time secret dialog. Playground links target Tasks creation/listing. Fetch examples use credential placeholders only. Backend configured and runtime API testing are separate: configuration success alone does not claim the API was tested.

## Limitations

- PostgreSQL and its target schema must already exist, with a saved project connection and required DDL/CRUD privileges.
- No application-user authentication or owner/privacy isolation is included in the MVP.
- Project API keys are trusted credentials. Public frontend credential handling is outside this prototype; never embed a read-and-write key in a public production frontend bundle.
- Keys are held only in component memory and cleared when the secret dialog closes. They cannot be retrieved later; use existing API key management if needed.
- Selections reset on reload before setup. Completed configuration is read from platform metadata; partial failures are not repaired automatically.

## Validation

Frontend typecheck, all 72 unit/component tests and the production build passed. An isolated mocked Chromium check passed for creation/Ready, selected actions, focus, one-time key clearing, no browser persistence, reload without writes, and blocked prerequisites. These checks used synthetic responses and did not exercise PostgreSQL. Focused frontend tests cover the template, request sequence, prerequisites, readiness recognition and failure stops. A focused disposable-database Playwright test is provided in `frontend/tests/e2e/taskforge.spec.ts`.

Real PostgreSQL/API E2E validation has not run: explicit `E2E_PLATFORM_DATABASE_URL` and `E2E_CUSTOMER_DATABASE_URL` are unavailable. The harness requires separate dedicated local `dashboard_e2e_*_test` databases. Do not substitute application or saved customer databases.

## AI assistance

ChatGPT assisted with product planning, scope reduction and review. Codex assisted with repository inspection, implementation and automated frontend validation. Developer review and independent H2 testing remain to be completed.
