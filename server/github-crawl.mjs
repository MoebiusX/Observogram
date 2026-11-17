// server/github-crawl.mjs — helpers for the public-GitHub crawl route.
//
// Server-only. parseGithubUrl, isCrawlerFile, isExporterCandidateFile,
// planCrawlerFetch, selectCrawlerFiles and settleFetched are pure; ghFetch is the single authenticated wrapper
// around the GitHub REST API. It sends the token its caller names and no
// other: whose token that is — the person's own, or the server's on a
// server without sign-in — is server/repo-auth.mjs's rule, never read here.

import { isTestOrFixturePath } from '../tools/lib/exporter-metrics.mjs';
import { SCAN_MAX_FILE_BYTES, SCAN_WHY, scanReadsPath, scanRefusal } from '../tools/lib/crawler.mjs';
import { hostMessage, hostWaitMs, readSignal, retryKind, unreachable } from './fetch-failure.mjs';

export function parseGithubUrl(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const cleaned = input.trim().replace(/\.git$/, '').replace(/\/$/, '');
  // owner/repo bare form
  const bare = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(cleaned);
  if (bare) return { owner: bare[1], repo: bare[2] };
  // Full URL form
  const url = /github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:\/tree\/([A-Za-z0-9._/-]+))?/.exec(cleaned);
  if (url) return { owner: url[1], repo: url[2], ref: url[3] };
  return null;
}

// The extensions a metric can be declared in code under: the crawler's own
// list (tools/lib/crawler.mjs METRIC_SOURCE_EXT_RE), lower case.
const SOURCE_EXT = /\.(cjs|mjs|js|jsx|ts|tsx|py|go|java|kt|rs|cs)$/;

