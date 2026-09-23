# Deploying Observogram to Kubernetes

Observogram is a single Express server ([server/index.mjs](../../server/index.mjs))
that serves the studio UI and the `/api/*` routes from one process. The
deploy is correspondingly small: one Deployment, one Service, one Ingress.

```bash
# 1. Stamp the checkout (build.json says which commit the image is), then build it from the repo root.
npm run build:stamp && docker build -t observogram:0.4.0 .

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
  filesystem — both are intentionally ephemeral; a pod restart clears them
  — as is the workspace (journeys, run history, deploy audit), unless the
  workspace PVC of the opt-in journeys component below is mounted.

## Scheduled journeys (opt-in)

Scheduling is **delegated, not built** (docs/VALUE_BACKLOG.md item 11): an
in-process timer in the server was considered and not chosen — it would put a
scheduler, its retries and its clock inside the studio and make the studio's
uptime the journey's uptime. Kubernetes already has one. The opt-in component
runs `packc journey run --all` as a CronJob against the same workspace the
studio reads:

```bash
kubectl apply -k deploy/k8s-journeys     # base + components/journeys (sibling overlay)
kubectl apply -k deploy/k8s              # the base alone stays byte-identical
```

(The overlay is a sibling directory, not `deploy/k8s/overlays/…`: kustomize
refuses a kustomization whose resource is a parent directory — "cycle
detected" — and the base must stay where it is. It repeats the base's
`namespace: observability` and `app.kubernetes.io/part-of` label on purpose:
the base's transformers apply to the base's own resources only, so without
them the component's PVC and CronJob would render namespace-less — landing in
your kubeconfig's current namespace while the patched studio Deployment in
`observability` waits on a claim that does not exist there. Every document of
`kubectl kustomize deploy/k8s-journeys` carries the namespace;
`tools/test-deploy-manifests.mjs` pins the overlay's values equal to the
base's.)

What the component adds ([components/journeys](components/journeys)):

- `pvc-workspace.yaml` — the PVC `observabilitypack-studio-workspace`
  (journeys/, runs/, deploys.jsonl, users.json, packs/). `1Gi` is a
  placeholder, not a measurement: the workspace grows as
  journeys × `OBSERVOGRAM_JOURNEY_RUN_RETENTION` (default 1000) × (one run
  record + an optional `live/` snapshot of Pack B). Measure one record and
  one snapshot from a real run of *your* journeys and size from that.
- `cronjob-journeys.yaml` — the fleet CronJob (`*/15 * * * *`;
  per-journey cadences come from `packc journey schedule <name> --format k8s`),
  `concurrencyPolicy: Forbid`, `backoffLimit: 0`, `restartPolicy: Never`:
  exit 1 (gate failed) is the early-warning *outcome* of a run, not a
  retryable fault — a retry would append a duplicate record — so
  `kubectl get jobs` shows a gate failure as a failed Job, which is the
  intended signal. The env var names your journeys reference
  (`packB.mcp.authEnv`, `notify.urlEnv`, `notify.authEnv`) are bound there
  from Secrets (`secretKeyRef`, commented stanzas) — never as literals.
- `patch-studio-workspace.yaml` — mounts the same PVC into the studio at the
  same path, sets its `OBSERVOGRAM_WORKSPACE` and adds `fsGroup: 1000` to the
  studio pod.

Volume ownership: both pods run as uid 1000 and set `fsGroup: 1000`
(`fsGroupChangePolicy: OnRootMismatch`). A freshly provisioned PVC is
root:root 0755 with most CSI/hostPath provisioners; without the fsGroup
neither process could create `journeys/` or write `runs/` — the prerequisite
below would be met and the feature would still do nothing (EACCES in the
CronJob log). The per-journey CronJob printed by `packc journey schedule
--format k8s` carries the same field.

**Hard prerequisite:** BOTH processes mount the same PVC at the same
`OBSERVOGRAM_WORKSPACE` (`/workspace`). A CronJob writing to a path the studio
does not read produces records nobody sees — and `/app/.observogram` is not
creatable by uid 1000 (the image only chowns `/app/examples`,
[Dockerfile](../../Dockerfile)). Access mode: `ReadWriteOnce` is what every
storage class offers; with RWO the CronJob pod must land on the studio's node
(the `podAffinity` in the CronJob, commented) or its volume attach fails —
switch to `ReadWriteMany` where the storage class offers it. Tenancy: when
`<workspace>/orgs.json` exists, point the CronJob at the org root
(`OBSERVOGRAM_WORKSPACE=/workspace/orgs/<orgId>`; the CLI resolves the flat
root only).

Validation: CI runs no kustomize/kubeconform. The manifests are checked
structurally by `tools/test-deploy-manifests.mjs` (`npm run
test:deploy-manifests` — parses every file, pins the shared PVC/mount/env on
both sides, the overlay's namespace/labels, the non-retry contract and the
no-literal-secret rule) and rendered by hand with `kubectl kustomize
deploy/k8s-journeys` (check that every `kind:` in the output is followed by
`namespace: observability`).
