// studio/services-model.mjs
//
// The pure models of the Services home and the service page (docs/STORE_PLAN.md
// §6, slice 6a: services as the axis). Every function takes its inputs
// explicitly — the GET /api/services rows (ServiceView, server/service-admin.mjs),
// the GET /api/orgs body, the catalogue (GET /api/packs), a conformance
// report (GET /api/packs/:id/conformance?env=), the build draft — and
// returns plain data for the renderers (studio/services-view.mjs) and the
// controller (studio/app.mjs). No state reads, no fetches, no DOM, no
// import: tools/test-services-model.mjs exercises it under node:test
// (docs/UI_CONVENTIONS.md §2).
//
// Two rules from tools/lib/service-keys.mjs are needed and NOT imported:
// the studio binds that module at call time (app.mjs boot(), once —
// tools/test-service-keys.mjs pins it), so `isLiveAggregatePack` is
// injected where a model needs it and a service key arrives computed
// (`nameKey`). A static `/lib/` import here would break the Node suites.
//
// The honesty rules the models carry (STORE_PLAN §6, HANDOVER §2): a verdict
// on placeholders is never `pass`; a report for an environment the pack does
// not declare is a BASE grade, named so, never `pass`; "no verdict yet" is
// said, never shown as a zero; a control a rank cannot use is drawn disabled
// with its reason (the server's effective role decides, GET /api/orgs); a
// refusal is the server's sentence, `<status>: <text>`, never a raw body.

export const TIERS = ['tier-1', 'tier-2', 'tier-3'];
export const TIER_BY_PACK = 'graded by the pack';   // the server's wording for tier null (WAYS.tier)

const RANKS = { viewer: 0, operator: 1, admin: 2 };
const ORG_FALLBACK = 'this organisation';

// ---------- access: what the server says this browser may do ----------

// `orgs` is the GET /api/orgs body ({ ok, tenancy, orgs: [{ id, name, role,
// effectiveRole }], active }) or null when the call failed; `orgsError` the
// thrown error then (a 501 `denied: 'no-backend'` is the static bundle);
// `identity` the /auth/me body (null in the open and token postures);
// `activeOrg` the org the studio sends in X-Observogram-Org.
//
// The source of truth is `effectiveRole` for the active org: the rank the
// guard applies for this principal — a member's role (owner → admin), an owner
// outside their memberships (admin), the open posture's `local` (admin), the
// token-only posture's anonymous browser (viewer). This is for affordances
// only; the server's authorize() still decides every write.
export function accessModel({ orgs = null, identity = null, activeOrg = null, orgsError = null } = {}) {
  const base = { posture: 'unknown', role: null, rank: null, canWrite: true, reason: null, orgName: null };
  if (orgsError?.denied === 'no-backend') return { ...base, posture: 'static' };
  const signedIn = identity?.authenticated === true;
  const list = Array.isArray(orgs?.orgs) ? orgs.orgs : null;
  if (list) {
    const activeId = orgs.active ?? activeOrg ?? null;
    const entry = list.find((o) => o.id === activeId) || (list.length === 1 ? list[0] : null);
    const role = typeof entry?.effectiveRole === 'string' ? entry.effectiveRole : null;
    const posture = signedIn ? 'identity' : (role === 'viewer' && identity === null ? 'token' : 'open');
    return withRank({ ...base, posture, role, orgName: entry?.name ?? null });
  }
  // The call failed: /auth/me's memberships (their effectiveRole) are the fallback; nothing without an identity.
  if (!signedIn) return base;
  const mine = Array.isArray(identity.orgs) ? identity.orgs : [];
  const entry = mine.find((o) => o.id === activeOrg) || (mine.length === 1 ? mine[0] : null);
  const role = typeof entry?.effectiveRole === 'string' ? entry.effectiveRole : null;
  return withRank({ ...base, posture: 'identity', role, orgName: entry?.name ?? null });
}

function withRank(access) {
  const rank = Object.hasOwn(RANKS, access.role) ? RANKS[access.role] : null;
  const canWrite = rank === null ? true : rank >= 1;
  let reason = null;
  if (!canWrite) {
    reason = access.posture === 'token'
      ? 'needs the operator role — this server takes mutations with its API token only, not from a browser'
      : `needs the operator role in ${access.orgName ?? ORG_FALLBACK} — yours is ${access.role}`;
  }
  return { ...access, rank, canWrite, reason };
}

