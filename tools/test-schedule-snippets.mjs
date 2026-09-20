#!/usr/bin/env node
/**
 * tools/test-schedule-snippets.mjs
 *
 * Unit test for tools/lib/schedule-snippets.mjs — the delegated-scheduling
 * emitters (step 5): cron line, schtasks command, GitHub Actions workflow
 * and Kubernetes CronJob from a parsed journey schedule. Covers the exact
 * shape translations, the honesty rules (placeholder marked, `every: 45m`
 * as a comment, irregular cron → "translate by hand"), the env-name-only
 * secrets discipline, the k8s manifest parsed back with mini-yaml, and the
 * Windows backslashes character by character. Exit 0 = pass.
 */

import { readFileSync } from 'node:fs';
import { createHarness } from './lib/harness.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { parseSchedule } from './lib/schedule.mjs';
import {
  PLACEHOLDER_CRON, SNIPPET_FORMATS, K8S_WORKSPACE_PVC, K8S_WORKSPACE_MOUNT,
  normaliseSnippetInput, describeCadence, cronLine, schtasksSchedule, schtasksCommand, githubActionsWorkflow, k8sCronJobManifest, k8sName, scheduleSnippets,
} from './lib/schedule-snippets.mjs';

const { assert, report } = createHarness();

// --- vendoring guard: zero-import, no Node APIs, no environment ---
const src = readFileSync(new URL('./lib/schedule-snippets.mjs', import.meta.url), 'utf8');
assert(!/^\s*import\s/m.test(src), 'schedule-snippets.mjs is zero-import (browser-safe)');
assert(!/from\s+'node:/.test(src) && !/process\.env/.test(src) && !/\bprocess\./.test(src), 'schedule-snippets.mjs reads no node: module and no environment');
// The transport trap: a doubled backslash in the source must have survived
// as two characters, or the emitted task name loses its separator.
assert(src.includes('/TN "Observogram\\\\${n.name}"') && src.includes('/TR "\\\\"${toWin(n.nodePath)}\\\\" \\\\"${toWin(n.cliPath)}\\\\" journey run ${n.name}"'),
       'the source carries the doubled backslashes for the task name and the escaped quotes (read back after writing)');

assert(PLACEHOLDER_CRON === '*/15 * * * *' && SNIPPET_FORMATS.join() === 'cron,schtasks,actions,k8s' && K8S_WORKSPACE_PVC === 'observabilitypack-studio-workspace' && K8S_WORKSPACE_MOUNT === '/workspace',
       'placeholder, formats, PVC name and mount are pinned');

// Node-only inputs a CLI would supply — with a secret-looking env value set
// in THIS process to prove nothing reads it.
process.env.MY_HOOK_URL = 'https://hooks.example/s3cr3tT0k3n1234567890abcdef';
process.env.MY_HOOK_TOKEN = 'Bearer-lookalike-9f8e7d6c5b4a3210';
const base = {
  name: 'repo-vs-live', envNames: ['MY_MCP_TOKEN', 'MY_HOOK_URL', 'MY_HOOK_TOKEN', 'MY_HOOK_URL', 'not a name'],
  nodePath: 'C:/node/node.exe', cliPath: 'C:/repo/tools/cli.mjs', cwd: 'C:/repo', workspace: 'C:/repo/.observogram',
  image: 'observogram:0.4.0', namespace: 'observability', retention: '500', source: 'C:/repo/.observogram/journeys/repo-vs-live.journey.yaml',
};
const withSched = (value) => { const p = parseSchedule(value); return { ...base, cron: p.cron, timezone: p.timezone, every: p.every, cadenceNote: p.cadenceNote, placeholder: false }; };
const noSecret = (s) => !/=https?:|Bearer |s3cr3t|9f8e7d6c|\b(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{24,}\b/.test(s);

// --- normalisation ---
{
  const n = normaliseSnippetInput(base);
  assert(n.envNames.join() === 'MY_MCP_TOKEN,MY_HOOK_URL,MY_HOOK_TOKEN' && n.placeholder === true && n.cron === PLACEHOLDER_CRON, 'env names are de-duplicated and validated; no cron/every → placeholder');
  assert(normaliseSnippetInput({}).name === 'journey' && normaliseSnippetInput({}).nodePath === 'node' && normaliseSnippetInput({}).workspace === '.observogram' && normaliseSnippetInput({}).image === 'observogram:latest', 'defaults fill an empty input');
  assert(describeCadence(withSched('*/15 * * * *')) === 'cron */15 * * * *' && describeCadence(withSched({ every: '15m' })) === 'every 15m · cron */15 * * * *' && describeCadence(withSched({ cron: '0 4 * * *', timezone: 'Europe/Madrid' })) === 'cron 0 4 * * * · timezone Europe/Madrid' && describeCadence(base) === 'placeholder */15 * * * *',
         'describeCadence words the schedule');
  assert(Object.keys(scheduleSnippets(base)).join() === 'cron,schtasks,actions,k8s', 'scheduleSnippets returns the four forms');
}

// --- the shapes: 15-minute, hourly, daily, weekly, irregular, every 45m ---
const S15 = withSched('*/15 * * * *');
const S2H = withSched({ cron: '0 */2 * * *', timezone: 'Europe/Madrid' });
const SD = withSched('30 4 * * *');
const SW = withSched('0 9 * * 1');
const SIRR = withSched('0,30 * * * *');
const S45 = withSched({ every: '45m' });

// cron
{
  const c = cronLine(S15);
  assert(c.startsWith('# Observogram journey "repo-vs-live" — cron */15 * * * *\n'), 'cron: header names the journey and the cadence', c.split('\n')[0]);
  assert(/^\*\/15 \* \* \* \* cd C:\/repo && OBSERVOGRAM_WORKSPACE=C:\/repo\/\.observogram C:\/node\/node\.exe C:\/repo\/tools\/cli\.mjs journey run repo-vs-live >> C:\/repo\/\.observogram\/journey-repo-vs-live\.log 2>&1$/m.test(c),
         'cron: the line cds into the checkout, sets the workspace, runs the journey and appends to a per-journey log', c);
  assert(/^# export MY_MCP_TOKEN=<set in your environment>$/m.test(c) && /^# export MY_HOOK_URL=<set in your environment>$/m.test(c) && /^# export MY_HOOK_TOKEN=<set in your environment>$/m.test(c), 'cron: one export comment per env NAME, never a value');
  assert(!/CRON_TZ/.test(c) && /^CRON_TZ=Europe\/Madrid$/m.test(cronLine(S2H)), 'cron: CRON_TZ only when the journey declares a timezone');
  assert(/^0,30 \* \* \* \* cd /m.test(cronLine(SIRR)) && /irregular cron: cadence not derivable/.test(cronLine(SIRR)), 'cron: an irregular cron is passed through verbatim with the cadence note');
  const c45 = cronLine(S45);
  assert(/^# every 45m has no exact cron form — snippets print it as a comment$/m.test(c45) && /^# every 45m: cd C:\/repo && /m.test(c45) && !/^\*\//m.test(c45), 'cron: every 45m prints the command as a comment, never a fabricated cron', c45);
  assert(/'C:\/my repo'/.test(cronLine({ ...S15, cwd: 'C:/my repo' })), 'cron: a path with spaces is single-quoted');
  const ph = cronLine(base);
  assert(/^# schedule: not set in C:\/repo\/\.observogram\/journeys\/repo-vs-live\.journey\.yaml — placeholder, edit before installing$/m.test(ph) && /^\*\/15 \* \* \* \* cd /m.test(ph) && /placeholder \*\/15/.test(ph), 'cron: without a schedule the placeholder is marked in the header and the cadence description');
}

// schtasks
{
  assert(schtasksSchedule(S15) === '/SC MINUTE /MO 15' && schtasksSchedule(withSched('* * * * *')) === '/SC MINUTE /MO 1', '*/N * * * * → /SC MINUTE /MO N');
  assert(schtasksSchedule(S2H) === '/SC HOURLY /MO 2 /ST 00:00' && schtasksSchedule(withSched('30 */3 * * *')) === '/SC HOURLY /MO 3 /ST 00:30' && schtasksSchedule(withSched('15 * * * *')) === '/SC HOURLY /MO 1 /ST 00:15', 'M */N * * * → /SC HOURLY /MO N /ST 00:MM');
  assert(schtasksSchedule(SD) === '/SC DAILY /ST 04:30', 'M H * * * → /SC DAILY /ST HH:MM');
  assert(schtasksSchedule(SW) === '/SC WEEKLY /D MON /ST 09:00' && schtasksSchedule(withSched('0 9 * * fri')) === '/SC WEEKLY /D FRI /ST 09:00' && schtasksSchedule(withSched('0 0 * * 7')) === '/SC WEEKLY /D SUN /ST 00:00' && schtasksSchedule(withSched('0 0 * * 0')) === '/SC WEEKLY /D SUN /ST 00:00',
         'M H * * D → /SC WEEKLY /D <DAY> /ST HH:MM (numeric 0/7 and names)');
  assert(schtasksSchedule(SIRR) === null && schtasksSchedule(withSched('0 9 * * 1-5')) === null && schtasksSchedule(withSched('0 4 1 * *')) === null, 'lists, ranges and day-of-month constraints have no exact schtasks form');
  assert(schtasksSchedule(S45) === '/SC MINUTE /MO 45' && schtasksSchedule(withSched({ every: '5h' })) === '/SC HOURLY /MO 5' && schtasksSchedule(withSched({ every: '3d' })) === '/SC DAILY /MO 3 /ST 00:00', 'every: translates directly (schtasks has minute/hour/day modifiers)');
  const s = schtasksCommand(S15);
  const cmd = s.split('\n').find(l => l.startsWith('schtasks'));
  assert(cmd === 'schtasks /Create /TN "Observogram\\repo-vs-live" /TR "\\"C:\\node\\node.exe\\" \\"C:\\repo\\tools\\cli.mjs\\" journey run repo-vs-live" /SC MINUTE /MO 15 /F', 'schtasks: the command with the task folder, escaped quotes and Windows paths', cmd);
  const tn = cmd.indexOf('Observogram') + 'Observogram'.length;
  assert(cmd.charCodeAt(tn) === 92 && cmd.charCodeAt(tn + 1) !== 92 && cmd.slice(tn + 1, tn + 13) === 'repo-vs-live', 'schtasks: exactly ONE backslash (0x5C) separates Observogram from the task name');
  const tr = cmd.indexOf('/TR "') + 5;
  assert(cmd.charCodeAt(tr) === 92 && cmd.charCodeAt(tr + 1) === 34 && cmd.slice(tr + 2, tr + 18) === 'C:\\node\\node.exe' && cmd.charCodeAt(tr + 18) === 92 && cmd.charCodeAt(tr + 19) === 34, 'schtasks: the /TR value opens with backslash-quote and the node path uses single backslashes', cmd.slice(tr, tr + 22));
  assert(/^REM setx MY_HOOK_URL <set in your environment> {3}\(User environment; the task runs as the current user\)$/m.test(s) && /^REM setx OBSERVOGRAM_WORKSPACE "C:\\repo\\\.observogram"/m.test(s), 'schtasks: env names as REM setx lines, the workspace path literal');
  const irr = schtasksCommand(SIRR);
  assert(/^REM this cron \(0,30 \* \* \* \*\) has no exact schtasks equivalent — translate by hand$/m.test(irr) && / \/SC DAILY \/ST 00:00 \/F$/m.test(irr), 'schtasks: an irregular cron prints the DAILY form with the translate-by-hand REM', irr);
  assert(!/translate by hand/.test(schtasksCommand(S45)) && / \/SC MINUTE \/MO 45 \/F$/m.test(schtasksCommand(S45)), 'schtasks: every 45m needs no translation');
  assert(/^REM schtasks runs in the machine's local time; the journey declares timezone Europe\/Madrid/m.test(schtasksCommand(S2H)), 'schtasks: a timezone gets the local-time REM');
  assert(/placeholder, edit before installing/.test(schtasksCommand(base)) && / \/SC MINUTE \/MO 15 \/F$/m.test(schtasksCommand(base)), 'schtasks: the placeholder is marked');
}

// GitHub Actions
{
  const w = githubActionsWorkflow(S15);
  const y = parseYaml(w);
  assert(y.name === 'journey-repo-vs-live' && y.on.schedule[0].cron === '*/15 * * * *' && 'workflow_dispatch' in y.on && y.permissions.contents === 'read' && y.concurrency.group === 'journey-repo-vs-live' && y.concurrency['cancel-in-progress'] === false,
         'actions: name, schedule + dispatch, read-only permissions, per-journey concurrency without cancel', { name: y.name, on: y.on, c: y.concurrency });
  const steps = y.jobs.journey.steps;
  assert(steps[0].uses === 'actions/checkout@v7' && steps[1].uses === 'actions/setup-node@v7' && steps[2].run === 'npm ci' && steps[3].run === 'node tools/cli.mjs journey run repo-vs-live' && steps[3].env.OBSERVOGRAM_WORKSPACE === '.observogram',
         'actions: checkout, setup-node, npm ci, the journey run with the workspace env', steps.map(s => s.uses || s.run));
  assert(steps[3].env.MY_HOOK_URL === '${{ secrets.MY_HOOK_URL }}' && steps[3].env.MY_MCP_TOKEN === '${{ secrets.MY_MCP_TOKEN }}' && steps[3].env.MY_HOOK_TOKEN === '${{ secrets.MY_HOOK_TOKEN }}', 'actions: every env NAME binds to a repository secret of the same name');
  assert(steps[4].uses === 'actions/upload-artifact@v7' && steps[4].if === 'always()' && steps[4].with.path === '.observogram/runs/repo-vs-live/' && steps[4].with['include-hidden-files'] === true, 'actions: the run record is uploaded as an artifact even on a gate failure');
  assert(/history on a runner is\n# per job — the record is uploaded as an artifact; it is NOT shared with a studio workspace/i.test(w), 'actions: the header says runner history is per job, not a studio workspace');
  assert(/- cron: "0 \*\/2 \* \* \*" {3}# GitHub schedules run in UTC; the journey declares timezone Europe\/Madrid/.test(githubActionsWorkflow(S2H)), 'actions: a timezone is noted (GitHub schedules run in UTC)');
  const w45 = githubActionsWorkflow(S45);
  assert(/# schedule: every 45m has no exact cron form — set a cron by hand:/.test(w45) && !/^ {2}schedule:/m.test(w45) && parseYaml(w45).on.workflow_dispatch === null, 'actions: every 45m leaves the schedule block commented, dispatch stays');
  assert(/placeholder, edit before installing/.test(githubActionsWorkflow(base)) && parseYaml(githubActionsWorkflow(base)).on.schedule[0].cron === PLACEHOLDER_CRON, 'actions: the placeholder is marked');
}

// Kubernetes CronJob
{
  const m = k8sCronJobManifest(S2H);
  const y = parseYaml(m);
  assert(y.apiVersion === 'batch/v1' && y.kind === 'CronJob' && y.metadata.name === 'observabilitypack-studio-journey-repo-vs-live' && y.metadata.namespace === 'observability' && y.metadata.labels['app.kubernetes.io/component'] === 'journeys' && y.metadata.labels['observogram.io/journey'] === 'repo-vs-live',
         'k8s: a batch/v1 CronJob named after the journey with the studio labels', y.metadata);
  assert(y.spec.schedule === '0 */2 * * *' && y.spec.timeZone === 'Europe/Madrid' && y.spec.concurrencyPolicy === 'Forbid' && y.spec.startingDeadlineSeconds === 300 && y.spec.successfulJobsHistoryLimit === 3 && y.spec.failedJobsHistoryLimit === 3,
         'k8s: schedule, timeZone, Forbid, starting deadline and history limits', y.spec);
  const js = y.spec.jobTemplate.spec;
  const pod = js.template.spec;
  const c = pod.containers[0];
  assert(js.backoffLimit === 0 && js.activeDeadlineSeconds === 900 && pod.restartPolicy === 'Never', 'k8s: backoffLimit 0, activeDeadlineSeconds 900, restartPolicy Never (a gate failure is not retried)');
  assert(pod.securityContext.runAsNonRoot === true && pod.securityContext.runAsUser === 1000 && c.securityContext.allowPrivilegeEscalation === false && c.securityContext.capabilities.drop.join() === 'ALL', 'k8s: the same securityContext as the studio');
  assert(pod.securityContext.fsGroup === 1000 && pod.securityContext.fsGroupChangePolicy === 'OnRootMismatch', 'k8s: fsGroup 1000 so uid 1000 can write a freshly provisioned workspace PVC');
  assert(c.image === 'observogram:0.4.0' && c.workingDir === '/app' && JSON.stringify(c.command) === JSON.stringify(['node', 'tools/cli.mjs', 'journey', 'run', 'repo-vs-live']), 'k8s: image observogram:<version>, workingDir /app, command node tools/cli.mjs journey run <name>', c.command);
  const env = Object.fromEntries(c.env.map(e => [e.name, e]));
  assert(env.OBSERVOGRAM_WORKSPACE.value === '/workspace' && env.OBSERVOGRAM_JOURNEY_RUN_RETENTION.value === '500', 'k8s: OBSERVOGRAM_WORKSPACE=/workspace and the retention knob when given');
  assert(['MY_MCP_TOKEN', 'MY_HOOK_URL', 'MY_HOOK_TOKEN'].every(n => env[n] && !('value' in env[n]) && env[n].valueFrom.secretKeyRef.name === 'journey-repo-vs-live-secrets' && env[n].valueFrom.secretKeyRef.key === n),
         'k8s: every env NAME is a secretKeyRef (journey-<name>-secrets / <NAME>), never a value', c.env);
  assert(c.volumeMounts[0].name === 'workspace' && c.volumeMounts[0].mountPath === '/workspace' && pod.volumes[0].persistentVolumeClaim.claimName === 'observabilitypack-studio-workspace', 'k8s: the workspace PVC is mounted at /workspace');
  assert(/# affinity:\n {10}# {3}podAffinity:/.test(m) && /ReadWriteOnce PVC the pod must land on the studio's node/.test(m), 'k8s: the RWO podAffinity is included, commented');
  assert(/PREREQUISITE: the studio Deployment and this CronJob mount the SAME PVC/.test(m) && /backoffLimit 0 \/ restartPolicy Never: exit 1 \(gate failed\) is the early-warning outcome/.test(m), 'k8s: the header states the shared-PVC prerequisite and why a gate failure is not retried');
  assert(!('timeZone' in parseYaml(k8sCronJobManifest(S15)).spec) && !k8sCronJobManifest(S15).includes('OBSERVOGRAM_JOURNEY_RUN_RETENTION') === false, 'k8s: no timeZone without a timezone');
  assert(!('OBSERVOGRAM_JOURNEY_RUN_RETENTION' in Object.fromEntries(parseYaml(k8sCronJobManifest({ ...S15, retention: null })).spec.jobTemplate.spec.template.spec.containers[0].env.map(e => [e.name, e]))), 'k8s: no retention env without the knob');
  assert(parseYaml(k8sCronJobManifest(S45)).spec.schedule === '<set by hand: every 45m has no exact cron form>' && parseYaml(k8sCronJobManifest(SIRR)).spec.schedule === '0,30 * * * *', 'k8s: every 45m is a set-by-hand marker, an irregular cron passes through');
  assert(parseYaml(k8sCronJobManifest(base)).spec.schedule === PLACEHOLDER_CRON && /placeholder, edit before installing/.test(k8sCronJobManifest(base)), 'k8s: the placeholder is marked');
  assert(k8sName('Repo VS Live!') === 'repo-vs-live' && k8sName('') === 'journey' && k8sName('x'.repeat(80)).length === 30 && parseYaml(k8sCronJobManifest({ ...S15, name: 'Repo VS Live!' })).metadata.name === 'observabilitypack-studio-journey-repo-vs-live' && parseYaml(k8sCronJobManifest({ ...S15, name: 'x'.repeat(80) })).metadata.name.length <= 63,
         'k8s: the journey name is sanitised to a DNS-1123 label and the CronJob name stays under 63 chars');
}

// --- secrets discipline across every form ---
for (const [label, input] of Object.entries({ S15, S2H, SD, SW, SIRR, S45, base })) {
  const all = scheduleSnippets(input);
  for (const f of SNIPPET_FORMATS) {
    assert(noSecret(all[f]), `${label}/${f}: no =http, no Bearer, no env VALUE and no token-looking string is ever emitted`, all[f].split('\n').filter(l => !noSecret(l)));
    assert(!/not a name/.test(all[f]), `${label}/${f}: an invalid env name is dropped`);
  }
}

delete process.env.MY_HOOK_URL;
delete process.env.MY_HOOK_TOKEN;
report('schedule-snippets', 'all schedule-snippets assertions pass.');
