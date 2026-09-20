# Image for the API and the worker.
#
# One image, two containers. `index.ts` and `worker.ts` are two entrypoints in
# the same workspace with the same dependencies, so building them twice would
# only mean two things to keep in step. The Compose file picks the entrypoint
# per service.
#
# Build context is the REPOSITORY ROOT, not apps/api:
#     docker build -f apps/api/Dockerfile .
# npm workspaces hoists every dependency into the root node_modules, all the
# dev tooling (typescript, node-pg-migrate) lives in the root package.json, and
# `tsc -b` has to see packages/shared. An apps/api-only context has none of it.

# Debian slim rather than Alpine, on purpose. `bcrypt` is a native addon and
# publishes prebuilt binaries for glibc but not for Alpine's musl, so Alpine
# would compile it from source and need python3/make/g++ in the image. The
# ~80MB saving is not worth the build complexity for a dependency that is on
# the login path. Node 24 matches .nvmrc and the engines field.
FROM node:24-bookworm-slim

# /app, owned by the unprivileged `node` user that the official image ships.
# Running as root inside a container is a needless privilege: a process that is
# compromised should not also be able to rewrite its own runtime.
WORKDIR /app
RUN chown node:node /app
USER node

# Manifests first, source later — this is the layer-caching split.
#
# `npm ci` is the slow step, and a layer is only rebuilt when its inputs
# change. Copying just the manifests means editing a .ts file reuses the cached
# install instead of redownloading every dependency. All four manifests are
# needed: npm reads the whole workspace graph before it installs anything.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node packages/shared/package.json packages/shared/
COPY --chown=node:node apps/api/package.json apps/api/
COPY --chown=node:node apps/web/package.json apps/web/

# `npm ci` rather than `npm install`: it installs exactly what package-lock.json
# pins and fails if the lockfile and manifests disagree, so an image is a
# reproducible build of a known dependency set rather than whatever resolved
# today.
#
# devDependencies are deliberately kept. They are not optional here: typescript
# performs the build below, and node-pg-migrate is what the `migrate` service
# runs. This is a local-development image; a slimmer production image that
# separates build from runtime belongs with the AWS work, where it can be
# written against a real deployment instead of a guess at one.
RUN npm ci

# Now the source. Everything in .dockerignore is already excluded — notably the
# host node_modules, any stale dist, and every .env file.
COPY --chown=node:node . .

# Compiles packages/shared then apps/api, in that order, via TypeScript project
# references. The order matters: @api-watchdog/shared resolves to its dist/, so
# the API cannot run until shared has been built.
RUN npm run build

EXPOSE 3000

# `node` directly, never `npm start`.
#
# This process is PID 1, and PID 1 receives SIGTERM on `docker stop` and on
# every redeploy. npm would spawn node as a child and not reliably forward the
# signal, so the graceful shutdown in index.ts — drain in-flight requests, close
# the queue, then Redis, then the pool — would never run and Docker would
# SIGKILL the process instead. The worker overrides this command in Compose.
CMD ["node", "apps/api/dist/index.js"]
