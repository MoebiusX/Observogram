# Observogram — studio + API in one Express server (server/index.mjs).
#
# Build:  npm run build:stamp && docker build -t observogram:0.4.0 .
# Run:    docker run --rm -p 8000:8000 -e OBSERVOGRAM_ADMIN_PASSWORD=<secret> observogram:0.4.0
#         (the image binds 0.0.0.0, and the server refuses to start off
#         loopback without a seeded sign-in or OBSERVOGRAM_API_TOKEN; the
#         workspace lives at /app/.observogram — mount a volume there or
#         point OBSERVOGRAM_WORKSPACE at one to keep users and packs)
# Open:   http://127.0.0.1:8000
#
# The k8s manifests under deploy/k8s/ expect this image; see deploy/k8s/README.md.
FROM node:22-alpine

# Which build is this image? The container has no .git (.dockerignore drops
# it), so stamp the checkout on the host BEFORE building: `npm run
# build:stamp` writes build.json (git-ignored) with the commit count, sha,
# branch, dirty flag and date, and the COPY below carries it next to
# package.json. server/build-info.mjs then answers the studio footer,
# GET /api/version and /healthz from that file (source 'file'); without it
# they say "build unknown" — never a guess.
#   npm run build:stamp && docker build -t observogram:0.4.0 .
# OBSERVOGRAM_BUILD, when given, overrides the composite build string on
# /healthz only (a CI run number or tag); /api/version stays the stamp.
#   docker build --build-arg OBSERVOGRAM_BUILD=ci-412 -t observogram:0.4.0 .
ARG OBSERVOGRAM_BUILD=
ENV OBSERVOGRAM_BUILD=$OBSERVOGRAM_BUILD

ENV NODE_ENV=production
WORKDIR /app

# Dependency layer first so source edits don't bust the npm cache.
# build.json* — the stamp above when it exists, nothing otherwise.
COPY package.json package-lock.json build.json* ./
RUN npm ci --omit=dev

# Everything the server reads at runtime (see server/index.mjs):
#   studio/           HTML/CSS/JS shell served statically
#   tools/            shared libs (adapter, compiler, crawler, fetcher)
#   vendor/           the vendored ObservabilityPack spec + schema
#   examples/         archived reference packs (GET /api/examples)
#   reference-packs/  catalogue packs (GET /api/references)
COPY server/ server/
COPY studio/ studio/
COPY tools/ tools/
COPY vendor/ vendor/
COPY examples/ examples/
COPY reference-packs/ reference-packs/

# The server runs as `node` (below) and writes two places under /app:
#   .observogram/  the workspace — users.json and the session secret at
#                  first boot, registered packs, the deploy audit; without
#                  this directory the first boot dies with EACCES seeding
#                  the admin user (OBSERVOGRAM_WORKSPACE relocates it)
#   examples/      POST /api/refresh-live writes production-live.pack.yaml
RUN mkdir -p /app/.observogram && chown -R node:node /app/.observogram /app/examples

USER node
ENV HOST=0.0.0.0 PORT=8000
EXPOSE 8000
CMD ["node", "server/index.mjs"]