// ---------- the pack a service opens ----------

// One rule for every entry point (the card, the page, the header selector, the
// derived tile): among `entries` (catalogue order, oldest → newest — the
// registry appends, and a re-registered id moves to the end), the NEWEST
// declared one wins; failing that the newest aggregate; failing that nothing.
// `isDeclared(entry)` says which entries count as declared.
export function newestPack(entries, isDeclared) {
  const list = Array.isArray(entries) ? entries.filter((p) => p && p.ok !== false) : [];
  const declared = list.filter((p) => isDeclared(p));
  if (declared.length) return { pack: declared[declared.length - 1], how: 'primary' };
  if (list.length) return { pack: list[list.length - 1], how: 'aggregate' };
  return { pack: null, how: 'none' };
}

// The service record's pack: its primary links (several — one per pack that
// named it; `packs[]` is sorted by id string, not by age) that are in the
// catalogue, the newest in catalogue order first; else the newest member
// link that is a live aggregate (today's tile fallback); else none.
// `primaries` lists every primary id — those in the catalogue in its order,
// then the rest in the record's order.
export function packForService(service, catalog, { isLiveAggregatePack = () => false } = {}) {
  const links = Array.isArray(service?.packs) ? service.packs : [];
  const primaryIds = new Set(links.filter((p) => p.role === 'primary').map((p) => p.id));
  const memberIds = new Set(links.filter((p) => p.role === 'member').map((p) => p.id));
  const entries = (Array.isArray(catalog) ? catalog : []).filter((p) => p && p.ok !== false
    && (primaryIds.has(p.id) || (memberIds.has(p.id) && isLiveAggregatePack(p))));
  const picked = newestPack(entries, (p) => primaryIds.has(p.id));
  const inCatalogue = entries.filter((p) => primaryIds.has(p.id)).map((p) => p.id);
  const primaries = [...inCatalogue, ...[...primaryIds].filter((id) => !inCatalogue.includes(id))];
  return { ...picked, primaries };
}

// ---------- the verdict per environment ----------

// `report` is the GET /api/packs/:id/conformance?env= body, null while not
// loaded, or { error: '<status>: <text>' } when the fetch failed. `declared`
// says whether the environment is one the pack declares (the catalogue
// entry's environments[]); `how` is packForService().how. `fetch` is false
// when no request should be issued: no pack, or a member pack only — the
// server grades a pack by the PACK's primary service, so an aggregate's
// report would name another service's tier under this one.
export function verdictModel(report, { packId = null, env = null, declared = true, how = 'primary' } = {}) {
  const key = packId && env ? verdictKey(packId, env) : null;
  const out = { state: 'none', text: '', detail: null, score: null, tier: null, from: null, mismatch: false, onPlaceholder: 0, fetch: true, key };
  if (how === 'none') return { ...out, text: 'No pack yet', fetch: false };
  if (how === 'aggregate') return { ...out, text: 'Member pack only — open it under Packs linked', fetch: false };
  if (report == null) return { ...out, state: 'loading', text: 'Loading…' };
  if (report.error) return { ...out, state: 'error', text: 'Unavailable', detail: String(report.error) };
  const score = Number.isFinite(report.scorePercent) ? report.scorePercent : null;
  const tier = report.tier?.graded ?? report.declaredTier ?? null;
  const from = report.tier?.from ?? null;
  const mismatch = report.tier?.mismatch === true;
  const onPlaceholder = Array.isArray(report.onPlaceholder) ? report.onPlaceholder.length : 0;
  const pct = score === null ? 'no score' : `${score}%`;
  const tierText = tier ? `${tier}${from ? ` (${from})` : ''}` : TIER_BY_PACK;
  const detail = mismatch && report.tier?.pack ? `pack says ${report.tier.pack}` : null;
  const filled = { ...out, score, tier, from, mismatch, onPlaceholder, detail };
  if (!declared) return { ...filled, state: 'base', text: `Base grade (no ${env ?? 'environment'} overlay in the pack) · ${pct} · ${tierText}` };
  if (report.conformant && onPlaceholder > 0) return { ...filled, state: 'placeholder', text: `Conformant · ${pct} · ${onPlaceholder} on placeholder${onPlaceholder === 1 ? '' : 's'}` };
  if (report.conformant) return { ...filled, state: 'pass', text: `Conformant · ${pct} · ${tierText}` };
  return { ...filled, state: 'fail', text: `Not conformant · ${pct} · ${tierText}` };
}

