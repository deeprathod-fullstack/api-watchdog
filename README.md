# API Watchdog

Register public HTTP endpoints, check them on a schedule, record every result,
and open an incident when one starts failing.

**Stack:** React + TypeScript (Vite) · Node.js + Express · PostgreSQL · Redis +
BullMQ · npm workspaces.

> This README currently covers local development only. Architecture, API
> reference, deployment and screenshots are still to be written.

## Prerequisites

- **Docker** — Compose runs the whole stack.
- **Node 24** — the version in `.nvmrc`. `nvm use` if you have nvm. Needed for
  the tests, the linter and the migration scripts, which run on your host.

## Setup

```bash
npm install                 # installs all three workspaces
cp .env.example .env        # local defaults; never commit this file
cp apps/web/.env.example apps/web/.env.local
```

## Running it

```bash
docker compose up -d --build
```

Open <http://localhost:5173> and register an account.

That starts five services: PostgreSQL, Redis, the API, the background worker,
and the frontend dev server. A sixth, `migrate`, runs the migrations and exits
before the API starts, so a fresh clone needs no separate schema step.

```bash
docker compose logs -f api worker    # follow the interesting ones
docker compose ps                    # what is up, and is it healthy
```

The API and worker are separate processes on purpose: a slow or failing
outbound check must never occupy a request thread. They are the same image with
a different command — same code, same dependencies, one thing to build. Without
the worker the app still runs, but nothing is checked on a schedule; only
"Check now" works.

The frontend container runs the Vite dev server with your `apps/web` directory
mounted, so editing a file hot-reloads exactly as it does on the host. It
proxies `/api` to the API container, so the browser talks to a single origin and
the API needs no CORS configuration. That is why `VITE_API_BASE_URL` is empty in
development; in production it is the deployed API's origin.

### Running on the host instead

The application still runs directly on your machine, which is a faster edit loop
if you are working on one service and want nothing between you and it.

```bash
docker compose up -d postgres redis   # backing services only
npm run db:migrate                    # the migrate container is not running now
npm run dev                           # API on http://localhost:3000
npm run dev:worker                    # background worker
npm run dev:web                       # frontend on http://localhost:5173
```

This works because `.env` points `DATABASE_URL` and `REDIS_URL` at `localhost`,
reaching PostgreSQL and Redis through their published ports. Containers cannot
use those URLs — inside a container `localhost` is the container itself — so
`docker-compose.yml` overrides just those two variables with the `postgres` and
`redis` hostnames. One env file; the difference lives in one place.

Do not run both at once. Two workers would consume the same queue, and two APIs
would both try to bind port 3000.

```bash
npm run db:check            # → Connected to database: api_watchdog
```

## Checks

```bash
npm run verify              # format check + lint + typecheck + tests
npm test                    # tests only
npm run build:web           # production frontend bundle
npm run lint:fix            # autofix lint
npm run format              # prettier
```

The backend suite needs PostgreSQL and Redis from Compose to be up, but it does
not touch your development data. It runs against its own database — the one in
`DATABASE_URL` with a `_test` suffix — which is created and migrated
automatically on the first run, and its own Redis key prefix. Your monitors and
accounts are left alone, and nothing has to be cleared out between runs.

## Stopping

```bash
docker compose down         # keeps the data volume
docker compose down -v      # deletes the database too
```

`docker compose down` sends SIGTERM, and both the API and the worker shut down
gracefully: the API drains in-flight requests, the worker finishes the checks it
has already started, and each then closes Redis and its database pool. The
worker gets a longer grace period than Docker's 10-second default, because a
check in flight may be sitting on a monitor's full timeout.

## Layout

```
apps/api        Express API and the BullMQ worker
apps/api/Dockerfile   image for the API, the worker and the migration job
apps/web        React frontend
apps/web/Dockerfile   image for the Vite dev server
packages/shared Config loading and environment validation
migrations      node-pg-migrate migrations
docker-compose.yml    the five-service local stack
```

Environment variables are declared and validated in
`packages/shared/src/config.ts`; the application refuses to start if any value
is missing or malformed. `.env.example` is the template and the only env file
in Git.
