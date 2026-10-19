# Next.js + PostgreSQL starter v1

This web service uses Next.js 16.2.6 and a managed PostgreSQL resource. `DATABASE_URL` must come from the resource secret binding. `GET /healthz` creates only the `raibit_starter.health_probe` table in the bound database, upserts the fixed `synthetic-healthz` row, and reads it back.

Run with `pnpm install --frozen-lockfile`, `pnpm build`, then `pnpm start`. The checked-in Dockerfile remains the authoritative build entrypoint.
