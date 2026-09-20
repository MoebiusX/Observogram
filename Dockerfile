# Observogram — studio + API in one Express server (server/index.mjs).
#
# Build:  docker build -t observogram:0.4.0 .
# Run:    docker run --rm -p 8000:8000 observogram:0.4.0
# Open:   http://127.0.0.1:8000
#
# The k8s manifests under deploy/k8s/ expect this image; see deploy/k8s/README.md.
FROM node:22-alpine

# Bake the build identifier into the image — the container has no .git,
# so server/version.mjs reads this instead. Pass your CI run number/sha:
#   docker build --build-arg OBSERVOGRAM_BUILD=412.a1b2c3d -t observogram:0.4.0 .
ARG OBSERVOGRAM_BUILD=container
ENV OBSERVOGRAM_BUILD=$OBSERVOGRAM_BUILD

ENV NODE_ENV=production
WORKDIR /app

# Dependency layer first so source edits don't bust the npm cache.
COPY package.json package-lock.json ./
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
