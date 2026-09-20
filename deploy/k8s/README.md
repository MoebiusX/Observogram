# Deploying Observogram to Kubernetes

Observogram is a single Express server ([server/index.mjs](../../server/index.mjs))
that serves the studio UI and the `/api/*` routes from one process. The
deploy is correspondingly small: one Deployment, one Service, one Ingress.

```bash
# 1. Build the image from the repo root.
docker build -t observogram:0.4.0 .

# 2. Make it visible to your cluster.
#    docker-desktop: nothing to do.
#    kind:           kind load docker-image observogram:0.4.0
#    remote:         docker tag observogram:0.4.0 <registry>/observogram:0.4.0
#                    docker push <registry>/observogram:0.4.0
#                    cd deploy/k8s && kustomize edit set image observogram=<registry>/observogram:0.4.0

# 3. Apply (from the repo root).
kubectl create namespace observability --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -k deploy/k8s
```

Then open `http://obspack.localhost/` (or whatever host you set in
[ingress.yaml](ingress.yaml)).

## What happened to nginx / the fetcher sidecar / the MCP secret?

Pre-v0.3 the studio was a static HTML file served by nginx, with packs and
schema embedded as ConfigMaps and a sidecar polling an MCP endpoint into the
docroot. That architecture is gone:

- The studio shell needs the server-side API (validation, adaptation,
  conformance scoring, compile, deploy) — it cannot be served statically.
- Packs, schema, and studio assets ship inside the image.
- Live MCP drafting is interactive (`POST /api/draft-from-mcp`); the MCP URL
  and auth key are entered in the studio UI per request, so the cluster
  holds no MCP credentials for the studio.

## Knobs

- **Auth (required)** — binding to `0.0.0.0` fails closed without it.
  Uncomment in [deployment-studio.yaml](deployment-studio.yaml):
  `OBSERVOGRAM_ADMIN_PASSWORD` seeds the `admin` sign-in on first boot
  (the loopback `admin/admin` default is never seeded off-loopback),
  and/or `OBSERVOGRAM_API_TOKEN` for service-account/CI access. OIDC
  (`OBSERVOGRAM_OIDC_*`) also satisfies the requirement — see
  [.env.example](../../.env.example).
- `GITHUB_TOKEN` (optional) — uncomment in
  [deployment-studio.yaml](deployment-studio.yaml) to raise GitHub rate
  limits / allow private repos for `POST /api/crawl-github`.
- Uploaded/crawled/drafted packs live in process memory and
  `examples/production-live.pack.yaml` is written to the container
  filesystem — both are intentionally ephemeral; a pod restart clears them.
