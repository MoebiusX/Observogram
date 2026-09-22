# Observogram — studio + API in one Express server (server/index.mjs).
#
# Build:  docker build -t observogram:0.4.0 .
# Run:    docker run --rm -p 8000:8000 observogram:0.4.0
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

# POST /api/refresh-live writes examples/production-live.pack.yaml at runtime.
RUN chown -R node:node /app/examples

USER node
ENV HOST=0.0.0.0 PORT=8000
EXPOSE 8000
CMD ["node", "server/index.mjs"]
