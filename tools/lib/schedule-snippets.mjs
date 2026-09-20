// tools/lib/schedule-snippets.mjs
//
// DELEGATED SCHEDULING — the ready-made schedule artefacts a journey's
// `schedule:` turns into (docs/VALUE_BACKLOG.md item 11: no scheduler in
// the server, emit snippets instead). `packc journey schedule <name>`
// feeds this module the parsed schedule (tools/lib/schedule.mjs) plus the
// Node-only inputs it cannot know itself (paths, version, workspace) and
// prints one of four forms:
//   cron      a crontab line (CRON_TZ when the journey declares a timezone)
//   schtasks  a Windows Task Scheduler command — exact shapes only, the
//             rest prints the DAILY form with a REM saying translate by hand
//   actions   a GitHub Actions workflow (history on a runner is per job:
//             the record is uploaded as an artifact, not shared with a studio)
//   k8s       one CronJob for the journey, wired to the workspace PVC of
//             deploy/k8s/components/journeys
//
// Secrets discipline: env var NAMES only, ever — `export NAME=<set in your
// environment>`, `REM setx NAME …`, `${{ secrets.NAME }}`, `secretKeyRef`.
// Honesty rule: nothing is fabricated as the journey's cadence — a missing
// schedule prints a marked placeholder, `every: 45m` (no exact cron) prints
// its command as a comment, an irregular cron is passed through verbatim.
//
// Zero-import and browser-safe: pure string builders over a plain input.

export const PLACEHOLDER_CRON = '*/15 * * * *';
export const SNIPPET_FORMATS = Object.freeze(['cron', 'schtasks', 'actions', 'k8s']);
export const K8S_WORKSPACE_PVC = 'observabilitypack-studio-workspace';
export const K8S_WORKSPACE_MOUNT = '/workspace';
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/i;
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Fill the defaults so every emitter reads one shape.
export function normaliseSnippetInput(i = {}) {
  const src = i && typeof i === 'object' ? i : {};
  const placeholder = !!src.placeholder || (src.cron == null && src.every == null);
  const envNames = [...new Set((Array.isArray(src.envNames) ? src.envNames : []).filter(n => typeof n === 'string' && ENV_NAME_RE.test(n)))];
  return {
    name: String(src.name || 'journey'),
    cron: placeholder ? PLACEHOLDER_CRON : (typeof src.cron === 'string' && src.cron ? src.cron : null),
    timezone: typeof src.timezone === 'string' && src.timezone ? src.timezone : null,
    every: typeof src.every === 'string' && src.every ? src.every : null,
    cadenceNote: typeof src.cadenceNote === 'string' && src.cadenceNote ? src.cadenceNote : null,
    envNames,
    nodePath: String(src.nodePath || 'node'),
    cliPath: String(src.cliPath || 'tools/cli.mjs'),
    cwd: String(src.cwd || '.'),
    workspace: String(src.workspace || '.observogram'),
    image: String(src.image || 'observogram:latest'),
    namespace: String(src.namespace || 'observability'),
    retention: src.retention == null ? null : String(src.retention),
    placeholder,
    source: typeof src.source === 'string' && src.source ? src.source : null,
  };
}

// The cadence in words, for the header comments.
export function describeCadence(i) {
  const n = normaliseSnippetInput(i);
  if (n.placeholder) return `placeholder ${PLACEHOLDER_CRON}`;
  const bits = [];
  if (n.every) bits.push(`every ${n.every}`);
  if (n.cron) bits.push(`cron ${n.cron}`);
  if (n.timezone) bits.push(`timezone ${n.timezone}`);
  return bits.join(' · ') || 'no schedule';
}

// The header notes every emitter carries (placeholder / no exact cron / irregular).
function headerNotes(n) {
  const notes = [];
  if (n.placeholder) notes.push(`schedule: not set in ${n.source || 'the journey file'} — placeholder, edit before installing`);
  else if (n.cadenceNote) notes.push(n.cadenceNote);
  return notes;
}

