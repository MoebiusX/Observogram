#!/usr/bin/env node
/**
 * tools/test-deploy-manifests.mjs
 *
 * Structural test for deploy/k8s (step 5): every YAML under it parses with
 * mini-yaml; the base stays what it was (three resources, no component, the
 * studio container without a workspace mount); the opt-in journeys component
 * wires ONE PVC into BOTH the CronJob and the studio at the SAME
 * OBSERVOGRAM_WORKSPACE; the CronJob carries the non-retry contract; no
 * secret-shaped env var carries a literal value anywhere; and the CLI's
 * per-journey CronJob (schedule-snippets.mjs) agrees with the component on
 * the PVC name and the mount. CI runs no kustomize/kubeconform — this is the
 * gate; `kubectl kustomize deploy/k8s-journeys` (the sibling overlay —
 * kustomize refuses one nested under the base it references) is run by hand.
 * Exit 0 = pass.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
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
const docs = {};
for (const f of files) {
  const rel = relative(K8S, f).replaceAll('\\', '/');
  let parsed = null, err = null;
  try { parsed = parseYaml(readFileSync(f, 'utf8')); } catch (e) { err = e.message; }
  assert(parsed && typeof parsed === 'object' && !err, `${rel} parses with mini-yaml`, err);
  docs[rel] = parsed;
}
assert(Object.keys(docs).join() === 'components/journeys/cronjob-journeys.yaml,components/journeys/kustomization.yaml,components/journeys/patch-studio-workspace.yaml,components/journeys/pvc-workspace.yaml,deployment-studio.yaml,ingress.yaml,kustomization.yaml,service.yaml',
       'deploy/k8s holds the base and the journeys component — nothing else (the overlay is the sibling deploy/k8s-journeys)', Object.keys(docs));
// The sibling overlay (kustomize refuses an overlay nested under the base it references).
const OVERLAY = join(K8S, '..', 'k8s-journeys', 'kustomization.yaml');
{
  let overlayParsed = null, overlayErr = null;
  try { overlayParsed = parseYaml(readFileSync(OVERLAY, 'utf8')); } catch (e) { overlayErr = e.message; }
  assert(overlayParsed && !overlayErr, 'deploy/k8s-journeys/kustomization.yaml parses with mini-yaml', overlayErr);
  docs['../k8s-journeys/kustomization.yaml'] = overlayParsed;
}

// --- the base is untouched (semantically) ---
{
  const base = docs['kustomization.yaml'];
  assert(base.kind === 'Kustomization' && base.resources.join() === 'deployment-studio.yaml,service.yaml,ingress.yaml' && !('components' in base) && base.namespace === 'observability' && base.images[0].name === 'observogram',
         'the base kustomization lists its three resources and no component', base);
  const dep = docs['deployment-studio.yaml'];
  const c = dep.spec.template.spec.containers[0];
  assert(dep.kind === 'Deployment' && dep.metadata.name === 'observabilitypack-studio' && c.name === 'studio' && c.env.map(e => e.name).join() === 'HOST,PORT' && !('volumeMounts' in c) && !('volumes' in dep.spec.template.spec),
         'the base studio Deployment carries no workspace env, mount or volume (the component adds them)', { env: c.env.map(e => e.name), vm: c.volumeMounts, v: dep.spec.template.spec.volumes });
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
  assert(/^observogram:/.test(c.image) && c.image === docs['deployment-studio.yaml'].spec.template.spec.containers[0].image, 'the CronJob uses the studio image (same name:tag, so the base retag applies)', c.image);
  assert(pod.securityContext.runAsNonRoot === true && pod.securityContext.runAsUser === 1000 && pod.securityContext.runAsGroup === 1000 && c.securityContext.allowPrivilegeEscalation === false && c.securityContext.capabilities.drop.join() === 'ALL',
         'the same securityContext as the studio');
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
  assert(/# - name: OBSERVOGRAM_JOURNEY_RUN_RETENTION/.test(cronText) && /# - name: OBSERVOGRAM_MCP_TIMEOUT_MS/.test(cronText) && /secretKeyRef: \{ name: journey-secrets, key: MY_JOURNEY_WEBHOOK_URL \}/.test(cronText) && /orgs\.json/.test(cronText),
         'the CronJob documents the retention / timeout knobs, the secretKeyRef binding for the env names and the tenancy root — all commented');
  assert(/exit 1 \(gate failed\) is the\n# early-warning OUTCOME/.test(cronText) && /kubectl get jobs/.test(cronText), 'the CronJob states why a gate failure is a failed Job, not a retry');
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
  assert(envs(one).filter(e => /(TOKEN|URL)$/.test(e.name) && 'value' in e).length === 0, 'and binds env names by secretKeyRef only');
}

report('deploy-manifests', 'all deploy-manifest assertions pass.');
