#!/usr/bin/env node
/**
 * tools/test-deploy-manifests.mjs
 *
 * Structural test for deploy/k8s (step 5; STORE_PLAN §3): every YAML under
 * it parses with mini-yaml; the base is four resources — the studio
 * Deployment mounts its own RWO `store` PVC as two subPaths (the database at
 * /data/db, the workspace at /data/workspace), with fsGroup and
 * `strategy: Recreate`; the opt-in journeys component wires ONE workspace PVC
 * into BOTH the CronJob and the studio at the SAME OBSERVOGRAM_WORKSPACE and
 * never moves OBSERVOGRAM_DB off the store volume (checked on a modelled
 * strategic-merge render of the overlay); the CronJob carries the non-retry
 * contract and never mounts the store claim; no secret-shaped env var
 * carries a literal value anywhere; and the CLI's per-journey CronJob
 * (schedule-snippets.mjs) agrees with the component on the PVC name and the
 * mount; and the README's one-off restore/export pods see the studio's
 * database and workspace at the studio's paths. CI runs no kustomize/kubeconform — this is the gate; `kubectl
 * kustomize deploy/k8s-journeys` (the sibling overlay — kustomize refuses one
 * nested under the base it references) is run by hand.
 * Exit 0 = pass.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, posix } from 'node:path';
import { createHarness } from './lib/harness.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { k8sCronJobManifest, K8S_WORKSPACE_PVC, K8S_WORKSPACE_MOUNT } from './lib/schedule-snippets.mjs';

const { assert, report } = createHarness();
const ROOT = new URL('../', import.meta.url);
const K8S = join(ROOT.pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'deploy', 'k8s');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.ya?ml$/.test(e)) out.push(p);
  }
  return out.sort();
}
const files = walk(K8S);
// mini-yaml keeps the last of two equal keys, so a repeated top-level key
// parses here yet is invalid YAML that strict tools (yamllint key-duplicates,
// go-yaml v3) reject. Scan the raw text per document instead.
function duplicateTopLevelKeys(text) {
  const dups = [];
  let seen = new Map();
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^---(\s|$)/.test(line)) { seen = new Map(); return; }
    const m = /^([A-Za-z_][\w.-]*):(\s|$)/.exec(line);
    if (!m) return;
    if (seen.has(m[1])) dups.push(`${m[1]} (lines ${seen.get(m[1])} and ${i + 1})`);
    else seen.set(m[1], i + 1);
  });
  return dups;
}
const docs = {};
for (const f of files) {
  const rel = relative(K8S, f).replaceAll('\\', '/');
  const text = readFileSync(f, 'utf8');
  let parsed = null, err = null;
  try { parsed = parseYaml(text); } catch (e) { err = e.message; }
  assert(parsed && typeof parsed === 'object' && !err, `${rel} parses with mini-yaml`, err);
  const dups = duplicateTopLevelKeys(text);
  assert(dups.length === 0, `${rel} has no duplicate top-level keys`, dups);
  docs[rel] = parsed;
}
assert(Object.keys(docs).join() === 'components/journeys/cronjob-journeys.yaml,components/journeys/kustomization.yaml,components/journeys/patch-studio-workspace.yaml,components/journeys/pvc-workspace.yaml,deployment-studio.yaml,ingress.yaml,kustomization.yaml,pvc-store.yaml,service.yaml',
       'deploy/k8s holds the base and the journeys component — nothing else (the overlay is the sibling deploy/k8s-journeys)', Object.keys(docs));
// The sibling overlay (kustomize refuses an overlay nested under the base it references).
const OVERLAY = join(K8S, '..', 'k8s-journeys', 'kustomization.yaml');
{
  let overlayParsed = null, overlayErr = null;
  const overlayText = readFileSync(OVERLAY, 'utf8');
  try { overlayParsed = parseYaml(overlayText); } catch (e) { overlayErr = e.message; }
  assert(overlayParsed && !overlayErr, 'deploy/k8s-journeys/kustomization.yaml parses with mini-yaml', overlayErr);
  const overlayDups = duplicateTopLevelKeys(overlayText);
  assert(overlayDups.length === 0, 'deploy/k8s-journeys/kustomization.yaml has no duplicate top-level keys', overlayDups);
  docs['../k8s-journeys/kustomization.yaml'] = overlayParsed;
}

// The store (STORE_PLAN §3): the base's own RWO claim, holding the database
// and the workspace as two subPaths of the volume named `store`. The name is
// NOT `workspace`: the journeys patch strategic-merges volumes by name, and a
// shared name would re-point the database's mount at the workspace claim.
const STORE_PVC = 'observabilitypack-studio-store';
const STORE_VOLUME = 'store';
const STORE_DB = '/data/db/observogram.db';
const STORE_WORKSPACE = '/data/workspace';

// The mount (and the volume behind it) that holds `path`, or null.
function mountOf(podSpec, container, path) {
  const m = (container.volumeMounts || []).filter(v => path === v.mountPath || path.startsWith(v.mountPath.replace(/\/$/, '') + '/'))
    .sort((a, b) => b.mountPath.length - a.mountPath.length)[0];
  if (!m) return null;
  return { mount: m, volume: (podSpec.volumes || []).find(v => v.name === m.name) || null };
}
const envMap = c => Object.fromEntries((c.env || []).map(e => [e.name, e]));

// --- the base: four resources, the studio on its own store volume ---
{
  const base = docs['kustomization.yaml'];
  assert(base.kind === 'Kustomization' && base.resources.join() === 'pvc-store.yaml,deployment-studio.yaml,service.yaml,ingress.yaml' && !('components' in base) && base.namespace === 'observability' && base.images[0].name === 'observogram',
         'the base kustomization lists its four resources (the store PVC first) and no component', base);
  const store = docs['pvc-store.yaml'] || { metadata: {}, spec: { resources: { requests: {} }, accessModes: [] } };
  assert(store.kind === 'PersistentVolumeClaim' && store.metadata.name === STORE_PVC && store.metadata.name !== K8S_WORKSPACE_PVC && !store.metadata.namespace && typeof store.spec.resources.requests.storage === 'string',
         'the store PVC is its own claim (not the journeys workspace claim), namespace-less like every base file, with a storage request', store);
  assert(store.spec.accessModes.join() === 'ReadWriteOnce', 'the store PVC is ReadWriteOnce — the database is never on an RWX (network) volume', store.spec.accessModes);
  let storeText = '';
  try { storeText = readFileSync(join(K8S, 'pvc-store.yaml'), 'utf8'); } catch { /* asserted below */ }
  assert(/^ {2}# storageClassName: <your class> {3}# omit to use the cluster default$/m.test(storeText) && !('storageClassName' in store.spec),
         'the store PVC carries the same commented storageClassName stanza as pvc-workspace.yaml (the cluster default applies)');
  assert(/WaitForFirstConsumer/.test(storeText) && /volumeBindingMode/.test(storeText) && /zone/i.test(storeText),
         'the store PVC file says how two RWO claims share a zone (WaitForFirstConsumer or a zone-pinned class) and how to check volumeBindingMode');

  const dep = docs['deployment-studio.yaml'];
  const pod = dep.spec.template.spec;
  const c = pod.containers[0];
  assert(dep.kind === 'Deployment' && dep.metadata.name === 'observabilitypack-studio' && c.name === 'studio' && dep.spec.replicas === 1,
         'the base studio Deployment is one replica of the studio container', { replicas: dep.spec.replicas });
  assert(c.env.map(e => e.name).join() === 'HOST,PORT,OBSERVOGRAM_DB,OBSERVOGRAM_WORKSPACE',
         'the base studio env is exactly HOST, PORT, OBSERVOGRAM_DB, OBSERVOGRAM_WORKSPACE', c.env.map(e => e.name));
  const env = envMap(c);
  assert(env.OBSERVOGRAM_DB?.value === STORE_DB && env.OBSERVOGRAM_WORKSPACE?.value === STORE_WORKSPACE,
         `OBSERVOGRAM_DB is ${STORE_DB} and OBSERVOGRAM_WORKSPACE is ${STORE_WORKSPACE}`, { db: env.OBSERVOGRAM_DB, ws: env.OBSERVOGRAM_WORKSPACE });
  assert(JSON.stringify(c.volumeMounts) === JSON.stringify([
    { name: STORE_VOLUME, mountPath: '/data/db', subPath: 'db' },
    { name: STORE_VOLUME, mountPath: STORE_WORKSPACE, subPath: 'workspace' },
  ]), 'the studio mounts exactly the store volume, twice: subPath db at /data/db, subPath workspace at /data/workspace', c.volumeMounts);
  assert(JSON.stringify(pod.volumes) === JSON.stringify([{ name: STORE_VOLUME, persistentVolumeClaim: { claimName: STORE_PVC } }]),
         'the pod has exactly one volume, `store`, on the store PVC', pod.volumes);
  const dbAt = env.OBSERVOGRAM_DB && mountOf(pod, c, env.OBSERVOGRAM_DB.value);
  const wsAt = env.OBSERVOGRAM_WORKSPACE && mountOf(pod, c, env.OBSERVOGRAM_WORKSPACE.value);
  assert(dbAt?.mount.subPath === 'db' && dbAt.volume?.persistentVolumeClaim?.claimName === STORE_PVC && posix.dirname(env.OBSERVOGRAM_DB.value) === dbAt.mount.mountPath,
         'OBSERVOGRAM_DB resolves inside the store volume\'s db subPath', dbAt);
  assert(wsAt?.mount.subPath === 'workspace' && wsAt.volume?.persistentVolumeClaim?.claimName === STORE_PVC && !env.OBSERVOGRAM_DB?.value.startsWith(env.OBSERVOGRAM_WORKSPACE?.value + '/'),
         'OBSERVOGRAM_WORKSPACE resolves to the store volume\'s workspace subPath, and the database is not inside the workspace', wsAt);
  assert(pod.securityContext.runAsNonRoot === true && pod.securityContext.runAsUser === 1000 && pod.securityContext.runAsGroup === 1000 && pod.securityContext.fsGroup === 1000 && pod.securityContext.fsGroupChangePolicy === 'OnRootMismatch',
         'the base pod runs as uid/gid 1000 with fsGroup 1000 (OnRootMismatch): a fresh PVC is root:root 0755', pod.securityContext);
  assert(dep.spec.strategy?.type === 'Recreate' && !('rollingUpdate' in dep.spec.strategy),
         'the base Deployment uses strategy Recreate — never two studio processes on one database', dep.spec.strategy);
  assert(/opt-in `components\/journeys`/.test(readFileSync(join(K8S, 'deployment-studio.yaml'), 'utf8')), 'the studio Deployment header points at the opt-in component');
}

