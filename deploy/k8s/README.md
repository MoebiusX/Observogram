# Deploying Observogram to Kubernetes

Observogram is a single Express server ([server/index.mjs](../../server/index.mjs))
that serves the studio UI and the `/api/*` routes from one process. The
deploy is correspondingly small: one Deployment, one Service, one Ingress,
and one PersistentVolumeClaim that holds the studio's state.

```bash
# 1. Stamp the checkout (build.json says which commit the image is), then build it from the repo root.
npm run build:stamp && docker build -t observogram:0.4.0 .

# 2. Make it visible to your cluster.
#    docker-desktop: nothing to do.
#    kind:           kind load docker-image observogram:0.4.0
#    remote:         docker tag observogram:0.4.0 <registry>/observogram:0.4.0
#                    docker push <registry>/observogram:0.4.0
#                    cd deploy/k8s && kustomize edit set image observogram=<registry>/observogram:0.4.0

# 3. Check that the cluster can provision the store volume (see "Storage class" below).
kubectl get storageclass            # one line should say (default)

# 4. Apply (from the repo root).
kubectl create namespace observability --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -k deploy/k8s
```

Then open `http://obspack.localhost/` (or whatever host you set in
[ingress.yaml](ingress.yaml)).

## The store volume

The base is no longer ephemeral. The studio pod mounts its own
`ReadWriteOnce` claim, `observabilitypack-studio-store`
([pvc-store.yaml](pvc-store.yaml)), as the volume `store`, in two subPaths:

| subPath | Mounted at | Env | Holds |
|---|---|---|---|
| `db` | `/data/db` | `OBSERVOGRAM_DB=/data/db/observogram.db` | the database: users, orgs, memberships, the audit, the session epoch that revokes cookies |
| `workspace` | `/data/workspace` | `OBSERVOGRAM_WORKSPACE=/data/workspace` | the files the rows point at: `packs/`, `snapshots/`, `deploys.jsonl`, `journeys/`, `runs/`, `session-secret`, `users.json` and `orgs.json` until the store imports them |

Before this volume, the workspace was the image's `/app/.observogram`, so
every rollout and every pod restart wiped users, registered packs and the
deploy audit. With the store it would also have wiped roles and the audit,
and reset the session epoch, which revives revoked cookies. Both halves now
live on one claim, so they persist together and a rollout loses neither.
The studio opens the store at start; its first start imports the legacy
files (`users.json`, `orgs.json`) once, prints a report in the pod log and
leaves them in place, never read again
([docs/STORE_PLAN.md](../../docs/STORE_PLAN.md)). From then on the user and
org CLIs (`kubectl exec … -- node tools/user-admin.mjs …`,
`tools/org-admin.mjs …`) change users and orgs; a `users.json` or
`orgs.json` edited after the import makes the next start refuse, naming the
file and the way out.

**The database is never on NFS or an RWX volume.** It runs in WAL mode,
which needs shared memory between the processes on one host, and the store
refuses to open it on NFS, CIFS/SMB or CephFS. Give the store claim a
block-backed class (a cloud disk, local-path, hostPath) and keep it
`ReadWriteOnce`. Keep `OBSERVOGRAM_DB` outside the workspace: unset, it
defaults to `<workspace>/observogram.db`, and the journeys overlay below
moves the workspace to a claim that may be RWX.

