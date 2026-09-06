# API Watchdog

Register public HTTP endpoints, check them on a schedule, record every result,
and open an incident when one starts failing.

**Stack:** React + TypeScript (Vite) · Node.js + Express · PostgreSQL · Redis +
BullMQ · npm workspaces.

> This README currently covers local development only. Architecture, API
> reference, deployment and screenshots are still to be written.

## Prerequisites

- **Node 24** — the version in `.nvmrc`. `nvm use` if you have nvm.
- **Docker** — Compose provides PostgreSQL and Redis. The application itself
  runs on your host, not in a container.

## Setup

```bash
npm install                 # installs all three workspaces
cp .env.example .env        # local defaults; never commit this file
cp apps/web/.env.example apps/web/.env.local
docker compose up -d        # postgres + redis
npm run db:migrate          # create the schema
```

Check the database is reachable before going further:

```bash
npm run db:check            # → Connected to database: api_watchdog
```

## Running it

Three processes, one terminal each.

```bash
npm run dev                 # API on http://localhost:3000
npm run dev:worker          # background worker — runs the scheduled checks
npm run dev:web             # frontend on http://localhost:5173
```

Open <http://localhost:5173> and register an account.

The API and worker are separate processes on purpose: a slow or failing
outbound check must never occupy a request thread. Without the worker the app
still runs, but nothing is ever checked on a schedule — only "Check now" works.

The Vite dev server proxies `/api` to the API, so the browser talks to a single
origin and the API needs no CORS configuration. That is why
`VITE_API_BASE_URL` is empty in development; in production it is the deployed
API's origin.

## Checks

```bash
npm run verify              # format check + lint + typecheck + tests
npm test                    # tests only
npm run build:web           # production frontend bundle
npm run lint:fix            # autofix lint
npm run format              # prettier
```

The backend suite runs against the real PostgreSQL and Redis from Compose, so
they must be up. Some scheduling assertions are necessarily global — they
compare every active monitor against every job scheduler — so monitors left
behind by manual testing will fail them. Clear those out if `scheduling.test.ts`
starts failing for no apparent reason.

## Stopping

```bash
# Ctrl-C each process, then:
docker compose down         # keeps the data volume
docker compose down -v      # deletes the database too
```

## Layout

```
apps/api        Express API and the BullMQ worker
apps/web        React frontend
packages/shared Config loading and environment validation
migrations      node-pg-migrate migrations
```

Environment variables are declared and validated in
`packages/shared/src/config.ts`; the application refuses to start if any value
is missing or malformed. `.env.example` is the template and the only env file
in Git.