// The names an observability artefact usually has — a host read FETCHES
// these first. They never decide what is read: that is the crawler's own
// rule (scanReadsPath), the same for a folder, an upload and the CLI;
// planCrawlerFetch only orders by them under its file cap.
export function isCrawlerFile(path) {
  if (typeof path !== 'string') return false;
  const p = path.toLowerCase();
  if (p.includes('node_modules/') || p.includes('.git/') || p.startsWith('.git/')) return false;
  const sourceMetricCandidate =
    SOURCE_EXT.test(p) &&
    !/(\.test\.|\.spec\.|\.d\.ts$|package-lock|yarn\.lock|pnpm-lock|tokenizer\.json)/.test(p) &&
    /(metrics?|prometheus|observability|telemetry|instrumentation|monitor|otel|mcp|bayesian|processor|chaos)/.test(p);
  return (
    sourceMetricCandidate ||
    // The repository's own pack (tools/lib/repo-pack.mjs): its declared chaos
    // experiments and their newest runs.
    /(^|\/)\.observability\/[^/]+\.ya?ml$/.test(p) ||
    /(^|\/)(application|bootstrap)[\w.-]*\.ya?ml$/.test(p) ||
    // A prebuilt exporter's metrics manifest (named precisely; the broad
    // exporter patterns are isExporterCandidateFile's, fetched last).
    /(^|[/.])metrics-manifest\.json$/.test(p) ||
    /(^|\/)docker[-_]compose[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)compose[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /\.rules\.(ya?ml)$/.test(p) ||
    /(^|\/)prometheus[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)alertmanager[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)otel[a-z0-9._-]*config[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)otelcol[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)collector[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)chart\.(ya?ml)$/.test(p) ||
    /(^|\/)values[\w.-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)templates\/.*\.(ya?ml)$/.test(p) ||
    /(^|\/)k8s\/.*\.(ya?ml)$/.test(p) ||
    /(^|\/)dashboards?\/.*\.json$/.test(p) ||
    /(^|\/)grafana\/.*\.json$/.test(p) ||
    /\.dashboard\.json$/.test(p) ||
    // A JSON whose path says dashboards or monitoring in any other spelling
    // (`deploy/grafana-dashboards/api.json`, `observability/boards/x.json`):
    // the crawler tells a dashboard by its content, so the cap must not put
    // it behind the source.
    (/\.json$/.test(p) && /(dashboard|grafana|monitoring|observability)/.test(p)) ||
    /(^|\/)kustomization\.(ya?ml)$/.test(p)
  );
}

// Files that MAY say what a prebuilt exporter exposes or how a collector
// scrapes it, by names too common to fetch first: a saved /metrics (`.prom`,
// `.metrics`, never from a test or fixture folder), any `config.yaml` (an
// mq-metric-samples config), a Helm chart's `files/*.yaml` (a collector
// config). Never one isCrawlerFile already takes.
export function isExporterCandidateFile(path) {
  if (typeof path !== 'string' || isCrawlerFile(path)) return false;
  const p = path.toLowerCase();
  if (p.includes('node_modules/') || p.startsWith('.git/') || p.includes('/.git/')) return false;
  // The test-folder rule reads the path as written (camelCase source sets).
  return (/\.(prom|metrics)$/.test(p) && !isTestOrFixturePath(path))
    || /(^|\/)config\.ya?ml$/.test(p)
    || /(^|\/)files\/.*\.ya?ml$/.test(p);
}

// Files a cap reaches last: tests and fixtures, lock files, type
// declarations, tokenizer dumps — read when there is room, never before an
// artefact.
const LAST = /(\.test\.|\.spec\.|\.d\.ts$|package-lock\.json$|yarn\.lock$|pnpm-lock\.ya?ml$|tokenizer\.json$)/i;

// The folders a web client's source lives under, by the names such folders
// usually have — for the languages a browser runs. `client/` in a Go or Java
// tree is an API client, the service's own code.
const WEB_UI_FOLDERS = new Set(['client', 'frontend', 'front-end', 'ui', 'components']);
const WEB_EXT = /\.(?:cjs|mjs|js|jsx|ts|tsx)$/;
// A mobile app's folders, whatever the language.
const MOBILE_FOLDERS = new Set(['android', 'ios']);
// The top-level folders around a service rather than of it: tooling,
// documentation, samples, data. Only at the root: `src/data/` is the
// service's data layer, `internal/tools/` its own code.
const AROUND_FOLDERS = new Set(['scripts', 'script', 'tools', 'docs', 'doc', 'examples', 'example', 'samples', 'bin', 'hack', 'data']);
const lower = (path) => String(path ?? '').replace(/\\/g, '/').toLowerCase();
const foldersOf = (path) => lower(path).split('/').slice(0, -1);

/**
 * Whether `path` is a user interface's source: a `.tsx` / `.jsx` component;
 * a JavaScript or TypeScript file under a folder named as a web client's is
 * (`client/`, `frontend/`, `ui/`, `components/`); or anything under
 * `android/` or `ios/`. A cap reaches these after the rest of the source: in
 * tree order `client/` sorts before `server/`, and a 200-file cap spent 86
 * slots on React components while the service file that declared three live
 * metrics was cut. A client file that does hold telemetry says so in its
 * path (isCrawlerFile's `otel`, `metrics`, `telemetry` …) and is read first,
 * whatever folder it is in.
 */
export function isUiSourcePath(path) {
  const p = lower(path);
  if (/\.(?:tsx|jsx)$/.test(p)) return true;
  const folders = foldersOf(p);
  return folders.some((seg) => MOBILE_FOLDERS.has(seg)) || (WEB_EXT.test(p) && folders.some((seg) => WEB_UI_FOLDERS.has(seg)));
}

/**
 * Whether `path` is the service's own source or configuration: a file a
 * metric can be declared in (SOURCE_EXT) or a YAML the names above did not
 * single out (a rule file called `alerts.yml`), outside the top-level
 * folders around a service (`scripts/`, `tools/`, `docs/`, `examples/`,
 * `samples/`, `bin/`, `hack/`, `data/`) and not a build tool's `*.config.*`
 * at the root. What is left — tooling scripts, a JSON no name singled out,
 * documentation, data — is read after it. Neither rule decides what a scan
 * reads (scanReadsPath does): they order it under planCrawlerFetch's cap.
 */
export function isServiceSourcePath(path) {
  const p = lower(path);
  if (!(SOURCE_EXT.test(p) || /\.ya?ml$/.test(p))) return false;
  if (/^[^/]*\.config\.[^/]+$/.test(p)) return false;
  return !AROUND_FOLDERS.has(foldersOf(p)[0]);
}

// Under the cap, in this order. A YAML of the service goes before its source:
// a rule file with a plain name holds dozens of rules, a source file a metric.
const tierOf = (path) => (isCrawlerFile(path) ? 0
  : isExporterCandidateFile(path) ? 1
    : isTestOrFixturePath(path) || LAST.test(path) ? 6
      : isUiSourcePath(path) ? 5
        : !isServiceSourcePath(path) ? 4
          : /\.ya?ml$/i.test(String(path)) ? 2 : 3);

/**
 * What a host read (a GitHub or an Azure DevOps tree) downloads: every blob
 * the crawler's rule reads (scanReadsPath — the rule a folder, an upload and
 * the CLI apply), at most `maxFiles` of them, ordered so the cap reaches the
 * likely artefacts last: isCrawlerFile's names first, then
 * isExporterCandidateFile's, then the service's own YAML and then its source
 * (isServiceSourcePath), then what is around it (tooling, documentation,
 * data), then a user interface's source (isUiSourcePath), then tests,
 * fixtures and lock files — each group in tree order — so a monorepo's many
 * `config.yaml` files never push out a rule file, an Alertmanager config or
 * a collector config, and a client's components or a `scripts/` folder never
 * push out the service that declares the metrics.
 * A secrets file, a blob the tree says is over `fileCapBytes` and a blob past
 * `totalCapBytes` (by the tree's sizes, in that order) are skipped and named,
 * never fetched.
 * → { selected: [node], candidates, capped, cappedFiles, skipped: [{ path, why }] }
 *   candidates  how many blobs the rule reads in the whole tree
 *   capped      how many of them the file cap left out
 *   cappedFiles their paths, in plan order (a record keeps the first few)
 */
export function planCrawlerFetch(tree, { maxFiles = 200, fileCapBytes = SCAN_MAX_FILE_BYTES, totalCapBytes = Infinity } = {}) {
  const blobs = (Array.isArray(tree) ? tree : []).filter(node => node?.type === 'blob' && typeof node.path === 'string');
  const skipped = [];
  const takes = [];
  for (const node of blobs) {
    const why = scanRefusal(node.path);   // a secrets file (git keeps a .gitignore'd one out of the tree)
    if (why) { skipped.push({ path: node.path, why }); continue; }
    if (scanReadsPath(node.path)) takes.push(node);
  }
  const ordered = takes.map((node, i) => ({ node, i, tier: tierOf(node.path) }))
    .sort((x, y) => x.tier - y.tier || x.i - y.i)
    .map(x => x.node);
  const selected = [];
  const cappedFiles = [];
  let total = 0;
  for (const node of ordered) {
    const size = Number(node.size) || 0;
    if (size > fileCapBytes) { skipped.push({ path: node.path, why: SCAN_WHY.tooLarge(fileCapBytes) }); continue; }
    if (selected.length >= maxFiles) { cappedFiles.push(node.path); continue; }
    if (total + size > totalCapBytes) { skipped.push({ path: node.path, why: SCAN_WHY.totalCap(totalCapBytes) }); continue; }
    total += size;
    selected.push(node);
  }
  return { selected, candidates: takes.length, capped: cappedFiles.length, cappedFiles, skipped };
}

// planCrawlerFetch's blobs alone.
export function selectCrawlerFiles(tree, opts = {}) {
  return planCrawlerFetch(tree, opts).selected;
}

const byPath = (x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0);

/**
 * The files a host read downloaded, settled in the plan's order (downloads
 * finish in any order): a text over `fileCapBytes` (a tree with no sizes:
 * Azure DevOps) or past `totalCapBytes` is skipped and named, as is a
 * download that failed, with its error. `texts`: path → { text } | { error }.
 * → { files, skipped } — files in path order, which is the order crawlFiles
 * reads them in, whatever order they arrived in; skipped in path order, the
 * plan's own skips with them (`planned`).
 */
export function settleFetched(selected, texts, { fileCapBytes = SCAN_MAX_FILE_BYTES, totalCapBytes = Infinity, planned = [] } = {}) {
  const kept = [];
  const skipped = [...planned];
  let total = 0;
  for (const node of selected) {
    const got = texts.get(node.path);
    if (!got) continue;
    if (got.error) { skipped.push({ path: node.path, why: `it could not be downloaded (${got.error})` }); continue; }
    if (got.text.length > fileCapBytes) { skipped.push({ path: node.path, why: SCAN_WHY.tooLarge(fileCapBytes) }); continue; }
    if (total + got.text.length > totalCapBytes) { skipped.push({ path: node.path, why: SCAN_WHY.totalCap(totalCapBytes) }); continue; }
    total += got.text.length;
    kept.push({ path: node.path, text: got.text });
  }
  kept.sort(byPath);
  return { files: Object.fromEntries(kept.map(k => [k.path, k.text])), skipped: skipped.sort(byPath) };
}

// A host read's caps: at most 200 files of the scan's 5 MB each, 16 MB in all.
export const HOST_READ_CAPS = Object.freeze({ maxFiles: 200, fileCapBytes: SCAN_MAX_FILE_BYTES, totalCapBytes: 16 * 1024 * 1024 });
// How many of a read's files are fetched at once, GitHub and Azure DevOps
// alike: a pool, the next file taken as a slot frees.
export const HOST_READ_PARALLEL = 8;
// How long all the files of one read may take together, after the tree:
// 120 s, twice READ_TIMEOUT_MS (server/fetch-failure.mjs). A 200-file read
// is 25 rounds of 8, so a host that answers a file in under about 5 s fits;
// a slower one loses the tail of the plan, each file skipped and named — the
// trade for never sending 200 requests at once, and for an Azure DevOps
// worst case of 120 s instead of 25 × 60 s. Each file keeps its own 60 s
// deadline inside it; the repository and tree reads keep theirs apart, not
// under this budget (HOST_READ_CALL_BUDGET_MS).
export const HOST_READ_FILES_BUDGET_MS = 120_000;

// How long one read that is no file of a read's — a repository's metadata,
// its tree — may take, its tries and the waits between them together: 90 s,
// room for a host's 60 s wait between two quick tries. A try again is
// started only when the wait and a try as long as the last one fit in what
// is left, so a host or a proxy that fails slowly (a 504 after 55 s) is
// asked once, as before retries, never four times. A Run's repository read
// therefore takes at most 90 s for the repository's metadata (when no branch
// is named), 90 s for its tree and 120 s for its files.
export const HOST_READ_CALL_BUDGET_MS = 90_000;

// How often a read tries one file (the first try included); the backoff
// before a try again when the host asks for no wait — 1 s, 2 s, 4 s, each
// × 0.5–1 — and the longest wait a host may ask of a read (never past the
// read's own end: a host that asks for longer is not asked again in it).
export const HOST_READ_ATTEMPTS = 4;
export const HOST_READ_BACKOFF_MS = 1000;
export const HOST_READ_MAX_WAIT_MS = 60_000;

// The reason a read's budget aborts its files with: a ReadBudgetError, which
// unreachable() leaves as it is (neither fetch's failure nor a TimeoutError),
// so a file the time ran out for is skipped with exactly this sentence.
export function outOfTime(budgetMs) {
  return Object.assign(new Error(`the read's ${Math.round(budgetMs / 1000)} s for its files ran out`), { name: 'ReadBudgetError' });
}

// A wait that ends early, with the signal's reason, when the signal aborts.
function sleepUnder(ms, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}
const secondsOf = (ms) => Math.ceil(ms / 1000);
// The wait before try `attempt + 1`: the host's own (err.retryAfterMs), else the backoff.
const waitAfter = (e, attempt, backoffMs, random) => (Number.isFinite(e?.retryAfterMs) && e.retryAfterMs > 0
  ? e.retryAfterMs : backoffMs * 2 ** (attempt - 1) * (0.5 + random() / 2));

/**
 * The files of one host read, downloaded at most `parallel` at a time under
 * one budget of `budgetMs`: a pool of workers, each taking the next node of
 * `selected` in order (a slow file holds one slot, never the others), each
 * file awaited through `fetchText(node, signal)` — the budget's signal, which
 * the fetcher combines with its own deadline (fetch-failure.mjs readSignal).
 *
 * A file the host refused or dropped is tried again (fetch-failure.mjs
 * retryKind), `attempts` tries in all: after the wait the host asked for
 * (err.retryAfterMs, fetch-failure.mjs hostWaitMs), else a backoff. A refusal
 * (403, 429, 503) slows the whole read down: every request pauses for the
 * wait, and the pool halves — once for a burst, never once per refusal — then
 * grows back by one after a round of answers, never to the size that was
 * refused. A server error or a drop is tried again alone. A host that asks
 * for a wait longer than `maxWaitMs`, or past the budget's end — a refusal
 * and a server error alike — is asked nothing more in this read, and the
 * sentence names which bound it asked past ("more than the 60 s a read
 * waits", "more than the read had left"). Nothing ever runs more than
 * `parallel` at once.
 *
 * When the budget runs out its controller aborts with outOfTime's error as
 * the reason: fetch(), res.text() and res.json() reject with the signal's
 * reason, so a file in flight ends with that sentence, and a file not started
 * by then is stored with it, no call made. Never fatal.
 * → Map(path → { text } | { error, status?, attempts? }) — what settleFetched
 * takes; `error` the host's sentence and, when it was tried more than once,
 * "— tried <n> times" (or why it was not tried again); `status` the last
 * answer's; `attempts` when more than one.
 * `now`, `sleep` and `random` are test seams.
 */
export async function downloadFiles(selected, fetchText, {
  parallel = HOST_READ_PARALLEL, budgetMs = HOST_READ_FILES_BUDGET_MS, attempts = HOST_READ_ATTEMPTS,
  backoffMs = HOST_READ_BACKOFF_MS, maxWaitMs = HOST_READ_MAX_WAIT_MS, now = Date.now, sleep = sleepUnder, random = Math.random,
} = {}) {
  const texts = new Map();
  if (!selected.length) return texts;
  const budget = new AbortController();
  const reason = outOfTime(budgetMs);
  const timer = setTimeout(() => budget.abort(reason), budgetMs);
  const deadline = now() + budgetMs;
  const ranOut = `the read's ${Math.round(budgetMs / 1000)} s for its files ran out before it was tried again`;
  const tries = Math.max(1, Math.floor(attempts) || 1);
  // The pool: `limit` requests at once; after a refusal it grows back to `ceiling` at most.
  let limit = Math.max(1, Math.floor(parallel) || 1);
  let ceiling = limit;
  let inFlight = 0;
  let pauseUntil = 0;
  let cuts = 0;
  let streak = 0;
  let gaveUp = null;
  const waiters = [];
  const wake = (all = false) => { while (waiters.length && (all || inFlight < limit)) waiters.shift()(); };
  budget.signal.addEventListener('abort', () => wake(true), { once: true });
  // A slot, before every request: never past the budget or a give-up, never during a pause.
  // → how many cuts the pool had when the request started (a refusal of an older one is that cut's burst).
  const acquire = async () => {
    for (;;) {
      if (budget.signal.aborted) throw reason;
      if (gaveUp) throw gaveUp;
      const wait = pauseUntil - now();
      if (wait > 0) { await sleep(wait, budget.signal); continue; }
      if (inFlight < limit) { inFlight++; return cuts; }
      await new Promise((resolve) => waiters.push(resolve));
    }
  };
  const release = () => { inFlight--; wake(); };
  const failed = (e, error, attempt) => ({ error, ...(Number.isInteger(e?.status) ? { status: e.status } : {}), ...(attempt > 1 ? { attempts: attempt } : {}) });
  // The bound a host's wait goes past: the longest a read waits, else what the read has left.
  const pastWhat = (wait) => (wait > maxWaitMs ? `more than the ${secondsOf(maxWaitMs)} s a read waits` : 'more than the read had left');
  const tooLong = () => `the host asked to wait ${secondsOf(gaveUp.waitMs)} s, ${pastWhat(gaveUp.waitMs)}`;
  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      const node = selected[next++];
      let last = null;
      for (let attempt = 1; attempt <= tries; attempt++) {
        let startedAt;   // the pool's cut count when this request started
        try { startedAt = await acquire(); }
        catch (stop) {
          // Not tried (again): the budget's sentence, unchanged for a file never started; or the give-up's.
          if (!last) texts.set(node.path, stop === reason ? { error: reason.message } : failed(stop, stop.message, 1));
          else texts.set(node.path, failed(last, `${last.message} — ${stop === reason ? ranOut : tooLong()}`, attempt - 1));
          break;
        }
        let text;
        try { text = await fetchText(node, budget.signal); }
        catch (e) {
          release();
          if (e === reason || e?.name === 'ReadBudgetError') {
            texts.set(node.path, last ? failed(last, `${last.message} — ${ranOut}`, attempt - 1) : { error: e.message });
            break;
          }
          last = e;
          const kind = retryKind(e);
          const wait = waitAfter(e, attempt, backoffMs, random);
          // One cut for a burst: a refusal of a request that started before the last cut is that burst's.
          if (kind === 'refused' && startedAt === cuts) { ceiling = Math.max(1, limit - 1); limit = Math.max(1, Math.floor(limit / 2)); cuts++; streak = 0; }
          // The host's own wait, whatever it answered (a refusal, a server error): one rule — past the
          // longest a read waits, or past its end, nothing more is asked of that host in this read.
          const hinted = Number.isFinite(e?.retryAfterMs) && e.retryAfterMs > 0;
          if (kind && hinted && (wait > maxWaitMs || now() + wait > deadline)) {
            if (!gaveUp) {
              gaveUp = Object.assign(new Error(`not tried: the host ${kind === 'refused' ? 'refused' : 'could not serve'} ${node.path} (${e.status}) and asked to wait ${secondsOf(wait)} s, ${pastWhat(wait)}`), { status: e.status, waitMs: wait });
              wake(true);
            }
          } else if (kind === 'refused') pauseUntil = Math.max(pauseUntil, now() + wait);
          if (!kind) { texts.set(node.path, failed(e, attempt > 1 ? `${e.message} — tried ${attempt} times` : e.message, attempt)); break; }
          if (gaveUp) { texts.set(node.path, failed(e, `${e.message} — ${tooLong()}`, attempt)); break; }
          if (attempt === tries) { texts.set(node.path, failed(e, tries > 1 ? `${e.message} — tried ${attempt} times` : e.message, attempt)); break; }
          if (now() + wait > deadline) { texts.set(node.path, failed(e, `${e.message} — ${ranOut}`, attempt)); break; }
          try { await sleep(wait, budget.signal); }
          catch { texts.set(node.path, failed(e, `${e.message} — ${ranOut}`, attempt)); break; }
          continue;
        }
        release();
        streak++;
        if (limit < ceiling && streak >= limit) { limit++; streak = 0; wake(); }
        texts.set(node.path, { text });
        break;
      }
    }
  };
  try { await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, selected.length)) }, worker)); }
  finally { clearTimeout(timer); }
  return texts;
}

