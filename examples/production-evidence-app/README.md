# Production evidence app

A disposable Node 24 HTTP app using real PostgreSQL through the fixture-local, exact-pinned `pg` driver. There is no in-memory database or environment-presence success path in the executable app.

## Deployment prerequisite

Copy this directory, including its lockfile and Dockerfile, to the approved **private fixture repository** and use it as that repository's build context. Publishing or pushing that repository is a separate operator action; adding this example does not perform or authorize it.

Provision a **dedicated disposable tenant PostgreSQL database**, attach that resource to the fixture service, and inject its connection string as the service's `DATABASE_URL` through the platform's runtime secret binding. **Never use the control-plane database**: the release operator's database role / Helm `DATABASE_URL` belongs to the platform control plane, not this fixture. The tenant database role needs connection and `CREATE` permission in `public`, plus `INSERT` and `SELECT` on the app-created `public.production_evidence_nonces` table. Use the provider's required TLS configuration; the app does not disable certificate verification. Missing, malformed, or non-PostgreSQL configuration exits with a redacted error. A configured but unreachable database cannot pass readiness or functional evidence.

Deploy as a web service with container port `3000` (or injected `PORT`), `livenessPath: /healthz/live`, and `readinessPath: /healthz/ready`. Repository import alone creates the default service without these health paths or a database attachment: the operator must configure both health fields and the dedicated tenant database attachment/environment before running evidence. This app and the evidence runner do not provision or attach that database automatically. Keep the service and its unauthenticated evidence endpoint restricted to the approved test environment. It is not a general application or a place for user data. Delete the dedicated database through the owning platform cleanup after the evidence run; the app does not drop databases or delete other runs' rows.

For local execution in this directory, install only this fixture's dependencies with `npm ci --omit=dev --ignore-scripts --workspaces=false`, inject `DATABASE_URL` without committing it, and run `npm start`. The Docker image installs the same lockfile and runs as the non-root `node` user.

## HTTP contract

| Request | Success | Failure |
| --- | --- | --- |
| `GET /healthz/live` | `200 {"ok":true}` while the HTTP process is alive; no database call | Process unavailable |
| `GET /healthz/ready` | `200 {"ok":true}` only after PostgreSQL `SELECT 1 AS ready` returns `1` | `503 {"error":"database_unavailable"}` |
| `POST /_evidence/db` | `200 {"nonce":"<submitted nonce>","readBack":"<stored nonce>"}` after a parameterized write and a **separate** matching database read | `400` invalid JSON/fields, `413` body over 4096 bytes, `415` non-JSON, or `503` database/write/readback failure |

The POST body is exactly `{ "runId": "<UUID>", "deploymentId": "<identifier>", "nonce": "<64 lowercase hex characters>" }`. UUIDs use the canonical version 1–8/variant representation. A deployment identifier is 1–128 ASCII letters/digits/underscores/hyphens, beginning with a letter or digit. Extra fields are rejected before database I/O. Other methods on these routes return `405`; unknown paths return `404`.

The first valid POST creates the dedicated table if needed. The primary key is `(run_id, deployment_id, nonce)`; retries are idempotent. Both write and read use bound parameters. There are no generated quota, reservation, release, audit, or operation IDs. A successful response requires the row read from PostgreSQL to match the submitted nonce.

Each completed or failed valid POST emits one JSON log with `level`, `event`, `runId`, `deploymentId`, and `correlationId` (the nonce). Errors use fixed categories, never driver error text, request headers, connection strings, or tokens. Request bodies are bounded to 4096 bytes; headers/body have finite receive deadlines, and PostgreSQL connection/query/statement timeouts are 5 seconds.

## Verification boundary

From the RAIBIT repository root, `node --test tests/production-evidence-app.test.js` exercises real local HTTP requests with only the database query boundary injected. It covers separate readback, invalid input before database calls, and unavailable/mismatched database failures. It does **not** claim real PostgreSQL, Docker, or live deployment verification; those remain operator-deferred until the approved fixture repository and dedicated database are supplied.
