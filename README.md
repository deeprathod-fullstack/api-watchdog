# API Watchdog

Register public HTTP endpoints, check them on a schedule, record every result,
and open an incident when one starts failing.

**Stack:** React + TypeScript (Vite) · Node.js + Express · PostgreSQL · Redis +
BullMQ · npm workspaces.

> This README covers local development, the production stack, and deployment
> to EC2. API reference and screenshots are still to be written.

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
the API needs no CORS configuration. That is why `VITE_API_BASE_URL` is empty.
Production keeps it empty too, with the same single-origin setup: see
[Production frontend image](#production-frontend-image).

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

## Production stack

`docker-compose.prod.yml` runs the whole system the way it runs in production:
a static frontend behind Nginx, compiled Node processes, no dev servers, no
source mounts, and exactly one published port. It runs locally the same way it
will run on the server.

> **HTTPS is required before real public use.** This stack serves plain HTTP.
> Login sends a password and every API call carries a bearer token, and over
> HTTP anyone on the network path can read both. Loopback-only local testing is
> fine; a public deployment is not, until TLS is in front of it.

### Architecture

```
Browser
  │  http://127.0.0.1:8080 locally  ·  port 80 on EC2
  ▼
web  (Nginx, :8080) ─── the only published port
  ├── /        → React static files (SPA fallback to index.html)
  └── /api/*   → api:3000
                   │
                   ├──▶ postgres:5432   (data: named volume)
                   └──▶ redis:6379      (queue: named volume, AOF)
                             ▲
worker ──────────────────────┘  consumes check jobs, writes results to postgres

migrate  runs the migrations once, exits, and api + worker start only after it
         succeeds
```

The browser only ever talks to Nginx. The frontend keeps making the same
relative `/api/...` requests as in development, so there is no separate API
origin and the API needs no CORS configuration.

### Development vs production Compose

|                  | `docker-compose.yml` (development) | `docker-compose.prod.yml` (production)  |
| ---------------- | ---------------------------------- | --------------------------------------- |
| Compose project  | `api-watchdog`                     | `api-watchdog-prod`                     |
| Frontend         | Vite dev server, HMR, source mount | Nginx serving the static build          |
| Published ports  | 5173, 3000, 5432, 6379 (loopback)  | **8080 only** (web)                     |
| Env file         | `.env` (host-facing URLs)          | `.env.production` (secrets only)        |
| Image tags       | `:dev`                             | `:prod`                                 |
| Redis            | in memory                          | AOF persistence on a volume             |
| Log files        | Docker default (unbounded)         | rotated: 3 × 10 MB per container        |
| Env per service  | whole `.env` to every app service  | only the variables each service needs   |

The project name prefixes every container, network and volume, so the two
stacks share nothing — not even the database volume — and can run side by
side.

### Environment

```bash
cp .env.production.example .env.production
```

Then replace every placeholder:

- `POSTGRES_PASSWORD`: `openssl rand -hex 32`. Hex because the password is
  embedded in `DATABASE_URL`, where `@ / : #` would break the URL.
- `JWT_SECRET`: `openssl rand -base64 48`. Never reuse a development value.
- `WEB_BIND` / `WEB_PORT`: `127.0.0.1` / `8080` locally; `0.0.0.0` / `80` on
  EC2.

`.env.production` is gitignored and never enters an image (`.dockerignore`
excludes it). It holds only what differs per deployment: `DATABASE_URL`,
`REDIS_URL`, `NODE_ENV=production` and `PORT` are set in the Compose file and
point at the internal service names, never at localhost. A missing value stops
`docker compose` with an error naming it, before anything starts.

`POSTGRES_USER` / `POSTGRES_PASSWORD` only take effect when the database volume
is first created. Changing them later does not change an existing database.

### Running it

Always through the npm scripts. Each one passes `docker-compose.prod.yml` and
`--env-file .env.production` explicitly. Without `--env-file`, Compose would
silently read the development `.env` instead, with development credentials.

```bash
npm run prod:up             # build images, then start everything in the background
npm run prod:ps             # status and health of each service
npm run prod:logs           # all logs; add -- -f api worker to follow two
npm run prod:down           # stop and remove containers; volumes (data) are kept
```

Then open <http://127.0.0.1:8080>. A quick end-to-end check of the proxy:

```bash
curl -i http://127.0.0.1:8080/api/auth/me
# 401 {"error":{"code":"unauthenticated",...}} — Express answered via Nginx
```

To delete the production database too, remove the volumes explicitly:
`docker compose -f docker-compose.prod.yml --env-file .env.production down -v`.

### Migrations

The one-shot `migrate` service runs `npm run db:migrate` from the API image,
after PostgreSQL is healthy. `api` and `worker` start only once it has **exited
successfully**. The API never migrates on startup: replicas would race, and a
bad migration would turn into a restart loop instead of one readable failure.

It runs on every `prod:up`. With nothing pending it prints
`No migrations to run!` and exits at once. If a migration fails, api and worker
stay down, and `npm run prod:logs -- migrate` shows why.

While `migrate` runs during a redeploy, the previous api container may still be
serving. Migrations must therefore stay backward-compatible with the release
before them: add a column in one release, drop the old one in a later one.

### Internal networking and the `/api` proxy

Compose puts every service on one private network and makes each service name a
hostname on it. The api reaches `postgres:5432` and `redis:6379`, and Nginx
reaches `api:3000`. Only `web` publishes a port. The API, PostgreSQL and Redis
cannot be reached from the host at all; for a database shell use
`docker compose -f docker-compose.prod.yml --env-file .env.production exec postgres psql -U watchdog api_watchdog`.

`apps/web/nginx.conf` proxies `/api/*` to `http://api:3000`, keeping the full
path (Express mounts its routes under `/api`), and sets `Host`,
`X-Forwarded-For` and `X-Forwarded-Proto`. The upstream is resolved through
Docker's DNS at `127.0.0.11` on every request, re-checked every 10 seconds,
rather than once at startup. That has two effects:

- recreating the api container, which gives it a new IP, never leaves Nginx
  sending traffic to the old address;
- the image still starts on its own, outside Compose. There, `/api/*` returns
  502 (after a 5-second resolver timeout) and the static site works normally.

Express is configured with `trust proxy = 1`. It believes exactly one proxy hop
— Nginx — and takes the client address from the entry Nginx appends to
`X-Forwarded-For`, ignoring anything the client wrote there itself. Without it,
every request would appear to come from Nginx, and the per-IP login limit would
become one bucket for everybody. This is only safe because nothing can reach the
API except through Nginx; a load balancer in front would make it `2`.

### Redis persistence (AOF)

Redis is not a source of truth here. Jobs carry only a monitor id, and the
worker reads the monitor back from PostgreSQL. But the API rebuilds schedules
from PostgreSQL **only when the API starts**. Without persistence, a restart of
Redis alone would drop every schedule, and nothing would be checked until
someone restarted the API. With `--appendonly yes` and a volume, schedules
survive a Redis restart. Eviction stays at Redis's default, `noeviction`, which
BullMQ requires.

### Shutdown

`npm run prod:down` sends SIGTERM to each container:

- The API drains in-flight requests. It has 15s before Docker force-kills it;
  its own timeout is 10s.
- The worker finishes checks already running. It has 35s; its own timeout is
  30s.
- Nginx is stopped with SIGQUIT, its graceful shutdown.

Data lives in the `api-watchdog-prod_postgres_data` and
`api-watchdog-prod_redis_data` volumes, which `down` keeps.

### The production frontend image

`apps/web/Dockerfile.prod` is a **multi-stage build**. The first stage starts
from Node, runs `npm ci`, then `npm run build:web`, which writes the static
bundle to `apps/web/dist`. The second stage starts again from a clean
`nginx-unprivileged` image and copies in only that `dist/` directory and
`apps/web/nginx.conf`. Only the last stage becomes the image. Node, npm,
`node_modules` and the source are all left behind in the build stage, which
brings the image down from about 780 MB to about 80 MB. Nginx runs as a
non-root user on port 8080.

Besides the proxy, `nginx.conf` handles:

- **SPA fallback.** A path that is not a real file (`/login`, `/dashboard`,
  `/monitors/42/history`, …) gets `index.html`, so a refresh or a pasted link
  reaches React Router instead of an Nginx 404.
- **Caching.** Files under `/assets/` have content hashes in their names and are
  cached for a year. `index.html` is never cached, so a new deploy is picked up
  straight away. A missing asset is a real 404, never HTML.

The image can still be tested on its own, without the rest of the stack:

```bash
docker build -f apps/web/Dockerfile.prod -t api-watchdog-web:prod .
docker run --rm -p 127.0.0.1:8080:8080 api-watchdog-web:prod
```

Pages and client-side routes work. `/api/*` returns 502 after the resolver's
5-second timeout, because outside Compose there is no Docker DNS and no API.

## Deployment (EC2 via GitHub Actions)

Production runs the stack above on one EC2 host (Amazon Linux 2023), from a
clone of this repository at `~/api-watchdog`. The workflow
`.github/workflows/deploy.yml` deploys the current `main` to it over SSH.

```
push to main / manual run
  │
  ▼
GitHub Actions runner ── SSH, dedicated key, pinned host key ──▶ EC2 (ec2-user)
  (holds no code, no AWS credentials)                              │
                                                                   ├─ git pull --ff-only origin main
                                                                   │    (host's own read-only deploy key)
                                                                   └─ bash scripts/deploy.sh
                                                                        build images on the host
                                                                        docker compose up -d
                                                                        wait for health, check HTTP
```

The runner never checks out the code and has no GitHub token permissions. It
opens one SSH session. The host fast-forwards its checkout to `main`, then runs
the `scripts/deploy.sh` from that commit, so a change to the script ships with
the deploy that uses it. `.env.production` exists only on the host and never
passes through GitHub. No AWS credentials are involved.

### Two SSH keys, two directions

| Key                     | Direction              | Lives                                                | Can do                       |
| ----------------------- | ---------------------- | ---------------------------------------------------- | ---------------------------- |
| EC2 GitHub deploy key   | EC2 → GitHub           | private key on EC2; public key in the repo's Deploy keys (read-only) | fetch this repository        |
| GitHub Actions deploy key | GitHub Actions → EC2 | private key in the `EC2_SSH_PRIVATE_KEY` secret; public key in EC2 `~/.ssh/authorized_keys` | log in to EC2 as `ec2-user` |

They are deliberately separate. Each can be revoked without breaking the other,
and a leak of one grants only its own direction. The Actions key is used for
nothing else.

**Treat the Actions key as root on the host.** `ec2-user` is in the `docker`
group, and Docker access is equivalent to root. Anyone who holds that key can
do anything on the machine.

### Repository secrets and variable

Set under **Settings → Secrets and variables → Actions**. Values never go in Git.

| Name                  | Kind     | Value                                                                        |
| --------------------- | -------- | ---------------------------------------------------------------------------- |
| `EC2_HOST`            | secret   | the EC2 public IP or DNS name, exactly as written in `EC2_KNOWN_HOSTS`       |
| `EC2_USER`            | secret   | `ec2-user`                                                                   |
| `EC2_SSH_PRIVATE_KEY` | secret   | the whole private key file, including the `BEGIN` / `END` lines              |
| `EC2_KNOWN_HOSTS`     | secret   | the host's public key line, captured on the host (step 3 below)              |
| `DEPLOY_ON_PUSH`      | variable | `true` to deploy automatically on every push to `main`; unset means manual only |

The workflow checks that all four secrets are set, and fails with the missing
name if one isn't.

### One-time setup

**1. Create the GitHub Actions key pair** on your own machine, not on EC2:

```bash
ssh-keygen -t ed25519 -N "" -C "github-actions-deploy@api-watchdog" -f ./gha_deploy_key
```

This creates `gha_deploy_key` (private) and `gha_deploy_key.pub` (public). The
key has no passphrase because the workflow cannot type one. The GitHub secret
store is what protects it.

**2. Authorize it on EC2.** Over your existing SSH session, append the public
key to `~/.ssh/authorized_keys` with the `restrict` prefix. That disables port,
agent and X11 forwarding and terminal allocation for this key. Running commands
still works, and that is all the workflow needs.

```bash
# on EC2, pasting the one line from gha_deploy_key.pub:
echo 'restrict ssh-ed25519 AAAA...your-public-key... github-actions-deploy@api-watchdog' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Do not reuse the host's existing GitHub deploy key, and do not add
`gha_deploy_key.pub` to GitHub.

**3. Capture the host key on the host itself**, for `EC2_KNOWN_HOSTS`:

```bash
# on EC2, replacing <EC2_HOST> with the exact value you will put in EC2_HOST:
echo "<EC2_HOST> $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
```

Reading it from the host over a session you already trust is the point. Running
`ssh-keyscan` from elsewhere would record whatever answered at that address. The
workflow connects with `StrictHostKeyChecking=yes`, so it refuses any host that
does not present exactly this key.

**4. Check the key works** from your machine:

```bash
ssh -i ./gha_deploy_key -o IdentitiesOnly=yes ec2-user@<EC2_HOST> 'cd ~/api-watchdog && git status -sb'
```

The output should show `## main...origin/main` and no modified files.

**5. Store the secrets.** Add them as described above, pasting the whole content
of `gha_deploy_key` into `EC2_SSH_PRIVATE_KEY`. Then **delete the local private
key file**: GitHub now holds the only copy you need, and a replacement is one
`ssh-keygen` away.

**6. Security group.** SSH (port 22) must be reachable from GitHub-hosted
runners. Their addresses are many and they change, so in practice port 22 is
open to the internet and the protection is key-only authentication. Confirm on
the host that password login is off: `sudo sshd -T | grep -i passwordauthentication`
must print `passwordauthentication no`. Port 80 is the only other
inbound rule the stack needs. PostgreSQL, Redis and the API publish no ports at
all.

**7. First deploy by hand**, then decide on automatic deploys:

- Go to **Actions → Deploy → Run workflow**, or run
  `gh workflow run deploy.yml --ref main`.
- Once a manual run has succeeded, set the repository variable
  `DEPLOY_ON_PUSH` to `true`. Every push to `main` then deploys.

Whichever branch you pick in the Run workflow form, the host always deploys
`origin/main`.

### What a deployment does and verifies

1. **Host checkout.** The run refuses to deploy if tracked files have been
   edited on the host. It then runs `git fetch origin main`,
   `git checkout main` and `git pull --ff-only origin main`. A diverged history
   fails the run instead of being merged.
2. **Preflight.** `.env.production` must exist, and the Compose file must
   resolve with it, so a missing variable is caught before anything changes.
3. **Rollback copy.** If the running api and web are both healthy, their images
   are tagged `:prod-previous`. A stack that is already unhealthy never
   overwrites the last good copy.
4. **Build** both images on the host. **A build failure stops here, with the
   running containers untouched.**
5. **`docker compose up -d`.** Migrations run first. Only services whose image
   or configuration changed are recreated. Never `down`: the site stays up
   during the build, and volumes are never at risk.
6. **Verification**, within 180 seconds:
   - `api` and `web` report healthy
   - the worker is running and has not restarted
   - from the host, `GET /` and `GET /dashboard` return 200 with the app shell
   - `GET /api/auth/me` returns 401 `unauthenticated`, which proves the path
     host port → Nginx → API

Any failure prints container status and recent logs of `migrate`, `api`,
`worker` and `web`, and fails the run. These logs never contain secrets or
request headers.

Deployments never run in parallel, and a running one is never cancelled. A push
made during a deploy waits, then deploys the latest `main`.

### When a deployment fails

There is no automatic rollback yet. After step 5, a failure means some services
may already run the new version.

- **Preferred:** fix or revert the commit on `main`, then deploy again.
- **Emergency, on the host:** return to the previous images without building:

  ```bash
  cd ~/api-watchdog
  docker tag api-watchdog-api:prod-previous api-watchdog-api:prod
  docker tag api-watchdog-web:prod-previous api-watchdog-web:prod
  docker compose -f docker-compose.prod.yml --env-file .env.production up -d --no-build
  ```

  This restores the code, not the database. A migration that already ran stays
  applied, which is why migrations must remain backward-compatible.

`bash scripts/deploy.sh` can also be run by hand on the host, from
`~/api-watchdog`.

### Current limitations

- **Images are built on the EC2 host.** Each deploy spends the host's CPU and
  memory on `npm ci` and compilation while it is also serving traffic. On a
  small instance that is slow, and it can run out of memory.
- **Deploy does not wait for CI.** On a push to `main` both workflows start
  together. Changes normally reach `main` through pull requests where CI has
  already passed, but a direct push could deploy a failing commit.
- **Brief API interruption.** Replacing the single api container can fail
  requests for about a second.
- **No HTTPS yet.** See the warning in "Production stack".
- Port 22 is open to the internet, as described in step 6.

### Future improvements

- Build the images in GitHub Actions and push them to a registry (GHCR or ECR).
  The host would then only pull and restart: faster, predictable, and no build
  load on the server. Rollback becomes "run the previous tag".
- Deploy only after CI has passed on the same commit.
- A GitHub environment with required reviewers, for an approval step.
- Replace inbound SSH with AWS Systems Manager, which closes port 22.

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
apps/web/nginx.conf   Nginx config for that image (SPA fallback, caching, /api proxy)
packages/shared Config loading and environment validation
migrations      node-pg-migrate migrations
docker-compose.yml    the five-service local development stack
docker-compose.prod.yml  the production stack (npm run prod:up)
.env.production.example  template for .env.production
scripts/deploy.sh     build, roll out and verify on the production host
.github/workflows     ci.yml (checks every PR), deploy.yml (deploys main to EC2)
```

Environment variables are declared and validated in
`packages/shared/src/config.ts`; the application refuses to start if any value
is missing or malformed. `.env.example` is the template and the only env file
in Git.