/**
 * One read that is no file of a read's (a repository's metadata, its tree),
 * tried again as a file is when the host refused or dropped it — `attempts`
 * tries in all, after the host's wait or a backoff, all the waits together at
 * most `maxWaitMs` — under one budget of `callBudgetMs` for its tries and
 * waits together (HOST_READ_CALL_BUDGET_MS): `call(signal)` gets the budget's
 * signal, which the fetcher combines with its own 60 s deadline
 * (fetch-failure.mjs readSignal), and a try again is started only when its
 * wait and a try as long as the last one fit in what the budget has left.
 * A read that still fails throws its last error, "— tried <n> times" added
 * to its sentence (and "; the read's <n> s ran out" when the budget cut the
 * try after it); its status is the host's. `limits` as downloadFiles'.
 */
export async function retryRead(call, {
  attempts = HOST_READ_ATTEMPTS, backoffMs = HOST_READ_BACKOFF_MS, maxWaitMs = HOST_READ_MAX_WAIT_MS, callBudgetMs = HOST_READ_CALL_BUDGET_MS,
  now = Date.now, sleep = sleepUnder, random = Math.random,
} = {}) {
  const tries = Math.max(1, Math.floor(attempts) || 1);
  const budget = new AbortController();
  const reason = Object.assign(new Error(`the read's ${secondsOf(callBudgetMs)} s ran out`), { name: 'ReadBudgetError' });
  const timer = setTimeout(() => budget.abort(reason), callBudgetMs);
  const end = now() + callBudgetMs;
  const said = (e, n, why = '') => { if (e && typeof e === 'object' && typeof e.message === 'string' && (n > 1 || why)) e.message = `${e.message} — tried ${n} time${n === 1 ? '' : 's'}${why}`; return e; };
  let waited = 0;
  let last = null;
  try {
    for (let attempt = 1; ; attempt++) {
      const startedAt = now();
      try { return await call(budget.signal); }
      catch (e) {
        // The budget cut this try: the host's last answer says what failed, and why no more was asked.
        if (e === reason || e?.name === 'ReadBudgetError') throw last ? said(last, attempt, `; ${reason.message}`) : e;
        last = e;
        const wait = waitAfter(e, attempt, backoffMs, random);
        const took = Math.max(0, now() - startedAt);
        if (!retryKind(e) || attempt >= tries || waited + wait > maxWaitMs || now() + wait + took > end) throw said(e, attempt);
        waited += wait;
        try { await sleep(wait, budget.signal); }
        catch { throw said(e, attempt, `; ${reason.message}`); }
      }
    }
  } finally { clearTimeout(timer); }
}

