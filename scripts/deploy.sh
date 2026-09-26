#!/usr/bin/env bash
#
# Build and roll out the production stack on the machine it runs on.
#
# Run ON the EC2 host, from the repository root, by
# .github/workflows/deploy.yml — after the workflow has fast-forwarded the
# checkout to the latest main. It can also be run by hand there:
#
#     cd ~/api-watchdog && bash scripts/deploy.sh
#
# Steps, and what each failure leaves behind:
#
#   1. Preflight: .env.production exists and the Compose file resolves.
#      A failure here touches nothing.
#   2. Keep a copy of the running images as :prod-previous, but only if they
#      are healthy right now. That is the manual rollback target.
#   3. Build the new images. A build failure touches nothing: the running
#      containers keep serving the previous version.
#   4. `up -d`. Compose runs migrate first and recreates only the services
#      whose image or configuration changed. Never `down`: that would take the
#      site offline for the whole build, and volumes must never be at risk.
#   5. Wait, with a timeout, for api and web to report healthy and for the
#      worker to stay up; then check real HTTP responses from this host.
#
# Any failure exits non-zero with container status and recent logs printed,
# which is what fails the GitHub Actions run. There is no automatic rollback:
# after step 4 a failure means the new version is (partly) in place and a
# person decides what to do. See README "Deployment" for the rollback steps.

set -euo pipefail

HEALTH_TIMEOUT_SECONDS="${DEPLOY_HEALTH_TIMEOUT_SECONDS:-180}"

# The only way this script talks to Compose: always the production file and
# always the production env file, never the development .env.
compose() {
  docker compose -f docker-compose.prod.yml --env-file .env.production "$@"
}

log() {
  printf '[deploy] %s\n' "$*"
}

# Container status plus the tail of each application service's log. The
# services log structured events and never secrets or request headers, so this
# is safe to print into a CI log.
diagnostics() {
  log 'container status:'
  compose ps -a || true
  local service
  for service in migrate api worker web; do
    log "last log lines from ${service}:"
    compose logs --no-log-prefix --tail 40 "$service" || true
  done
}

fail() {
  printf '[deploy] FAILED: %s\n' "$*" >&2
  diagnostics
  exit 1
}

# Health of a service's container: healthy | starting | unhealthy | none |
# missing. `none` means the image defines no healthcheck.
health_of() {
  local id
  id="$(compose ps -q "$1")"
  if [[ -z "$id" ]]; then
    echo missing
    return
  fi
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id"
}

# Poll until a service is healthy, or give up at the shared deadline.
wait_healthy() {
  local service="$1" status
  while true; do
    status="$(health_of "$service")"
    if [[ "$status" == healthy ]]; then
      log "${service} is healthy"
      return 0
    fi
    if ((SECONDS >= deadline)); then
      fail "${service} not healthy after ${HEALTH_TIMEOUT_SECONDS}s (last status: ${status})"
    fi
    sleep 5
  done
}

# GET a path on the published web port from this host, and require both the
# status code and a marker in the body.
check_http() {
  local path="$1" expected_status="$2" expected_body="$3" body status
  body="$(mktemp)"
  status="$(curl -sS -o "$body" -w '%{http_code}' --max-time 10 "http://127.0.0.1:${web_port}${path}" || true)"
  if [[ "$status" != "$expected_status" ]] || ! grep -q "$expected_body" "$body"; then
    rm -f "$body"
    fail "GET ${path} returned ${status:-no response}, expected ${expected_status} with '${expected_body}'"
  fi
  rm -f "$body"
  log "GET ${path} -> ${status}"
}

# --- 1. Preflight -------------------------------------------------------------

[[ -f docker-compose.prod.yml ]] || {
  echo '[deploy] FAILED: run from the repository root' >&2
  exit 1
}
[[ -f .env.production ]] || {
  echo "[deploy] FAILED: .env.production not found in $(pwd)" >&2
  exit 1
}
# Resolves every ${VAR:?} in the Compose file, so a missing production value is
# reported here instead of halfway through a rollout. -q prints nothing, so no
# resolved secret reaches the log.
compose config -q

# --- 2. Keep the running version ----------------------------------------------

# Tag the images the running containers use, not whatever :prod points at: a
# failed earlier build may already have moved :prod. And only when both are
# healthy, so a failed deploy can never overwrite the last known-good copy.
if [[ "$(health_of api)" == healthy && "$(health_of web)" == healthy ]]; then
  docker tag "$(docker inspect -f '{{.Image}}' "$(compose ps -q api)")" api-watchdog-api:prod-previous
  docker tag "$(docker inspect -f '{{.Image}}' "$(compose ps -q web)")" api-watchdog-web:prod-previous
  log 'running images tagged :prod-previous (manual rollback target)'
else
  log 'running stack is not fully healthy; keeping the existing :prod-previous tags'
fi

# --- 3. Build -----------------------------------------------------------------

log 'building images'
if ! compose build; then
  echo '[deploy] FAILED: image build failed; running containers were not touched' >&2
  exit 1
fi

# --- 4. Roll out --------------------------------------------------------------

log 'starting the new version (migrations run first)'
if ! compose up -d; then
  # Compose stops here when a service it waits on fails: migrate exiting
  # non-zero (api and worker are then never replaced), or api never becoming
  # healthy. The logs below say which.
  fail 'docker compose up failed: a service did not start or become healthy (see logs below)'
fi

# --- 5. Verify ----------------------------------------------------------------

deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
wait_healthy api
wait_healthy web

# The worker has no healthcheck. A worker that crashes on startup is restarted
# by Docker, and every restart counts; a fresh container starts at zero.
worker_id="$(compose ps -q worker)"
[[ -n "$worker_id" ]] || fail 'worker container is missing'
worker_state="$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$worker_id")"
[[ "$worker_state" == 'running 0' ]] || fail "worker is not stable (status, restarts: ${worker_state})"
log 'worker is running'

# Whatever host port web is published on (80 on EC2, 8080 locally).
web_port="$(compose port web 8080)"
web_port="${web_port##*:}"
[[ -n "$web_port" ]] || fail 'web has no published port'

check_http / 200 'id="root"'
check_http /dashboard 200 'id="root"'
# 401 JSON from Express proves the whole path: host port -> Nginx -> api.
check_http /api/auth/me 401 '"unauthenticated"'

# Untagged layers left behind by rebuilt images. Dangling images only: tagged
# images (including :prod-previous) and volumes are never touched.
docker image prune -f >/dev/null

compose ps
log "deployed $(git rev-parse --short HEAD) successfully"