// --- the component ---
const comp = docs['components/journeys/kustomization.yaml'];
const pvc = docs['components/journeys/pvc-workspace.yaml'];
const cron = docs['components/journeys/cronjob-journeys.yaml'];
const patch = docs['components/journeys/patch-studio-workspace.yaml'];
const overlay = docs['../k8s-journeys/kustomization.yaml'];
{
  assert(comp.apiVersion === 'kustomize.config.k8s.io/v1alpha1' && comp.kind === 'Component' && comp.resources.join() === 'pvc-workspace.yaml,cronjob-journeys.yaml' && comp.patches[0].path === 'patch-studio-workspace.yaml' && comp.patches[0].target.kind === 'Deployment' && comp.patches[0].target.name === 'observabilitypack-studio',
         'the component is a kustomize Component with the PVC, the CronJob and the studio patch', comp);
  assert(overlay.kind === 'Kustomization' && overlay.resources.join() === '../k8s' && overlay.components.join() === '../k8s/components/journeys', 'the sibling overlay is base + component', overlay);
  // Fix round 0: the base's namespace/labels transformers apply to the base's
  // own resources only. Without its own `namespace:` the overlay rendered the
  // PVC and the CronJob namespace-less (→ the kubeconfig's current namespace)
  // while the patched studio Deployment in `observability` claimed a PVC that
  // did not exist there (pod Pending on an unbound claim).
  const base = docs['kustomization.yaml'];
  assert(overlay.namespace === base.namespace && overlay.namespace === 'observability',
         'the overlay repeats the base namespace so the component\'s PVC and CronJob land beside the studio Deployment', { overlay: overlay.namespace, base: base.namespace });
  assert(JSON.stringify(overlay.labels) === JSON.stringify(base.labels) && overlay.labels[0].pairs['app.kubernetes.io/part-of'] === 'observabilitypack-studio',
         'the overlay repeats the base part-of label pair for the component\'s resources', { overlay: overlay.labels, base: base.labels });
  assert(!pvc.metadata.namespace && !cron.metadata.namespace,
         'the component files themselves stay namespace-less (the overlay transformer sets it — one place)');
  assert(pvc.kind === 'PersistentVolumeClaim' && pvc.metadata.name === K8S_WORKSPACE_PVC && pvc.spec.accessModes.join() === 'ReadWriteOnce' && pvc.spec.resources.requests.storage === '1Gi', 'the PVC is named as the snippets emitter expects, RWO, 1Gi placeholder', pvc);
  assert(/1Gi is a placeholder, not a measurement/.test(readFileSync(join(K8S, 'components/journeys/pvc-workspace.yaml'), 'utf8')) && /journeys × OBSERVOGRAM_JOURNEY_RUN_RETENTION/.test(readFileSync(join(K8S, 'components/journeys/pvc-workspace.yaml'), 'utf8')),
         'the PVC file states the sizing formula and that 1Gi is a placeholder');
  // CronJob invariants
  const js = cron.spec.jobTemplate.spec;
  const pod = js.template.spec;
  const c = pod.containers[0];
  assert(cron.kind === 'CronJob' && cron.apiVersion === 'batch/v1' && cron.metadata.name === 'observabilitypack-studio-journeys' && cron.metadata.labels['app.kubernetes.io/name'] === 'observabilitypack-studio' && cron.metadata.labels['app.kubernetes.io/component'] === 'journeys',
         'the CronJob is named and labelled with the studio', cron.metadata);
  assert(cron.spec.schedule === '*/15 * * * *' && cron.spec.concurrencyPolicy === 'Forbid' && cron.spec.startingDeadlineSeconds === 300 && cron.spec.successfulJobsHistoryLimit === 3 && cron.spec.failedJobsHistoryLimit === 3,
         'the fleet cadence is */15 with concurrencyPolicy Forbid and bounded history', cron.spec);
  assert(js.backoffLimit === 0 && js.activeDeadlineSeconds === 900 && pod.restartPolicy === 'Never', 'backoffLimit 0, activeDeadlineSeconds 900, restartPolicy Never — a gate failure is not retried', { b: js.backoffLimit, a: js.activeDeadlineSeconds, r: pod.restartPolicy });
  assert(JSON.stringify(c.command) === JSON.stringify(['node', 'tools/cli.mjs', 'journey', 'run', '--all']) && c.workingDir === '/app', 'the command is node tools/cli.mjs journey run --all in /app (packc is not on PATH)', c.command);
  assert(/^observogram:/.test(c.image) && c.image === docs['deployment-studio.yaml'].spec.template.spec.containers[0].image, 'the CronJob uses the studio image (same name:tag as the studio Deployment file)', c.image);
  // Fix round 1: the base's `images:` retag is a transformer of the base kustomization and
  // does not reach the component's CronJob; the overlay repeats it (same class as namespace/labels).
  assert(JSON.stringify(overlay.images) === JSON.stringify(base.images) && overlay.images[0].name === 'observogram',
         'the overlay repeats the base images retag so the CronJob follows the same tag as the studio', { overlay: overlay.images, base: base.images });
  assert(pod.securityContext.runAsNonRoot === true && pod.securityContext.runAsUser === 1000 && pod.securityContext.runAsGroup === 1000 && c.securityContext.allowPrivilegeEscalation === false && c.securityContext.capabilities.drop.join() === 'ALL',
         'the same securityContext as the studio');
  // Fix round 0: a freshly provisioned PVC is root:root 0755 with most
  // provisioners; without fsGroup neither uid-1000 process can write it.
  assert(pod.securityContext.fsGroup === 1000 && pod.securityContext.fsGroupChangePolicy === 'OnRootMismatch',
         'the CronJob pod sets fsGroup 1000 (OnRootMismatch) so uid 1000 can write a fresh workspace volume', pod.securityContext);
  const patchPodSc = patch.spec.template.spec.securityContext;
  assert(patchPodSc && patchPodSc.fsGroup === 1000 && patchPodSc.fsGroupChangePolicy === 'OnRootMismatch' && Object.keys(patchPodSc).join() === 'fsGroup,fsGroupChangePolicy',
         'the studio patch adds the same fsGroup to the studio pod and nothing else of the securityContext (runAsUser/Group stay the base ones)', patchPodSc);
  const baseSc = docs['deployment-studio.yaml'].spec.template.spec.securityContext;
  assert(baseSc.fsGroup === patchPodSc?.fsGroup && baseSc.fsGroupChangePolicy === patchPodSc?.fsGroupChangePolicy,
         'the patch\'s fsGroup equals the base\'s (the base now needs it for the store volume)', { base: baseSc, patch: patchPodSc });
  const cronEnv = Object.fromEntries(c.env.map(e => [e.name, e]));
  const patchC = patch.spec.template.spec.containers[0];
  const patchEnv = Object.fromEntries(patchC.env.map(e => [e.name, e]));
  assert(cronEnv.OBSERVOGRAM_WORKSPACE?.value === K8S_WORKSPACE_MOUNT && patchEnv.OBSERVOGRAM_WORKSPACE?.value === K8S_WORKSPACE_MOUNT, 'OBSERVOGRAM_WORKSPACE is /workspace on BOTH the CronJob and the studio patch', { cron: cronEnv.OBSERVOGRAM_WORKSPACE, studio: patchEnv.OBSERVOGRAM_WORKSPACE });
  assert(c.volumeMounts[0].mountPath === K8S_WORKSPACE_MOUNT && patchC.volumeMounts[0].mountPath === K8S_WORKSPACE_MOUNT && c.volumeMounts[0].name === pod.volumes[0].name && patchC.volumeMounts[0].name === patch.spec.template.spec.volumes[0].name,
         'both mount the workspace volume at /workspace');
  assert(pod.volumes[0].persistentVolumeClaim.claimName === pvc.metadata.name && patch.spec.template.spec.volumes[0].persistentVolumeClaim.claimName === pvc.metadata.name,
         'the claimName in the CronJob and in the studio patch is the PVC\'s name', { cron: pod.volumes[0].persistentVolumeClaim.claimName, studio: patch.spec.template.spec.volumes[0].persistentVolumeClaim.claimName, pvc: pvc.metadata.name });
  assert(patch.kind === 'Deployment' && patch.metadata.name === 'observabilitypack-studio' && patchC.name === 'studio', 'the patch targets the studio container by name (strategic merge)');
  const cronText = readFileSync(join(K8S, 'components/journeys/cronjob-journeys.yaml'), 'utf8');
  const prose = t => t.replace(/\n[ \t]*#[ \t]*/g, ' '); // comment lines joined, wraps ignored
  assert(/# - name: OBSERVOGRAM_JOURNEY_RUN_RETENTION/.test(cronText) && /# - name: OBSERVOGRAM_MCP_TIMEOUT_MS/.test(cronText) && /secretKeyRef: \{ name: journey-secrets, key: MY_JOURNEY_WEBHOOK_URL \}/.test(cronText) && /one CronJob per org/.test(prose(cronText)) && /\/workspace\/<orgs\.root>/.test(cronText),
         'the CronJob documents the retention / timeout knobs, the secretKeyRef binding for the env names and the per-org root — all commented');
  assert(/exit 1 \(gate failed\) is the\n# early-warning OUTCOME/.test(cronText) && /kubectl get jobs/.test(cronText), 'the CronJob states why a gate failure is a failed Job, not a retry');
  // STORE_PLAN §3: an RWX class is typically NFS/CephFS, where the database
  // refuses to open — RWX is advice only while OBSERVOGRAM_DB is on the store.
  const pvcText = readFileSync(join(K8S, 'components/journeys/pvc-workspace.yaml'), 'utf8');
  const rwxOnlyWhileDbOnStore = /ReadWriteMany.*only while.{0,40}OBSERVOGRAM_DB.{0,40}RWO store volume/i;
  assert(rwxOnlyWhileDbOnStore.test(prose(pvcText)) && /pvc-store\.yaml/.test(pvcText),
         'pvc-workspace.yaml allows ReadWriteMany only while OBSERVOGRAM_DB points at the RWO store volume');
  assert(rwxOnlyWhileDbOnStore.test(prose(cronText)) && /^ {10}# affinity:\n {10}# {3}podAffinity:$/m.test(cronText) && !('affinity' in pod),
         'cronjob-journeys.yaml keeps the podAffinity commented and ties dropping it (RWX) to OBSERVOGRAM_DB on the RWO store volume');
}

// --- the rendered overlay: the store survives the journeys patch ---
// CI has no kustomize, so this models the strategic merge `kubectl kustomize
// deploy/k8s-journeys` applies for the fields the patch uses: maps merge
// recursively; lists merge on their Kubernetes patchMergeKey (containers, env,
// volumes by name; volumeMounts by mountPath); any other list is replaced.
const MERGE_KEYS = { containers: 'name', env: 'name', volumes: 'name', volumeMounts: 'mountPath' };
function smp(base, patch, key) {
  if (Array.isArray(patch)) {
    const k = MERGE_KEYS[key];
    if (!k || !Array.isArray(base)) return structuredClone(patch);
    const out = structuredClone(base);
    for (const p of patch) {
      const i = out.findIndex(b => b && b[k] === p[k]);
      if (i < 0) out.push(structuredClone(p)); else out[i] = smp(out[i], p);
    }
    return out;
  }
  if (patch && typeof patch === 'object') {
    const out = base && typeof base === 'object' && !Array.isArray(base) ? structuredClone(base) : {};
    for (const [k, v] of Object.entries(patch)) out[k] = smp(out[k], v, k);
    return out;
  }
  return patch;
}
{
  const rendered = smp(docs['deployment-studio.yaml'], patch);
  const pod = rendered.spec.template.spec;
  const c = pod.containers.find(x => x.name === 'studio');
  const env = envMap(c);
  const patchC = patch.spec.template.spec.containers[0];
  assert(!patchC.env.some(e => e.name === 'OBSERVOGRAM_DB') && !('strategy' in patch.spec) && !('replicas' in patch.spec),
         'the journeys patch never names OBSERVOGRAM_DB, the strategy or the replicas');
  assert(!patch.spec.template.spec.volumes.some(v => v.name === STORE_VOLUME) && !patchC.volumeMounts.some(m => m.name === STORE_VOLUME),
         'the journeys patch never names the store volume (volumes merge by name)', patch.spec.template.spec.volumes);
  assert(env.OBSERVOGRAM_WORKSPACE?.value === K8S_WORKSPACE_MOUNT && env.OBSERVOGRAM_DB?.value === STORE_DB,
         `rendered overlay: OBSERVOGRAM_WORKSPACE moves to ${K8S_WORKSPACE_MOUNT}, OBSERVOGRAM_DB stays ${STORE_DB}`, { ws: env.OBSERVOGRAM_WORKSPACE, db: env.OBSERVOGRAM_DB });
  const dbAt = env.OBSERVOGRAM_DB && mountOf(pod, c, env.OBSERVOGRAM_DB.value);
  const wsAt = env.OBSERVOGRAM_WORKSPACE && mountOf(pod, c, env.OBSERVOGRAM_WORKSPACE.value);
  assert(dbAt?.volume?.name === STORE_VOLUME && dbAt.mount.subPath === 'db' && dbAt.volume.persistentVolumeClaim?.claimName === STORE_PVC && docs['pvc-store.yaml']?.spec.accessModes.join() === 'ReadWriteOnce',
         'rendered overlay: OBSERVOGRAM_DB still resolves inside the RWO store volume — never onto the (possibly RWX) workspace claim', dbAt);
  assert(wsAt?.volume?.persistentVolumeClaim?.claimName === K8S_WORKSPACE_PVC,
         'rendered overlay: OBSERVOGRAM_WORKSPACE resolves onto the journeys workspace claim', wsAt);
  assert(rendered.spec.strategy?.type === 'Recreate' && rendered.spec.replicas === 1,
         'rendered overlay: still strategy Recreate and one replica', { strategy: rendered.spec.strategy, replicas: rendered.spec.replicas });
  assert(pod.securityContext.fsGroup === 1000 && pod.securityContext.fsGroupChangePolicy === 'OnRootMismatch' && pod.securityContext.runAsUser === 1000,
         'rendered overlay: the pod keeps runAsUser 1000 and fsGroup 1000 (OnRootMismatch)', pod.securityContext);
  const cronPod = cron.spec.jobTemplate.spec.template.spec;
  const cronC = cronPod.containers[0];
  assert(!cronPod.volumes.some(v => v.name === STORE_VOLUME || v.persistentVolumeClaim?.claimName === STORE_PVC) && !('OBSERVOGRAM_DB' in envMap(cronC)),
         'the journeys CronJob never mounts the store claim and sets no OBSERVOGRAM_DB (the journey runner opens no database)', cronPod.volumes);
}

// --- the README's one-off store pods run where the studio runs ---
// `store restore` reads the workspace's .store-imported marker to warn about
// a backup of another store, and `store export` writes into the workspace:
// each pod must see the studio's database AND workspace at the studio's paths.
{
  const readme = readFileSync(join(K8S, 'README.md'), 'utf8');
  const pods = [...readme.matchAll(/<<EOF\n([\s\S]*?)\nEOF\n/g)]
    .map(m => parseYaml(m[1].replaceAll(/\$[A-Z_]+/g, 'x')))
    .filter(d => d?.kind === 'Pod' && /^observogram-store-/.test(d.metadata?.name));
  assert(pods.map(d => d.metadata.name).join() === 'observogram-store-restore,observogram-store-export',
         'deploy/k8s/README.md carries the restore and the export one-off pods', pods.map(d => d.metadata?.name));
  for (const d of pods) {
    const c = d.spec.containers[0];
    const env = envMap(c);
    const wsAt = env.OBSERVOGRAM_WORKSPACE && mountOf(d.spec, c, env.OBSERVOGRAM_WORKSPACE.value);
    const dbAt = env.OBSERVOGRAM_DB && mountOf(d.spec, c, env.OBSERVOGRAM_DB.value);
    assert(env.OBSERVOGRAM_DB?.value === STORE_DB && dbAt?.mount.subPath === 'db' && dbAt.volume?.persistentVolumeClaim?.claimName === STORE_PVC,
           `README ${d.metadata.name}: OBSERVOGRAM_DB is the studio's ${STORE_DB} on the store claim's db subPath`, { env: c.env, mounts: c.volumeMounts });
    assert(env.OBSERVOGRAM_WORKSPACE?.value === STORE_WORKSPACE && wsAt?.mount.subPath === 'workspace' && wsAt.volume?.persistentVolumeClaim?.claimName === STORE_PVC,
           `README ${d.metadata.name}: OBSERVOGRAM_WORKSPACE is the studio's ${STORE_WORKSPACE} on the store claim's workspace subPath (the restore's marker warning reads it)`, { env: c.env, mounts: c.volumeMounts });
  }
}

// --- the README's rollback names two distinct images ---
// The pre-store release is the git tag v0.4.0 and this build is still 0.4.0
// in package.json, so an image tagged with the package version may be either
// build: the store image comes from the Deployment, the old one has a tag of
// its own, or `kubectl set image … studio=$OLD_IMAGE` changes nothing.
{
  const readme = readFileSync(join(K8S, 'README.md'), 'utf8');
  const version = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')).version;
  const store = readme.match(/^STORE_IMAGE=(.*)$/m)?.[1] ?? '';
  const old = (readme.match(/^OLD_IMAGE=(\S*)/m)?.[1] ?? '').trim();
  const tagOf = ref => ref.slice(ref.lastIndexOf('/') + 1).split(':')[1] ?? '';
  assert(/^\$\(kubectl .*get deployment\/observabilitypack-studio/.test(store),
         'README rollback: STORE_IMAGE is read from the studio Deployment, not retyped', store);
  assert(old !== '' && tagOf(old) !== version && tagOf(old) !== `v${version}` && !/[<>]/.test(tagOf(old)),
         `README rollback: OLD_IMAGE has a tag of its own, never the package version ${version} the store build also carries`, old);
}

// --- secrets discipline across every manifest: no literal value on a secret-shaped env var ---
function envs(node, out = []) {
  if (Array.isArray(node)) { for (const x of node) envs(x, out); return out; }
  if (node && typeof node === 'object') {
    if (Array.isArray(node.env)) out.push(...node.env.filter(e => e && typeof e === 'object'));
    for (const v of Object.values(node)) envs(v, out);
  }
  return out;
}
for (const [rel, doc] of Object.entries(docs)) {
  const bad = envs(doc).filter(e => /(TOKEN|URL|PASSWORD|SECRET|KEY)$/i.test(String(e.name)) && 'value' in e);
  assert(bad.length === 0, `${rel}: no env var named *TOKEN/*URL/*PASSWORD/*SECRET/*KEY carries a literal value (secretKeyRef only)`, bad);
}

// --- the CLI's per-journey CronJob agrees with the component ---
{
  const one = parseYaml(k8sCronJobManifest({ name: 'repo-vs-live', cron: '*/15 * * * *', envNames: ['MY_HOOK_URL'], image: cron.spec.jobTemplate.spec.template.spec.containers[0].image, namespace: 'observability' }));
  const c1 = one.spec.jobTemplate.spec.template.spec.containers[0];
  assert(one.spec.jobTemplate.spec.template.spec.volumes[0].persistentVolumeClaim.claimName === pvc.metadata.name && c1.volumeMounts[0].mountPath === K8S_WORKSPACE_MOUNT && c1.env.find(e => e.name === 'OBSERVOGRAM_WORKSPACE').value === K8S_WORKSPACE_MOUNT,
         'packc journey schedule --format k8s mounts the same PVC at the same workspace path as the component');
  assert(one.spec.concurrencyPolicy === cron.spec.concurrencyPolicy && one.spec.jobTemplate.spec.backoffLimit === cron.spec.jobTemplate.spec.backoffLimit && one.spec.jobTemplate.spec.template.spec.restartPolicy === cron.spec.jobTemplate.spec.template.spec.restartPolicy && c1.image === cron.spec.jobTemplate.spec.template.spec.containers[0].image,
         'and carries the same non-retry contract and image');
  const compPodSc = cron.spec.jobTemplate.spec.template.spec.securityContext;
  assert(one.spec.jobTemplate.spec.template.spec.securityContext.fsGroup === compPodSc.fsGroup && one.spec.jobTemplate.spec.template.spec.securityContext.fsGroupChangePolicy === compPodSc.fsGroupChangePolicy,
         'and the same fsGroup as the component CronJob');
  assert(envs(one).filter(e => /(TOKEN|URL)$/.test(e.name) && 'value' in e).length === 0, 'and binds env names by secretKeyRef only');
  assert(!one.spec.jobTemplate.spec.template.spec.volumes.some(v => v.persistentVolumeClaim?.claimName === STORE_PVC) && !c1.env.some(e => e.name === 'OBSERVOGRAM_DB'),
         'and never mounts the store claim nor sets OBSERVOGRAM_DB');
}

report('deploy-manifests', 'all deploy-manifest assertions pass.');