// The JSON a GitHub REST answer carries, an answer that could not be read to
// the end said as what it is (server/fetch-failure.mjs: the status was read,
// so `answered`; a body that is not JSON stays the SyntaxError it was).
async function apiJson(res) {
  try { return await res.json(); }
  catch (e) { throw unreachable('GitHub', 'https://api.github.com', e, { answered: true }); }
}

export async function ghFetch(path, init = {}, { token = null } = {}) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'observogram-crawler/1.0',
    'Accept-Encoding': 'identity',   // no decompression of a third party's bytes (the Brotli decoder, CVE-2026-111497)
    ...(init.headers || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  let res;
  // The caller's signal (a read's budget, a sign-in's shorter wait) combines with the deadline, never replaces it.
  try { res = await fetch(`https://api.github.com${path}`, { ...init, headers, signal: readSignal(init.signal ?? null) }); }
  catch (e) { throw unreachable('GitHub', 'https://api.github.com', e); }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // GitHub's SAML single sign-on refusal — its `X-GitHub-SSO: required; url=…` header (the value
    // never read out), or its sentence, "Resource protected by organization SAML enforcement." where
    // a proxy dropped the header: the token is not authorised for the organisation, and the message's
    // second sentence says what to do about it, so that one is kept too.
    const sso = res.status === 403 && (res.headers.get('x-github-sso') !== null || /\bSAML enforcement\b/i.test(hostMessage(body)));
    // What GitHub says (fetch-failure.mjs hostMessage): its JSON `message`'s first sentence
    // ("Not Found", "Bad credentials"), with no account or address in it — never the body itself,
    // nothing of a body that is not JSON.
    const said = hostMessage(body, { sentences: sso ? 2 : 1 });
    const err = new Error(`GitHub ${res.status} on ${path}${said ? `: ${said}` : ''}`);
    err.status = res.status;
    // The wait GitHub asks for (a secondary limit's retry-after, a spent quota's reset), for a read that tries again.
    const wait = hostWaitMs(res.headers);
    if (wait !== null) err.retryAfterMs = wait;
    // A 403 that refuses the token rather than the pace — SAML single sign-on, a token or an app
    // without access, an IP allow list — is final, never tried again: GitHub's limits say they are
    // limits, by a retry-after, a spent quota (x-ratelimit-remaining 0) or their own sentence (a
    // primary or secondary rate limit, the abuse detection), and only those are.
    if (res.status === 403) {
      const spent = String(res.headers.get('x-ratelimit-remaining') ?? '').trim() === '0';
      if (sso || !(wait !== null || spent || /\brate limit\b|\babuse detection\b/i.test(said))) err.retryable = false;
    }
    throw err;
  }
  return res;
}

