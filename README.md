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

## Production frontend image

The frontend has two Dockerfiles, one for each job:

| File                      | What it runs                        | Used by                     |
| ------------------------- | ----------------------------------- | --------------------------- |
| `apps/web/Dockerfile`     | Vite dev server, HMR, `/api` proxy  | `docker compose up`         |
| `apps/web/Dockerfile.prod`| Nginx serving the static build      | deployment (built manually) |

Compose only uses the development image, so the production one cannot change
how local development works.

`Dockerfile.prod` is a **multi-stage build**. The first stage starts from Node,
runs `npm ci`, then `npm run build:web`, which writes the static bundle to
`apps/web/dist`. The second stage starts again from a clean
`nginx-unprivileged` image and copies in only that `dist/` directory and
`apps/web/nginx.conf`. Only the last stage becomes the image. Node, npm,
`node_modules` and the source are all left behind in the build stage, which
brings the image down from about 780 MB to about 80 MB. Nginx runs as a
non-root user on port 8080.

`nginx.conf` does three things:

- **SPA fallback.** A path that is not a real file (`/login`, `/dashboard`,
  `/monitors/42/history`, …) gets `index.html`, so a refresh or a pasted link
  reaches React Router instead of an Nginx 404.
- **Caching.** Files under `/assets/` have content hashes in their names and are
  cached for a year. `index.html` is never cached, so a new deploy is picked up
  straight away. A missing asset is a real 404, never HTML.
- **No API.** `/api/*` returns 404. This image does not proxy to the backend.
  How production requests reach the API has not been decided yet.

Build and run it locally:

```bash
docker build -f apps/web/Dockerfile.prod -t api-watchdog-web:prod .
docker run --rm -p 127.0.0.1:8080:8080 api-watchdog-web:prod
```

Then open <http://localhost:8080>. Pages load and client-side routes work, but
login and data calls fail, because nothing answers `/api` in this setup. That is
expected until production API routing is in place.

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
apps/web/Dockerfile.prod  production image: static build served by Nginx
apps/web/nginx.conf   Nginx config for that image (SPA fallback, caching)
packages/shared Config loading and environment validation
migrations      node-pg-migrate migrations
docker-compose.yml    the five-service local stack
```

Environment variables are declared and validated in
`packages/shared/src/config.ts`; the application refuses to start if any value
is missing or malformed. `.env.example` is the template and the only env file
in Git.