// Split a cron into its five fields (null when it is not a 5-field string).
const fields = (cron) => { const f = String(cron || '').trim().split(/\s+/); return f.length === 5 ? f : null; };
const isInt = (s) => /^\d+$/.test(s);
const pad2 = (v) => String(v).padStart(2, '0');

// POSIX shell quoting for a path that may carry spaces.
const sq = (s) => (/^[A-Za-z0-9_\-./:=+@%]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

// ---------- cron ----------

export function cronLine(i) {
  const n = normaliseSnippetInput(i);
  const out = [`# Observogram journey "${n.name}" — ${describeCadence(n)}`];
  for (const note of headerNotes(n)) out.push(`# ${note}`);
  out.push('# The journey file lives under <workspace>/journeys/; exit 0 pass · 1 gate failed · 2 error (see the log).');
  for (const e of n.envNames) out.push(`# export ${e}=<set in your environment>`);
  if (n.timezone) out.push(`CRON_TZ=${n.timezone}`);
  const cmd = `cd ${sq(n.cwd)} && OBSERVOGRAM_WORKSPACE=${sq(n.workspace)} ${sq(n.nodePath)} ${sq(n.cliPath)} journey run ${n.name} >> ${sq(`${n.workspace}/journey-${n.name}.log`)} 2>&1`;
  if (n.cron) out.push(`${n.cron} ${cmd}`);
  else out.push(`# every ${n.every}: ${cmd}`);
  return out.join('\n') + '\n';
}

// ---------- schtasks ----------

// The exact translations; null when the cron has no schtasks equivalent.
export function schtasksSchedule(i) {
  const n = normaliseSnippetInput(i);
  if (n.every && !n.placeholder) {
    const m = /^(\d+)([mhd])$/.exec(n.every);
    if (m) {
      const N = Number(m[1]);
      if (m[2] === 'm' && N >= 1 && N <= 1439) return `/SC MINUTE /MO ${N}`;
      if (m[2] === 'h' && N >= 1 && N <= 23) return `/SC HOURLY /MO ${N}`;
      if (m[2] === 'h' && N === 24) return '/SC DAILY /ST 00:00';
      if (m[2] === 'd' && N >= 1 && N <= 365) return `/SC DAILY /MO ${N} /ST 00:00`;
    }
    return null;
  }
  const f = fields(n.cron);
  if (!f) return null;
  const [min, hour, dom, mon, dow] = f;
  if (dom !== '*' || mon !== '*') return null;
  let m = /^\*\/(\d+)$/.exec(min);
  if (min === '*' && hour === '*' && dow === '*') return '/SC MINUTE /MO 1';
  if (m && hour === '*' && dow === '*') return `/SC MINUTE /MO ${Number(m[1])}`;
  if (!isInt(min)) return null;
  m = /^\*\/(\d+)$/.exec(hour);
  if (m && dow === '*') return `/SC HOURLY /MO ${Number(m[1])} /ST 00:${pad2(min)}`;
  if (hour === '*' && dow === '*') return `/SC HOURLY /MO 1 /ST 00:${pad2(min)}`;
  if (!isInt(hour)) return null;
  if (dow === '*') return `/SC DAILY /ST ${pad2(hour)}:${pad2(min)}`;
  const dayIdx = isInt(dow) ? Number(dow) % 7 : DOW_NAMES.indexOf(dow.toLowerCase());
  if (dayIdx < 0) return null;
  return `/SC WEEKLY /D ${DOW_NAMES[dayIdx].toUpperCase()} /ST ${pad2(hour)}:${pad2(min)}`;
}

const toWin = (p) => String(p).replace(/\//g, '\\');

export function schtasksCommand(i) {
  const n = normaliseSnippetInput(i);
  const out = [`REM Observogram journey "${n.name}" — ${describeCadence(n)}`];
  for (const note of headerNotes(n)) out.push(`REM ${note}`);
  const sched = schtasksSchedule(n);
  if (!sched) out.push(`REM this cron (${n.cron || `every ${n.every}`}) has no exact schtasks equivalent — translate by hand`);
  if (n.timezone) out.push(`REM schtasks runs in the machine's local time; the journey declares timezone ${n.timezone} — adjust /ST if the machine is elsewhere`);
  out.push(`REM setx OBSERVOGRAM_WORKSPACE "${toWin(n.workspace)}"   (User environment; the task runs as the current user)`);
  for (const e of n.envNames) out.push(`REM setx ${e} <set in your environment>   (User environment; the task runs as the current user)`);
  out.push(`schtasks /Create /TN "Observogram\\${n.name}" /TR "\\"${toWin(n.nodePath)}\\" \\"${toWin(n.cliPath)}\\" journey run ${n.name}" ${sched || '/SC DAILY /ST 00:00'} /F`);
  return out.join('\n') + '\n';
}

// ---------- GitHub Actions ----------

export function githubActionsWorkflow(i) {
  const n = normaliseSnippetInput(i);
  const out = [
    `# Observogram journey "${n.name}" — ${describeCadence(n)}`,
    '# Delegated scheduling (docs/VALUE_BACKLOG.md item 11): GitHub runs the journey; nothing in the studio does.',
    '# The journey file must be committed under .observogram/journeys/ in this repo. Run history on a runner is',
    '# per job — the record is uploaded as an artifact; it is NOT shared with a studio workspace.',
  ];
  for (const note of headerNotes(n)) out.push(`# ${note}`);
  out.push(`name: journey-${n.name}`, '', 'on:');
  if (n.cron) {
    out.push('  schedule:', `    - cron: "${n.cron}"${n.timezone ? `   # GitHub schedules run in UTC; the journey declares timezone ${n.timezone}` : ''}`);
  } else {
    out.push(`  # schedule: every ${n.every} has no exact cron form — set a cron by hand:`, '  # schedule:', '  #   - cron: "<cron>"');
  }
  out.push(
    '  workflow_dispatch:', '',
    'permissions:', '  contents: read', '',
    'concurrency:', `  group: journey-${n.name}`, '  cancel-in-progress: false', '',
    'jobs:', '  journey:', '    runs-on: ubuntu-latest', '    timeout-minutes: 15', '    steps:',
    '      - uses: actions/checkout@v7', '      - uses: actions/setup-node@v7', '        with:', "          node-version: '20'", "          cache: 'npm'",
    '      - run: npm ci',
    `      - name: Run journey ${n.name}`,
    '        env:',
    '          OBSERVOGRAM_WORKSPACE: .observogram',
  );
  for (const e of n.envNames) out.push(`          ${e}: \${{ secrets.${e} }}`);
  out.push(
    `        run: node tools/cli.mjs journey run ${n.name}`,
    '      - name: Upload run record', '        if: always()', '        uses: actions/upload-artifact@v7', '        with:',
    `          name: journey-${n.name}-run`, `          path: .observogram/runs/${n.name}/`, '          include-hidden-files: true', '          if-no-files-found: warn',
  );
  return out.join('\n') + '\n';
}

// ---------- Kubernetes CronJob ----------

// A DNS-1123 label from the journey name (lowercase, [a-z0-9-], ≤ 30 chars
// so the CronJob name stays ≤ 63 with its 33-char prefix).
export function k8sName(name) {
  const s = String(name || 'journey').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '');
  return s || 'journey';
}

export function k8sCronJobManifest(i) {
  const n = normaliseSnippetInput(i);
  const jobName = `observabilitypack-studio-journey-${k8sName(n.name)}`;
  const secretName = `journey-${k8sName(n.name)}-secrets`;
  const out = [
    `# Observogram journey "${n.name}" — ${describeCadence(n)}`,
    '# Delegated scheduling (docs/VALUE_BACKLOG.md item 11): one CronJob per journey, no timer in the studio.',
    `# PREREQUISITE: the studio Deployment and this CronJob mount the SAME PVC (${K8S_WORKSPACE_PVC}) at the same`,
    `# OBSERVOGRAM_WORKSPACE (${K8S_WORKSPACE_MOUNT}) — deploy/k8s/components/journeys does both — or the studio never shows these runs.`,
    '# backoffLimit 0 / restartPolicy Never: exit 1 (gate failed) is the early-warning outcome, not a retryable fault;',
    '# a retry would append a duplicate record. `kubectl get jobs` shows a gate failure as a failed Job — the intended signal.',
  ];
  for (const note of headerNotes(n)) out.push(`# ${note}`);
  out.push(
    'apiVersion: batch/v1', 'kind: CronJob', 'metadata:', `  name: ${jobName}`, `  namespace: ${n.namespace}`, '  labels:',
    '    app.kubernetes.io/name: observabilitypack-studio', '    app.kubernetes.io/component: journeys', `    observogram.io/journey: ${k8sName(n.name)}`,
    'spec:',
    n.cron ? `  schedule: "${n.cron}"` : `  schedule: "<set by hand: every ${n.every} has no exact cron form>"`,
  );
  if (n.timezone) out.push(`  timeZone: ${n.timezone}`);
  out.push(
    '  concurrencyPolicy: Forbid', '  startingDeadlineSeconds: 300', '  successfulJobsHistoryLimit: 3', '  failedJobsHistoryLimit: 3',
    '  jobTemplate:', '    spec:', '      backoffLimit: 0', '      activeDeadlineSeconds: 900', '      template:',
    '        metadata:', '          labels:', '            app.kubernetes.io/name: observabilitypack-studio', '            app.kubernetes.io/component: journeys',
    '        spec:', '          restartPolicy: Never',
    '          securityContext:', '            runAsNonRoot: true', '            runAsUser: 1000', '            runAsGroup: 1000',
    '            # A fresh PVC is root:root 0755 — without fsGroup uid 1000 cannot write the workspace (EACCES).',
    '            fsGroup: 1000', '            fsGroupChangePolicy: OnRootMismatch',
    `          # With a ReadWriteOnce PVC the pod must land on the studio's node — uncomment:`,
    '          # affinity:', '          #   podAffinity:', '          #     requiredDuringSchedulingIgnoredDuringExecution:',
    '          #       - topologyKey: kubernetes.io/hostname', '          #         labelSelector:', '          #           matchLabels:',
    '          #             app.kubernetes.io/name: observabilitypack-studio',
    '          containers:', '            - name: journey', `              image: ${n.image}`, '              imagePullPolicy: IfNotPresent',
    '              workingDir: /app',
    `              command: ["node", "tools/cli.mjs", "journey", "run", "${n.name}"]`,
    '              env:', '                - name: OBSERVOGRAM_WORKSPACE', `                  value: ${K8S_WORKSPACE_MOUNT}`,
  );
  if (n.retention) out.push('                - name: OBSERVOGRAM_JOURNEY_RUN_RETENTION', `                  value: "${n.retention}"`);
  for (const e of n.envNames) {
    out.push(`                - name: ${e}`, '                  valueFrom:', '                    secretKeyRef:', `                      name: ${secretName}`, `                      key: ${e}`);
  }
  out.push(
    '              securityContext:', '                allowPrivilegeEscalation: false', '                capabilities:', '                  drop: ["ALL"]',
    '              resources:', '                requests: { cpu: 25m, memory: 96Mi }', '                limits: { cpu: 500m, memory: 384Mi }',
    '              volumeMounts:', '                - name: workspace', `                  mountPath: ${K8S_WORKSPACE_MOUNT}`,
    '          volumes:', '            - name: workspace', '              persistentVolumeClaim:', `                claimName: ${K8S_WORKSPACE_PVC}`,
  );
  return out.join('\n') + '\n';
}

export function scheduleSnippets(i) {
  return { cron: cronLine(i), schtasks: schtasksCommand(i), actions: githubActionsWorkflow(i), k8s: k8sCronJobManifest(i) };
}