**Backups.** A copy of `/data/workspace` alone holds no users, orgs or
audit, and a file-by-file copy of `/data/db` taken while the studio runs is
not a backup (a WAL checkpoint between two file copies tears it). Copy with
the studio scaled to 0, take an atomic volume snapshot, or take a live one
from inside the running pod. The image has no `packc` on `PATH`
(`npm ci --omit=dev` does not link the package's own bin), so call the CLI
by path:

```bash
kubectl -n observability exec deploy/observabilitypack-studio -- \
  node tools/cli.mjs store backup /data/db/backup-$(date +%Y%m%d).db
```

**Restore.** `store restore` refuses while anything holds the database, so
scale the studio to 0 and run it from a one-off pod that mounts both
subPaths of the `store` claim at the studio's two paths, with
`OBSERVOGRAM_DB` and `OBSERVOGRAM_WORKSPACE` set as the studio sets them
(the workspace is where the restore reads the `.store-imported` marker it
warns against), then scale back to 1. The backup must be on that claim (the
exec line above writes it to `/data/db`):

```bash
NS=observability
BACKUP=backup-20260924.db                 # a file under /data/db on the store claim

# 1. Stop the studio and wait for its pod to be gone.
kubectl -n $NS scale deployment/observabilitypack-studio --replicas=0
kubectl -n $NS wait --for=delete pod -l app.kubernetes.io/name=observabilitypack-studio,app.kubernetes.io/component=studio --timeout=180s

# 2. Restore from a one-off pod on the store claim ($BACKUP expands: the
#    heredoc is unquoted).
kubectl -n $NS apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: observogram-store-restore
spec:
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    fsGroupChangePolicy: OnRootMismatch
  containers:
    - name: restore
      image: observogram:0.4.0          # the studio's image and tag
      workingDir: /app
      command: ["node", "tools/cli.mjs", "store", "restore", "/data/db/$BACKUP"]
      env:
        - { name: OBSERVOGRAM_DB, value: /data/db/observogram.db }
        - { name: OBSERVOGRAM_WORKSPACE, value: /data/workspace }
      volumeMounts:
        - { name: store, mountPath: /data/db, subPath: db }
        - { name: store, mountPath: /data/workspace, subPath: workspace }
  volumes:
    - name: store
      persistentVolumeClaim: { claimName: observabilitypack-studio-store }
EOF
kubectl -n $NS wait --for=jsonpath='{.status.phase}'=Succeeded pod/observogram-store-restore --timeout=300s
kubectl -n $NS logs observogram-store-restore     # restored … -> /data/db/observogram.db, moved aside: …
kubectl -n $NS delete pod observogram-store-restore

# 3. Start the studio again.
kubectl -n $NS scale deployment/observabilitypack-studio --replicas=1
```

The replaced database, with its `-wal` and `-shm`, is moved aside beside it
under one timestamp (`observogram.db.pre-restore-<ts>`), so a wrong restore
can be undone the same way. Restore a backup of this deployment's own
store: the workspace's `.store-imported` marker names the store the legacy
files were imported into; a restore of another store's backup ends its log
with a `warning:` naming both, and a start against it refuses and says so.
With the journeys overlay below, mount the workspace claim at `/workspace`
instead of the `workspace` subPath and set `OBSERVOGRAM_WORKSPACE=/workspace`,
as for the export. If the phase never reaches `Succeeded`, `kubectl logs` shows the
refusal (something still holds the database, or the file is not an
Observogram store).

### Rolling the image back, and forward again

Never roll the studio back to a pre-store image (one built before the
store) with a bare `kubectl rollout undo`: the old build reads
`users.json` / `orgs.json`, not the store, so passwords changed since the
upgrade revert and removed users come back. Export in place first, with
the studio at 0, from a one-off pod of the **store** image (the old one
has no `store export`) that mounts both subPaths of the `store` claim at
the studio's two paths:

The pre-store release is the git tag `v0.4.0`, and the store build is
still `0.4.0` in `package.json` and `kustomization.yaml`: a local
`observogram:0.4.0` built from this checkout is the store build, and it
replaced any older image of that name. Build the old one under a tag of its
own (`git archive v0.4.0 | docker build -t observogram:0.4.0-prestore -`,
then load or push it as in step 2 at the top), and take the store image
from the Deployment rather than retyping it. Step 3 changes the image the
Deployment runs, so step 0 records the store image as the
`observogram.io/store-image` annotation on the Deployment, which step 3
leaves alone, and every later shell reads it back from there:

```bash
NS=observability
OLD_IMAGE=<registry>/observogram:0.4.0-prestore   # built from the v0.4.0 tag, never observogram:0.4.0

# 0. Record the store build the studio runs now. Once, before step 3:
#    run after it, this would record $OLD_IMAGE.
kubectl -n $NS annotate --overwrite deployment/observabilitypack-studio \
  observogram.io/store-image="$(kubectl -n $NS get deployment/observabilitypack-studio \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="studio")].image}')"
STORE_IMAGE=$(kubectl -n $NS get deployment/observabilitypack-studio \
  -o jsonpath='{.metadata.annotations.observogram\.io/store-image}')
echo "$STORE_IMAGE"                               # the store build, not observogram:0.4.0-prestore

# 1. A live backup, then stop the studio and wait for its pod to be gone.
kubectl -n $NS exec deploy/observabilitypack-studio -- \
  node tools/cli.mjs store backup /data/db/before-rollback-$(date +%Y%m%d).db
kubectl -n $NS scale deployment/observabilitypack-studio --replicas=0
kubectl -n $NS wait --for=delete pod -l app.kubernetes.io/name=observabilitypack-studio,app.kubernetes.io/component=studio --timeout=180s

# 2. Export in place (<dir> = the workspace) from a one-off pod
#    ($STORE_IMAGE expands: the heredoc is unquoted).
kubectl -n $NS apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: observogram-store-export
spec:
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    fsGroupChangePolicy: OnRootMismatch
  containers:
    - name: export
      image: $STORE_IMAGE
      workingDir: /app
      command: ["node", "tools/cli.mjs", "store", "export", "/data/workspace"]
      env:
        - { name: OBSERVOGRAM_DB, value: /data/db/observogram.db }
        - { name: OBSERVOGRAM_WORKSPACE, value: /data/workspace }
      volumeMounts:
        - { name: store, mountPath: /data/db, subPath: db }
        - { name: store, mountPath: /data/workspace, subPath: workspace }
  volumes:
    - name: store
      persistentVolumeClaim: { claimName: observabilitypack-studio-store }
EOF
kubectl -n $NS wait --for=jsonpath='{.status.phase}'=Succeeded pod/observogram-store-export --timeout=300s
kubectl -n $NS logs observogram-store-export      # export: in place in /data/workspace …, users.json: …, note: …
kubectl -n $NS delete pod observogram-store-export

# 3. Change the image only (keep the store volume and the env), then start.
kubectl -n $NS set image deployment/observabilitypack-studio studio=$OLD_IMAGE
kubectl -n $NS scale deployment/observabilitypack-studio --replicas=1
```

With the journeys overlay below, the studio's workspace is the
`observabilitypack-studio-workspace` claim at `/workspace`: mount that
claim there instead of the `workspace` subPath, and set
`OBSERVOGRAM_WORKSPACE=/workspace` and the export directory to
`/workspace`. Change the image, not the manifests: an older base kept the
workspace in the container, where every restart lost it. The export's log lists the
users it wrote, the viewers and operators who regain full write on the old
build (it enforces no roles), and the cookie note: users revoked in the
store stay signed in there until their cookies expire, and rotating
`OBSERVOGRAM_SESSION_SECRET` signs everyone out. When it prints "the
default org's root is now orgs/default — point its CronJobs at …", the
default org's data moved to `orgs/default/` for the old build: point that
org's journey CronJob at `/workspace/orgs/default` (see Tenancy below).
If the phase never reaches `Succeeded`, `kubectl logs` shows the refusal
(something still holds the database, an `orgs/default/` entry already
exists, or the workspace is not provably this store's: its marker, or a
database in it, names another store).

To read the files first without touching the workspace, a directory export
from the running studio writes them to a new directory on the store claim.
A directory export writes only into a directory that does not exist or is
empty, so name a fresh one each time, never `/data/db` itself (it holds
the database) or an earlier export:

```bash
kubectl -n $NS exec deploy/observabilitypack-studio -- \
  node tools/cli.mjs store export /data/db/export-$(date +%Y%m%d%H%M%S)
```

**Forward again:** in any shell, read the store image back from the
annotation step 0 wrote (not from the image the Deployment runs, which is
now `$OLD_IMAGE`) and set the image back to it:

```bash
NS=observability
STORE_IMAGE=$(kubectl -n $NS get deployment/observabilitypack-studio \
  -o jsonpath='{.metadata.annotations.observogram\.io/store-image}')
echo "$STORE_IMAGE"                               # empty: step 0 never ran; stop and find the store image
kubectl -n $NS set image deployment/observabilitypack-studio studio=$STORE_IMAGE
```

If nothing was changed on the old build, the studio starts. If users or orgs were, the
pod log shows `refusing to start: … changed since store … last imported
it`. Scale to 0, run the one-off pod above with the command `["node",
"tools/cli.mjs", "store", "import", "--replace"]` (its log: `replace
requested: the next server start re-imports …`), and scale to 1: that
start re-imports the files with the studio's own environment and logs a
`[store] replaced from …` report.

**The IdP moved.** A studio whose `OBSERVOGRAM_OIDC_ISSUER` names another
issuer than the store recorded refuses to start. Scale to 0 and run the
one-off pod with `["node", "tools/cli.mjs", "store", "rekey-issuer",
"--to", "<new issuer URL>"]` (the same IdP at a new URL: the users keep
their rows, roles and owner flag, and sign in again) or with `["node",
"tools/cli.mjs", "store", "rekey-issuer", "--clear"]` (a different IdP:
the old OIDC users are disabled; set `OBSERVOGRAM_BOOTSTRAP_ADMIN` in the
Deployment to name the new owner). Update the issuer in the Deployment and
scale to 1. `store purge-org <id>` (the files of an org removed with
`tools/org-admin.mjs remove`) runs the same way; it cannot be undone and
asks for no confirmation, and it deletes that org's packs, `deploys.jsonl`,
`snapshots/`, `runs/` and `journeys/`, which no `store backup` holds, so
copy `/data/workspace/orgs/<id>` off the claim first.

### Storage class

`kubectl apply -k deploy/k8s` now needs a **default StorageClass**, or a
`storageClassName` in [pvc-store.yaml](pvc-store.yaml) (the commented
stanza). Without either, the claim stays `Pending` and so does the pod
(`pod has unbound immediate PersistentVolumeClaims`). docker-desktop
(`hostpath`) and kind (`standard`) ship a default; on other clusters check
`kubectl get storageclass` for `(default)`. `1Gi` is a placeholder, not a
measurement: the database is small, and the workspace grows with registered
packs, rollback snapshots and `deploys.jsonl`.

### Pod settings

- `securityContext.fsGroup: 1000` with `fsGroupChangePolicy: OnRootMismatch`.
  A freshly provisioned volume is root:root 0755 with most CSI/hostPath
  provisioners, so without it the studio (uid 1000) could create neither
  the database nor the workspace. `OnRootMismatch` skips the recursive
  chown once the volume root already belongs to the group.
- `strategy: Recreate`, and `replicas: 1` (a multi-instance studio is out of
  scope). A RollingUpdate briefly runs two studio processes against one
  database. It stalls on attach when the RWO volume sits on another node.
  And on the store upgrade it would run the new pod's import while the old
  pod still writes the legacy files. Only `Recreate` waits for the old pod
  to finish terminating; `maxSurge: 0` does not. The cost is a short outage
  per rollout. Do not switch it back.

Upgrading a deploy of the old base: its workspace lived in the container,
where every restart already lost it, and the rollout to this base starts on
an empty volume. If the running pod holds anything you need, save it with
`kubectl cp` from `/app/.observogram` before you apply, and put it into
`/data/workspace` with the studio scaled to 0, from a one-off pod that
mounts the `store` claim, as in the overlay switch below.

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
  (`OBSERVOGRAM_OIDC_*`) also satisfies the requirement; with it,
  `OBSERVOGRAM_BOOTSTRAP_ADMIN` names the first owner (`<issuer>#<sub>`, or
  an email the ID token marks verified) — see
  [.env.example](../../.env.example).
- `GITHUB_TOKEN` (optional) — uncomment in
  [deployment-studio.yaml](deployment-studio.yaml) to raise GitHub rate
  limits / allow private repos for `POST /api/crawl-github`.
- What persists: everything in the workspace and the database, on the store
  volume above. What does not: `examples/production-live.pack.yaml`, which
  `POST /api/refresh-live` writes to the container filesystem; a pod
  restart clears it, by design.

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

Switching a running base deploy to the overlay moves the workspace: copy it
first ([below](#switching-a-running-base-to-the-overlay)).

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
  (journeys/, runs/, deploys.jsonl, packs/, and the legacy users.json /
  orgs.json until the first start imports them). It takes the
  studio's workspace over from `/data/workspace`; the database stays on the
  store claim. `1Gi` is a placeholder, not a measurement: the workspace
  grows as journeys × `OBSERVOGRAM_JOURNEY_RUN_RETENTION` (default 1000) ×
  (one run record + an optional `live/` snapshot of Pack B). Measure one
  record and one snapshot from a real run of *your* journeys and size from
  that.
- `cronjob-journeys.yaml` — the fleet CronJob (`*/15 * * * *`;
  per-journey cadences come from `packc journey schedule <name> --format k8s`),
  `concurrencyPolicy: Forbid`, `backoffLimit: 0`, `restartPolicy: Never`:
  exit 1 (gate failed) is the early-warning *outcome* of a run, not a
  retryable fault — a retry would append a duplicate record — so
  `kubectl get jobs` shows a gate failure as a failed Job, which is the
  intended signal. The env var names your journeys reference
  (`packB.mcp.authEnv`, `notify.urlEnv`, `notify.authEnv`) are bound there
  from Secrets (`secretKeyRef`, commented stanzas) — never as literals. It
  never mounts the store claim and sets no `OBSERVOGRAM_DB`: the journey
  runner opens no database.
- `patch-studio-workspace.yaml` — mounts the same PVC into the studio at
  `/workspace` and sets its `OBSERVOGRAM_WORKSPACE`. It never touches
  `OBSERVOGRAM_DB`, the `store` volume or the strategy: the database stays
  at `/data/db/observogram.db` on the RWO store claim, and `Recreate`
  stands. It repeats the base's `fsGroup: 1000`.

Volume ownership: both pods run as uid 1000 and set `fsGroup: 1000`
(`fsGroupChangePolicy: OnRootMismatch`). A freshly provisioned PVC is
root:root 0755 with most CSI/hostPath provisioners; without the fsGroup
neither process could create `journeys/` or write `runs/` — the prerequisite
below would be met and the feature would still do nothing (EACCES in the
CronJob log). The per-journey CronJob printed by `packc journey schedule
--format k8s` carries the same field.

**Hard prerequisite:** BOTH processes mount the same PVC at the same
`OBSERVOGRAM_WORKSPACE` (`/workspace`). A CronJob writing to a path the studio
does not read produces records nobody sees. Access mode: `ReadWriteOnce` is
what every storage class offers; with RWO the CronJob pod must land on the
studio's node (the `podAffinity` in the CronJob, commented) or its volume
attach fails. `ReadWriteMany` (then drop the affinity) is safe **only while
the studio's `OBSERVOGRAM_DB` points at the RWO store volume**: an RWX class
is typically NFS or CephFS, where the database refuses to open, so never
unset `OBSERVOGRAM_DB` or point it under `/workspace` with an RWX workspace
claim. Tenancy: one CronJob per org —
`OBSERVOGRAM_WORKSPACE=/workspace/<orgs.root>` (the default org's root is
`.`, i.e. `/workspace`; a created org's is `orgs/<id>`, see `npm run orgs --
list`); the studio's k8s snippet for a journey already targets its org.

### Switching a running base to the overlay

Applying the overlay to a running base deploy moves the studio's workspace
from `/data/workspace` (a subPath of the store claim) to `/workspace` (the
new workspace claim), and the default org's root `.` moves with it. Copy the
whole `workspace` subPath across **before** the studio starts on the new
claim, with the studio stopped. The database stays on `store` and needs no
copy.

```bash
NS=observability

# 1. Stop the studio and wait for its pod to be gone (nothing may write during the copy;
#    "no matching resources" from the wait means it is gone already).
kubectl -n $NS scale deployment/observabilitypack-studio --replicas=0
kubectl -n $NS wait --for=delete pod -l app.kubernetes.io/name=observabilitypack-studio,app.kubernetes.io/component=studio --timeout=180s

# 2. Create ONLY the workspace claim. Applying the whole overlay now would
#    scale the studio back to 1 on an empty /workspace.
kubectl -n $NS apply -f deploy/k8s/components/journeys/pvc-workspace.yaml

# 3. Copy the whole workspace subPath, modes preserved, from a one-off pod
#    that mounts both claims (the studio image has sh and cp).
kubectl -n $NS apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: observogram-workspace-copy
spec:
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    fsGroupChangePolicy: OnRootMismatch
  containers:
    - name: copy
      image: observogram:0.4.0          # the studio's image and tag
      command: ["sh", "-c", "cp -a /data/workspace/. /workspace/ && ls -la /workspace"]
      volumeMounts:
        - { name: store, mountPath: /data/workspace, subPath: workspace }
        - { name: workspace, mountPath: /workspace }
  volumes:
    - name: store
      persistentVolumeClaim: { claimName: observabilitypack-studio-store }
    - name: workspace
      persistentVolumeClaim: { claimName: observabilitypack-studio-workspace }
EOF
kubectl -n $NS wait --for=jsonpath='{.status.phase}'=Succeeded pod/observogram-workspace-copy --timeout=600s
kubectl -n $NS logs observogram-workspace-copy
kubectl -n $NS delete pod observogram-workspace-copy

# 4. Apply the overlay: the studio comes back (replicas: 1) on /workspace, and the CronJob starts.
kubectl apply -k deploy/k8s-journeys
```

The copy carries everything: packs, snapshots, `deploys.jsonl`, journeys,
runs, `live/`, `session-secret` (so existing sessions stay signed in), every
`orgs/<id>/` root, and any legacy files (`users.json`, `orgs.json`) and
`.store-imported` marker. Check that the listing in step 3 shows them before
step 4. The old copy under `/data/workspace` stays on the store claim,
unused; delete it only once the studio shows the same users and packs.
Going back to the base alone is the same procedure in reverse
(`cp -a /workspace/. /data/workspace/`).

### Zones

Under the overlay the studio pod mounts **two** `ReadWriteOnce` claims, the
store and the workspace, and both volumes must sit in the zone its node is
in. On a single-zone cluster nothing changes. On a multi-zone cluster, use
a StorageClass with `volumeBindingMode: WaitForFirstConsumer`: each claim is
then provisioned where the first pod that uses it is scheduled, and the
scheduler keeps later pods beside it. An `Immediate` class works only when
it is pinned to one zone (`allowedTopologies`); otherwise it provisions each
claim in whatever zone it picks, and a pod that needs both never schedules.
Check:

```bash
kubectl get storageclass                                   # VOLUMEBINDINGMODE column
kubectl get storageclass <name> -o jsonpath='{.volumeBindingMode}{"\n"}'
kubectl -n observability get pvc                           # VOLUME column: the bound PVs
kubectl get pv <volume> -o jsonpath='{.spec.nodeAffinity}{"\n"}'   # the zone a PV is pinned to
```

The same applies to the one-off copy pod above, which mounts both claims:
with `WaitForFirstConsumer` it is what binds the new workspace claim, in the
store's zone.

## Validation

CI runs no kustomize/kubeconform. The manifests are checked structurally by
`tools/test-deploy-manifests.mjs` (`npm run test:deploy-manifests` — parses
every file, pins the store volume and its subPaths, `fsGroup` and
`Recreate` on the base, the shared PVC/mount/env on both sides of the
overlay, the overlay's namespace/labels, the non-retry contract and the
no-literal-secret rule, and checks on a modelled strategic merge of the
overlay that `OBSERVOGRAM_DB` stays on the store volume and the CronJob never
mounts it) and rendered by hand with `kubectl kustomize deploy/k8s-journeys`
(check that every `kind:` in the output is followed by
`namespace: observability`).