// A public file's address on raw.githubusercontent.com.
const rawUrl = (owner, repo, ref, path) => `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref).replace(/%2F/g, '/')}/${encodeURIComponent(path).replace(/%2F/g, '/')}`;

// A public file's bytes from raw.githubusercontent.com — outside the REST
// API's quota (60 requests an hour without a token, which a 200-file scan
// would spend in its first minute). Never sent a token. `signal` is the
// read's budget when the file is one of a read's (downloadFiles); the 60 s
// deadline is the fetch's own either way.
export async function rawFetch(owner, repo, ref, path, { signal = null } = {}) {
  const url = rawUrl(owner, repo, ref, path);
  let res;
  try { res = await fetch(url, { headers: { 'User-Agent': 'observogram-crawler/1.0', 'Accept-Encoding': 'identity' }, redirect: 'manual', signal: readSignal(signal) }); }
  catch (e) { throw unreachable('GitHub', url, e); }
  // A redirect is read, never followed, and named as what it is.
  if (res.status >= 300 && res.status < 400) {
    const err = new Error(`GitHub ${res.status} on ${path}: raw.githubusercontent.com redirected it, which the server does not follow (the repository may have moved)`);
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status} on ${path}`);
    err.status = res.status;
    const wait = hostWaitMs(res.headers);
    if (wait !== null) err.retryAfterMs = wait;
    throw err;
  }
  return res;
}

/**
 * The files a crawl of a GitHub repository reads, fetched: the default
 * branch when `ref` is null; planCrawlerFetch's blobs (HOST_READ_CAPS: at
 * most 200, 5 MB each, 16 MB in all) downloaded by downloadFiles — 8 at a
 * time (HOST_READ_PARALLEL), each under its own 60 s deadline, all under one
 * 120 s budget (HOST_READ_FILES_BUDGET_MS); the repository and tree reads
 * before them each under a 90 s budget of their own, apart, a try 60 s at
 * most (HOST_READ_CALL_BUDGET_MS, retryRead) — through the contents API
 * with a `token` (a private repository; repo-auth.mjs says whose), else
 * from raw.githubusercontent.com (rawFetch: a public one, no quota spent).
 * A file GitHub refused or dropped is tried again (downloadFiles), and so are
 * the repository and tree reads (retryRead). A file that still fails or does
 * not fit is skipped and named, never fatal (a connection dropped while it
 * was read is named as that; a file the budget ran out for reads "it could
 * not be downloaded (the read's 120 s for its files ran out)"); a tree or
 * repository error throws (err.status is GitHub's; none when the host was not
 * reached or its answer was cut short).
 * → { ref, candidates, capped, cappedFiles, fileCap, files, skipped: [{ path, why }], truncated }
 * — candidates the blobs the crawler's rule reads, capped how many of them
 * the 200-file cap left out (cappedFiles their paths, fileCap the cap),
 * truncated GitHub's own flag (a tree too large to list whole: files may be
 * missing that nothing here can name). The POST /api/crawl-github route and a
 * service's Run share it. `limits` ({ parallel, budgetMs, attempts, backoffMs,
 * maxWaitMs, callBudgetMs, now, sleep, random }) is a test seam for
 * downloadFiles and retryRead.
 */
export async function fetchGithubFiles({ owner, repo, ref = null }, { token = null, fetchFn = (path, init) => ghFetch(path, init, { token }), rawFn = token ? null : rawFetch, limits = {} } = {}) {
  let at = ref;
  if (!at) {
    const repoMeta = await retryRead(async (signal) => apiJson(await fetchFn(`/repos/${owner}/${repo}`, { signal })), limits);
    at = repoMeta.default_branch || 'main';
  }
  const treeResp = await retryRead(async (signal) => apiJson(await fetchFn(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(at)}?recursive=1`, { signal })), limits);
  const plan = planCrawlerFetch(treeResp.tree, HOST_READ_CAPS);
  const texts = await downloadFiles(plan.selected, async (node, signal) => {
    const contentRes = rawFn
      ? await rawFn(owner, repo, at, node.path, { signal })
      : await fetchFn(`/repos/${owner}/${repo}/contents/${encodeURIComponent(node.path).replace(/%2F/g, '/')}?ref=${encodeURIComponent(at)}`, {
        headers: { Accept: 'application/vnd.github.raw+json' }, signal,
      });
    // The bytes: the status was read, so an answer that does not finish or
    // cannot be read to the end is said as that, not as the host not reached.
    try { return await contentRes.text(); }
    catch (e) { throw unreachable('GitHub', rawFn ? rawUrl(owner, repo, at, node.path) : 'https://api.github.com', e, { answered: true }); }
  }, limits);
  const { files, skipped } = settleFetched(plan.selected, texts, { ...HOST_READ_CAPS, planned: plan.skipped });
  return { ref: at, candidates: plan.candidates, capped: plan.capped, cappedFiles: plan.cappedFiles, fileCap: HOST_READ_CAPS.maxFiles, files, skipped, truncated: !!treeResp.truncated };
}
