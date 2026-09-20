# Image for the frontend dev server.
#
# Build context is the REPOSITORY ROOT, like the API image:
#     docker build -f apps/web/Dockerfile .
# vite, react and the rest of the toolchain are hoisted into the root
# node_modules by npm workspaces — apps/web/package.json lists only react,
# react-dom and react-router-dom, so an apps/web-only context could not install
# enough to start.
#
# This runs the Vite DEV SERVER, not a production build. That is deliberate:
# the browser must stay on a single origin for the /api proxy to work, and the
# proxy is what lets the API have no CORS configuration at all. A production
# image — static build behind a web server, with an SPA fallback rewrite —
# belongs with the deployment work, where there is a real deployment to build
# it against rather than a guess at one.
FROM node:24-bookworm-slim

WORKDIR /app
RUN chown node:node /app
USER node

# Manifests first, so editing source does not reinstall dependencies.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node packages/shared/package.json packages/shared/
COPY --chown=node:node apps/api/package.json apps/api/
COPY --chown=node:node apps/web/package.json apps/web/

RUN npm ci

# The whole context, so tsconfig.base.json is present — apps/web/tsconfig.json
# extends it, and esbuild reads that chain for jsx and target settings.
# .dockerignore keeps out node_modules, dist and every .env file.
COPY --chown=node:node . .

# No build step. The dev server compiles on demand and serves from source;
# `vite build` would produce a static bundle this image never serves.

# Create the directory the Compose anonymous volume mounts over.
#
# Docker seeds an anonymous volume from whatever is at that path in the image,
# ownership included. If the path does not exist, it creates an empty
# root-owned directory instead — and this container runs as `node`, which then
# cannot write Vite's dependency-optimisation cache into
# apps/web/node_modules/.vite and fails with EACCES at first request.
RUN mkdir -p /app/apps/web/node_modules

EXPOSE 5173

# cwd becomes Vite's project root, which is how it finds apps/web/vite.config.ts.
WORKDIR /app/apps/web

# --host binds 0.0.0.0 instead of Vite's default localhost. Inside a container
# "localhost" means the container's own loopback, so a default-bound dev server
# accepts nothing from outside and the port mapping appears dead.
#
# Passed here rather than set in vite.config.ts on purpose: putting host:true in
# the config would also make `npm run dev:web` on the host listen on the LAN,
# which it deliberately does not do today.
#
# node directly rather than npm, so the dev server is PID 1 and receives
# SIGTERM on `docker compose down` instead of being killed after a timeout.
CMD ["node", "/app/node_modules/vite/bin/vite.js", "--host", "0.0.0.0"]