export const verdictKey = (packId, env) => `${packId}::${env}`;

// ---------- the record card ----------

const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

// "2 days ago" from an ISO timestamp against `now` (ms); '' when unreadable.
export function agoText(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return '';
  const secs = Math.max(0, Math.floor((now - t) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${plural(mins, 'minute')} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${plural(hours, 'hour')} ago`;
  return `${plural(Math.floor(hours / 24), 'day')} ago`;
}

const ownersText = (owners) => (Array.isArray(owners) && owners.length ? owners.join(', ') : 'no owners yet');
const packsText = (packs) => (Array.isArray(packs) && packs.length ? plural(packs.length, 'pack') : 'no pack yet');
const tierText = (tier) => tier ?? TIER_BY_PACK;

// The environments of a service with the verdict each shows, through the one
// resolver: `verdicts` is the session cache keyed verdictKey(packId, env).
function envModels(service, { verdicts, catalog, isLiveAggregatePack }) {
  const resolved = packForService(service, catalog, { isLiveAggregatePack });
  const declaredEnvs = Array.isArray(resolved.pack?.environments) ? resolved.pack.environments : [];
  const envs = (Array.isArray(service.environments) ? service.environments : []).map((env) => {
    const key = resolved.pack ? verdictKey(resolved.pack.id, env.name) : null;
    const report = key ? (verdicts?.[key] ?? null) : null;
    const declared = !resolved.pack || declaredEnvs.includes(env.name);
    return { id: env.id, name: env.name, key, packId: resolved.pack?.id ?? null, verdict: verdictModel(report, { packId: resolved.pack?.id ?? null, env: env.name, declared, how: resolved.how }) };
  });
  return { resolved, envs };
}

// One card per record. `opened` is the recents map (slug → ISO) of the active org.
export function serviceCardModel(service, { verdicts = {}, opened = {}, now = Date.now(), catalog = [], isLiveAggregatePack = () => false } = {}) {
  const { envs } = envModels(service, { verdicts, catalog, isLiveAggregatePack });
  const openedAt = Object.hasOwn(opened || {}, service.slug) ? opened[service.slug] : null;
  const ago = openedAt ? agoText(openedAt, now) : '';
  const search = [service.name, service.slug, ...(service.owners || []), ...envs.map((e) => e.name), service.tier || ''].join(' ').toLowerCase();
  return {
    id: service.id, slug: service.slug, name: service.name,
    tierText: tierText(service.tier), ownersText: ownersText(service.owners), packsText: packsText(service.packs),
    envs, openedText: ago ? `Opened ${ago}` : '', search,
  };
}

// Most recently opened first, then by name — the home's order, for the
// record cards ({ slug, name }) and the derived tiles ({ key, label }) alike.
const openedAt = (opened, k) => (Object.hasOwn(opened || {}, k) && typeof opened[k] === 'string' ? opened[k] : '');
function orderByRecent(services, opened) {
  return [...services].sort((a, b) => openedAt(opened, b.slug).localeCompare(openedAt(opened, a.slug)) || String(a.name).localeCompare(String(b.name)));
}
// The derived tiles (serviceCatalogue({ ownOnly: true }) entries) with when
// each was opened here, most recent first.
function derivedTiles(derived, opened) {
  return (Array.isArray(derived) ? derived : [])
    .map((d) => ({ ...d, openedAt: openedAt(opened, d.key) || null }))
    .sort((a, b) => (b.openedAt || '').localeCompare(a.openedAt || '') || String(a.label).localeCompare(String(b.label)));
}

// ---------- the home ----------

const gate = (access) => ({ enabled: access?.canWrite !== false, reason: access?.canWrite === false ? access.reason : null });

// `status` is state.servicesStatus ({ kind: 'ok'|'static'|'denied'|'error'|'loading', error }).
// `derived` is the controller's serviceCatalogue({ ownOnly: true }) — the
// tiles the fallback kinds draw (its rule needs the call-time /lib module),
// returned most recently opened first with each tile's `openedAt`. When the
// table is read, only the own derived services no record covers are kept —
// a registered pack whose service row was deleted (the selector's "from
// packs only" group, §6.3) — drawn as tiles beside the cards or under the
// empty sentence, so a pack GET /api/packs lists is never unreachable from
// the home; the sentence then says so instead of "No services".
// `examples` are GET /api/examples entries not in the catalogue.
// → { kind: 'table'|'empty'|'derived'|'error', heading, cards: [serviceCardModel], derived: [tile],
//     empty: { title, body, primary: 'build'|'catalogue' }|null, error: string|null,
//     catalogue: [{ id, label, tier, version }], build: { enabled, reason }, sources: { enabled, reason } }
// `kind` 'table' and 'empty' need status 'ok'; 'error' carries the status
// line's text beside the derived tiles; 'derived' is the bundle (static)
// and the loading state — today's tiles, nothing said.
export function buildServicesHomeModel({
  status = { kind: 'loading', error: null }, services = null, catalog = [], examples = [], derived = [],
  verdicts = {}, opened = {}, access = null, orgName = null, now = Date.now(), isLiveAggregatePack = () => false,
} = {}) {
  const org = orgName ?? ORG_FALLBACK;
  const catalogue = [...(Array.isArray(catalog) ? catalog : []).filter((p) => p.source !== 'uploaded'),
    ...(Array.isArray(examples) ? examples : []).filter((e) => !(catalog || []).some((p) => p.id === e.id))]
    .map((p) => ({ id: p.id, label: p.label ?? p.name ?? p.id, tier: p.criticality ?? null, version: p.version ?? null }));
  const anyRecent = Object.keys(opened || {}).length > 0;
  const base = {
    kind: 'derived', heading: anyRecent ? 'Recent services' : 'Your services', cards: [], derived: derivedTiles(derived, opened),
    empty: null, error: null, catalogue, build: gate(access), sources: gate(access),
  };
  // The own derived services no record covers (slugs and derived keys are
  // the same normalised service key — servicesSelectModel's rule).
  const covered = new Set((Array.isArray(services) ? services : []).map((s) => s.slug));
  const orphans = base.derived.filter((d) => !covered.has(d.key));
  if (status.kind === 'ok' && Array.isArray(services) && services.length) {
    const cards = orderByRecent(services, opened).map((s) => serviceCardModel(s, { verdicts, opened, now, catalog, isLiveAggregatePack }));
    return { ...base, kind: 'table', cards, derived: orphans };
  }
  if (status.kind === 'ok') {
    const canWrite = access?.canWrite !== false;
    const role = access?.role ?? 'viewer';
    let empty;
    if (orphans.length) {
      const named = `The registered packs name ${plural(orphans.length, 'service')} without a row — a tile below opens the pack`;
      empty = canWrite
        ? { title: `No service records in ${org} yet.`, body: `${named}; registering a pack again (Build, a scan, a draft or an upload) writes the row.`, primary: 'build' }
        : { title: `No service records in ${org} yet.`, body: `${named}; an operator registers a pack again to write the row — your role in ${org} is ${role}.`, primary: 'catalogue' };
    } else {
      empty = canWrite
        ? { title: `No services in ${org} yet.`, body: 'Build a pack — Define · Compile · Verify — or import one below; registering it writes the service row.', primary: 'build' }
        : { title: `No services in ${org} yet.`, body: `An operator registers the first pack (Build, a scan, a draft or an upload) — your role in ${org} is ${role}. You can read the catalogue packs below.`, primary: 'catalogue' };
    }
    return { ...base, kind: 'empty', derived: orphans, empty };
  }
  if (status.kind === 'error' || status.kind === 'denied') {
    return { ...base, kind: 'error', error: `The services table could not be read — ${status.error || 'no answer'}. Showing the services the loaded packs name.` };
  }
  return base;   // 'static' (the bundle's 501, silent) and 'loading': today's derived tiles
}

// ---------- the service page ----------

const ACTIONS = [['layers', 'Discover'], ['compare', 'Diagnose'], ['compile', 'Remediate']];

// http(s) only, through the URL parser; anything else is dropped (the server
// refused it already — WAYS.endpoints — but the renderer must never link it).
function httpLinks(endpoints) {
  const out = [];
  for (const [name, raw] of Object.entries(endpoints && typeof endpoints === 'object' ? endpoints : {})) {
    let url;
    try { url = new URL(String(raw)); } catch { continue; }
    if (url.protocol === 'http:' || url.protocol === 'https:') out.push([name, url.href]);
  }
  return out;
}

export function buildServicePageModel({ service, envName = null, verdicts = {}, catalog = [], access = null, orgName = null, isLiveAggregatePack = () => false } = {}) {
  const org = orgName ?? ORG_FALLBACK;
  const canWrite = access?.canWrite !== false;
  const { resolved, envs } = envModels(service, { verdicts, catalog, isLiveAggregatePack });
  const selected = envs.find((e) => e.name === envName) || envs[0] || null;
  const tabs = envs.map((e) => ({ id: e.id, name: e.name, selected: selected !== null && e.id === selected.id }));
  const env = selected ? service.environments.find((e) => e.id === selected.id) : null;
  const link = resolved.pack ? (service.packs || []).find((p) => p.id === resolved.pack.id) : null;
  const pack = resolved.pack ? {
    id: resolved.pack.id, label: resolved.pack.label ?? link?.label ?? resolved.pack.id, version: resolved.pack.version ?? null,
    source: link?.source ?? resolved.pack.source ?? null, how: resolved.how,
  } : null;
  let tierLine;
  if (env?.tier) tierLine = `${env.tier} — this environment's override (the service says ${tierText(service.tier)})`;
  else if (service.tier) tierLine = `${service.tier} — the service's (no environment override)`;
  else tierLine = `${TIER_BY_PACK} — neither the service nor the environment sets a tier`;
  const mcp = env?.mcpEndpoint
    ? { kind: 'bound', name: env.mcpEndpoint.name, origin: env.mcpEndpoint.origin }
    : { kind: 'none', text: env ? `No MCP endpoint bound to ${env.name} — Diagnose compares with whatever live pack you load as Pack B; an admin binds one with PATCH /api/environments/${env.id} { "mcpEndpointId": <n> } — GET /api/mcp-endpoints lists them.` : 'No environment, so no MCP endpoint.' };
  const panel = {
    env, verdict: selected ? selected.verdict : null, tierLine, mcp,
    bindings: Object.entries(env?.bindings && typeof env.bindings === 'object' ? env.bindings : {}),
    links: httpLinks(env?.endpoints), pack,
    // The verdict is the conformance report only (design §4.3, D3): a saved
    // journey's drift runs are another thing, named here, read under Neuron.
    driftNote: 'Drift runs: Neuron (Advanced) keeps the saved journeys and their runs — not part of this verdict.',
  };
  const actions = [
    ...ACTIONS.map(([view, label]) => ({ view, label, enabled: true, reason: null })),
    { view: 'build', label: env ? `Build a pack for ${env.name}` : 'Build a pack', enabled: canWrite, reason: canWrite ? null : access.reason },
  ];
  const inCatalogue = new Set((Array.isArray(catalog) ? catalog : []).filter((p) => p && p.ok !== false).map((p) => p.id));
  const packs = (service.packs || []).map((p) => ({ id: p.id, label: p.label ?? null, source: p.source ?? null, role: p.role, current: resolved.pack !== null && p.id === resolved.pack.id, inCatalogue: inCatalogue.has(p.id) }));
  const role = access?.role ?? 'viewer';
  const noEnvironments = envs.length ? null : (canWrite
    ? { text: 'No environments yet. Register a pack that declares one — Build (its DEFINE environment becomes a row), a scan, a draft or an upload — and it appears here.', apiLine: `POST /api/services/${service.id}/environments { "name": "prod" }` }
    : { text: `No environments yet. An operator registers a pack that declares one (Build, a scan, a draft or an upload) — your role in ${org} is ${role}.`, apiLine: null });
  return {
    id: service.id, slug: service.slug, name: service.name, description: service.description ?? null,
    facts: { tierText: service.tier ? `${service.tier} (service)` : TIER_BY_PACK, ownersText: ownersText(service.owners), packsText: packsText(service.packs) },
    tabs, panel, actions, packs, canEdit: canWrite, noEnvironments,
  };
}

// ---------- the SERVICE chip, the empty Discover, the Build prefill ----------

// The OBSERVA bar's SERVICE chip resolves the active service key against the
// table: a record → a button back to its page (`record`); a key no record
// covers (the table unavailable, a derived-only service) → today's
// non-interactive label (`derived`, with the catalogue's label); nothing
// active → hidden (`none`).
export function serviceChipModel({ services = null, selected = null, derivedLabel = null } = {}) {
  if (!selected) return { kind: 'none', label: '', serviceId: null };
  const record = Array.isArray(services) ? services.find((s) => s.slug === selected) : null;
  if (record) return { kind: 'record', label: record.name, serviceId: record.id };
  if (derivedLabel) return { kind: 'derived', label: derivedLabel, serviceId: null };
  return { kind: 'none', label: '', serviceId: null };
}

// Discover opened from a service page with no pack: one sentence worded for
// the rank (design §5.4) — an operator is offered Build (DEFINE prefilled),
// a viewer is told who registers one. null without a service.
export function discoverEmptyNote({ service = null, env = null, access = null } = {}) {
  if (!service) return null;
  const where = `${service.name}${env ? ` (${env})` : ''}`;
  if (access?.canWrite === false) {
    return { text: `No pack for ${where} yet — an operator scans, drafts, uploads or builds one; you can read the catalogue packs on the home.`, build: false };
  }
  return { text: `No pack for ${where} yet — scan its repository, draft from its MCP, upload one, or Build one (the DEFINE step is prefilled).`, build: true };
}

// Build opened from a service page: DEFINE is prefilled from the record only
// when the draft is empty (no name typed, not seeded) — a draft in progress
// is never overwritten; `note` then says so when the fields differ. `patch`
// is what the controller assigns onto state.build (the origin id included).
export function buildPrefillFromService(build, service, env = null) {
  const owners = Array.isArray(service?.owners) ? service.owners.join(', ') : '';
  const patch = {
    name: service?.name ?? '', owners, tier: service?.tier ?? build?.tier ?? 'tier-2',
    environment: env ?? build?.environment ?? 'prod', serviceId: service?.id ?? null,
  };
  const empty = !build || ((build.name ?? '') === '' && !build.seeded);
  if (empty) return { apply: true, patch, note: null };
  const same = build.name === patch.name && build.owners === patch.owners && build.tier === patch.tier && build.environment === patch.environment;
  return {
    apply: false, patch,
    note: same ? null : `Your Build draft is kept — its DEFINE fields are as you left them; edit them to start from ${service?.name ?? 'the service'}.`,
  };
}

// ---------- the header SERVICE selector ----------

// `services` is the table (null when unavailable); `ownDerived` the
// controller's serviceCatalogue({ ownOnly: true }) ({ key, label, … } — never
// the examples' services); `current` the open pack's own service key when it
// is a catalogue pack (an example) matching no record, kept as one option.
export function servicesSelectModel(services, ownDerived = [], selected = null, { current = null } = {}) {
  const derived = Array.isArray(ownDerived) ? ownDerived : [];
  let options, extra;
  if (Array.isArray(services)) {
    options = [...services].sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((s) => ({ value: s.slug, label: s.name, serviceId: s.id, hasPack: Array.isArray(s.packs) && s.packs.length > 0 }));
    const covered = new Set(options.map((o) => o.value));
    extra = derived.filter((d) => !covered.has(d.key)).map((d) => ({ value: d.key, label: d.label }));
  } else {
    options = derived.map((d) => ({ value: d.key, label: d.label, serviceId: null, hasPack: true }));
    extra = [];
  }
  if (current && !options.some((o) => o.value === current) && !extra.some((o) => o.value === current)) {
    extra.push({ value: current, label: `${current} (catalogue pack)` });
  }
  const values = new Set([...options, ...extra].map((o) => o.value));
  return { options, extra, disabled: values.size === 0, value: selected && values.has(selected) ? selected : '' };
}

// ---------- Build's end ----------

/** "team-a, team-b" → ['team-a', 'team-b'] (commas or whitespace) — build-model.mjs parseOwners, spelled once more to keep this module import-free. */
const splitOwners = (text) => String(text || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

// After a library register: `row` is the service the registered pack's
// primary link landed on (found by the controller in GET /api/services), or
// null when none; `tableRead` false when that call failed (the pack IS
// registered — the hand-off goes on and says the row was not checked);
// `origin` the record DEFINE was prefilled from ({ id, name, slug }) or null
// (`originId` alone also serves). The patch writes tier and owners ONLY where
// the row has none, and NEVER onto a row that is not the origin: the register
// links by the name's slug, so a renamed record or an explicit slug lands the
// pack under another service — that service is named, nothing is written.
export function buildHandoffPlan(build, row, { originId = null, origin = null, tableRead = true } = {}) {
  const from = origin?.id ?? originId ?? null;
  const builtTier = build?.tier || null;
  const builtOwners = splitOwners(build?.owners);
  const env = build?.environment || 'prod';   // what the pack declares: a blank DEFINE field builds for prod (build-model.mjs instantiateBody)
  const plan = { row: row ? { id: row.id, name: row.name, slug: row.slug } : null, outcome: 'linked', patch: {}, mismatch: null, environment: 'none' };
  if (!tableRead) return finish({ ...plan, row: null, outcome: 'unchecked' });
  if (!row) return finish({ ...plan, outcome: 'no-row' });
  plan.environment = (row.environments || []).some((e) => e.name === env) ? 'linked' : 'missing';
  if (from !== null && row.id !== from) return finish({ ...plan, outcome: 'other-service' });
  if ((row.tier ?? null) === null && builtTier) plan.patch.tier = builtTier;
  if (!(Array.isArray(row.owners) && row.owners.length) && builtOwners.length) plan.patch.owners = builtOwners;
  if (row.tier != null && builtTier && row.tier !== builtTier) plan.mismatch = { record: row.tier, built: builtTier };
  plan.outcome = Object.keys(plan.patch).length ? 'written' : (plan.mismatch ? 'mismatch' : 'linked');
  return finish(plan);

  function finish(p) {
    // Said, not fixed, and in the product's words: no roadmap slice, no screen 6a does not have — the route is the way out (design A-4).
    const envNote = p.environment === 'missing' ? ` The environment ${env} is not one of ${row.name}'s — POST /api/services/${row.id}/environments { "name": "${env}" } adds it.` : '';
    const sentence = (changed = []) => {
      let s;
      switch (p.outcome) {
        case 'unchecked': s = ' The service row was not checked (the table did not refresh).'; break;
        case 'no-row': s = ' No service row was written (the pack has no primary service).'; break;
        case 'other-service': s = ` Registered under a new service ${row.slug} — ${origin?.name ?? `service ${from}`}${origin?.slug ? ` (${origin.slug})` : ''} was not linked: the pack's service name yields another slug, and a slug is fixed.${origin?.name ? ` Open ${origin.name} to compare.` : ''}`; break;
        case 'written': {
          const parts = [];
          if (changed.includes('tier') && p.patch.tier) parts.push(p.patch.tier);
          if (changed.includes('owners') && p.patch.owners) parts.push(`owners ${p.patch.owners.join(', ')}`);
          s = parts.length ? ` Service ${row.name} written: ${parts.join(', ')}.` : ` Service ${row.name} linked.`;
          break;
        }
        case 'mismatch': s = ` Service ${row.name} linked — it already says ${p.mismatch.record} (its tier grades the pack; the pack was built at ${p.mismatch.built}).`; break;
        default: s = ` Service ${row.name} linked.`;
      }
      return s + envNote;
    };
    return { ...p, sentence };
  }
}

// DEFINE's note when the name typed would register under another slug than
// the origin record's: `nameKey` is normalizeServiceKey(build.name),
// `originNameKey` normalizeServiceKey(origin.name) — both computed by the
// controller (the rule lives in /lib/service-keys.mjs, bound at boot).
// null when there is no origin or the keys agree; `useName` names the
// one-click fix only when the origin's current name still yields its slug.
export function buildDefineOriginNote({ origin = null, nameKey = null, originNameKey = null } = {}) {
  if (!origin?.slug || !nameKey || nameKey === origin.slug) return null;
  return {
    text: `This pack will register under a new service "${nameKey}", not ${origin.slug} — a slug is fixed. Keep a name that yields ${origin.slug}, or go on and get a second service.`,
    useName: originNameKey === origin.slug && origin.name ? origin.name : null,
  };
}

// ---------- the record editor ----------

// The editor's model over one record (design §6.5): the four fields as the
// dialog holds them — the record's values until typed (`draft` is what was
// typed: name, owners as text, tier, description) — the tier choices with
// "graded by the pack" for null, the limits the server applies (WAYS), the
// note under the name (a slug is fixed — WAYS.slugFixed — so no slug field),
// and the status line: `{ kind: 'idle' | 'pending' | 'saved' | 'error', text }`.
export function buildServiceEditorModel(service, { draft = null, status = null } = {}) {
  const d = draft || {};
  const name = typeof d.name === 'string' ? d.name : service.name;
  const owners = typeof d.owners === 'string' ? d.owners : (service.owners || []).join(', ');
  const tier = d.tier !== undefined ? (TIERS.includes(d.tier) ? d.tier : null) : (service.tier ?? null);
  const description = typeof d.description === 'string' ? d.description : (service.description ?? '');
  const st = status || { kind: 'idle', text: 'Name, owners, tier and description. The slug is fixed.' };
  return {
    id: service.id,
    slug: service.slug,
    title: `Edit ${service.name}`,
    fields: { name, owners, tier, description },
    limits: { name: 200, owners: 50, description: 4000 },
    tiers: [...TIERS.map((t) => ({ value: t, label: t, selected: tier === t })), { value: null, label: TIER_BY_PACK, selected: tier === null }],
    slugNote: `The slug ${service.slug} stays; packs link to it by slug — a renamed service still receives the packs that name ${service.slug}, and a Build from this page says when its name would land elsewhere.`,
    status: st,
    saving: st.kind === 'pending',
  };
}

// What the status line says after a PATCH answered: the fields the server
// names in `changed`, or that nothing differed (no call was made).
export function serviceSaveStatus(changed = []) {
  return changed.length ? { kind: 'saved', text: `Saved: ${changed.join(', ')}` } : { kind: 'idle', text: 'Nothing changed.' };
}

// The PATCH body: only the fields that differ from `current` (a ServiceView),
// parsed — owners text → array, tier → one of TIERS or null (the "graded by
// the pack" choice), an empty description → null. The slug is never here.
export function buildServicePatch(current, draft = {}) {
  const patch = {};
  if (typeof draft.name === 'string' && draft.name.trim() !== current.name) patch.name = draft.name.trim();
  if (draft.owners !== undefined) {
    const owners = Array.isArray(draft.owners) ? draft.owners.map((o) => String(o).trim()).filter(Boolean) : splitOwners(draft.owners);
    if (JSON.stringify(owners) !== JSON.stringify(current.owners || [])) patch.owners = owners;
  }
  if (draft.tier !== undefined) {
    const tier = TIERS.includes(draft.tier) ? draft.tier : null;
    if (tier !== (current.tier ?? null)) patch.tier = tier;
  }
  if (draft.description !== undefined) {
    const description = typeof draft.description === 'string' && draft.description.trim() ? draft.description.trim() : null;
    if (description !== (current.description ?? null)) patch.description = description;
  }
  return patch;
}

// ---------- a signed-in user with no org ----------

// `error` is the thrown denial of the boot's GET /api/packs (denied 'org').
export function buildNoOrgModel({ identity = null, error = null, chromeName = 'the studio' } = {}) {
  const login = identity?.user?.login || identity?.login || identity?.email || 'you';
  return {
    title: 'Signed in, but in no organisation yet',
    checked: `/api/packs as ${login}`,
    body: error?.message || '403: no org membership — ask an admin to add you',
    hint: `${chromeName} has no member screen yet; an admin adds you with POST /api/org/members.`,
    actions: [{ id: 'sign-out', label: 'Sign out' }],
  };
}

// ---------- refusals and keys ----------

// state.servicesStatus from a thrown error: the bundle's 501 is 'static'
// (silent), a guard's 403 `org` is 'denied', anything else 'error' with the
// text the loader built (`<status>: <sentence>`, never a raw body).
// Build's exit when the service page it was opened from cannot be landed on:
// the toast says what happened in the server's words and where the user ended
// up. A 404 is a deletion ("is gone"); any other refusal (a membership removed
// → 403, the API down) is not — the row still exists, so the sentence says it
// could not be opened instead of inventing a deletion.
export function buildExitRefusal(name, why) {
  const text = String(why || '');
  const verb = /^404\b/.test(text) ? 'is gone' : 'could not be opened';
  return `${name} ${verb} (${text}) — back to home instead.`;
}

export function servicesStatusOf(error) {
  if (error?.denied === 'no-backend') return { kind: 'static', error: null };
  if (error?.denied === 'org') return { kind: 'denied', error: error.message };
  return { kind: 'error', error: error?.message ? String(error.message) : 'no answer' };
}

// The studio's persisted snapshot is one login's in one org (STORE_PLAN §6.4).
export function persistedStateKey(login, org) { return `studioState.v2:${login || 'local'}:${org || 'default'}`; }
// The recently opened services, per org.
export function recentServicesKey(org) { return `studioRecentServices:${org || 'default'}`; }
