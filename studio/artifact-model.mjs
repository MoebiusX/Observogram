// studio/artifact-model.mjs
//
// Shared client-side artifact helpers used by Diagnose, Remediate, and the
// deploy modal. Keep identity and row expansion in one place so the counts the
// user sees in the plan match the rows they are asked to deploy.

function nonEmptyString(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || null;
}

export function prettyDiffKey(key) {
  const raw = String(key || '');
  // Behavioural identity keys are `kind::{identity-json}` with an optional
  // `#NN` occurrence ordinal (identityKeyOf + the diff's collision
  // suffixing); legacy keys were `family:<name>`. Split on `::` first so
  // the JSON payload survives intact.
  const m = /^([a-z0-9_]+)::(\{.*\})(#\d+)?$/i.exec(raw);
  const short = m ? m[2]
    : raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
  const ordinal = m?.[3] || '';
  if (/^\{.*\}$/.test(short)) {
    try {
      const parsed = JSON.parse(short);
      const label =
        parsed.id ? String(parsed.id) :
        parsed.record ? String(parsed.record) :
        parsed.slo ? `burn-rate alert: ${parsed.slo}` :
        parsed.severity ? `${String(parsed.severity).toUpperCase()} route` :
        parsed.product && parsed.signal ? `${parsed.product} · ${parsed.signal}` :
        parsed.signal && parsed.target ? `${parsed.signal}: ${parsed.target}` :
        parsed.name ? String(parsed.name) :
        parsed.job ? String(parsed.job) :
        parsed.ref ? String(parsed.ref) :
        parsed.trigger ? `on ${parsed.trigger}` :
        null;
      if (label !== null) return `${label}${ordinal}`;
    } catch (_) {}
  }
  // A behavioural key with no printable identity (e.g. the otel/baselines
  // singletons, `otel::{}`) reads better whole than as bare braces.
  return m ? raw : (short || raw);
}

export function artefactLabel(art, fallback = '-') {
  const title = nonEmptyString(art?.title);
  if (title) return title;
  const defines = nonEmptyString(art?.defines);
  if (defines) return defines.split('.').pop() || defines;
  const id = nonEmptyString(art?.id);
  if (id) return id;
  return fallback;
}

export function diffEntryLabel(entry) {
  const art = entry?.artefact || entry?.a || entry?.b;
  return artefactLabel(art, prettyDiffKey(entry?.key));
}

// Is this layered artefact part of the deployable Grafana surface, and if so
// what identity does the deploy manifest key it by? Mirrors
// tools/lib/compile.mjs::compileCatalog and catalogToDeployManifest below.
export function deploySurfaceForArtefact(art) {
  const id = String(art?.id || '').toUpperCase();
  const defines = String(art?.defines || '');

  if (/^SLO-/.test(id) || defines.startsWith('slos.')) {
    const identity = artefactLabel(art, defines.replace(/^slos\./, '') || null);
    return {
      deployable: !!identity,
      kind: 'rules',
      identity,
      deployRows: 2,
      deployLabel: '2 rule artefacts',
    };
  }

  if (/^QRY-/.test(id)) {
    const identity = artefactLabel(art, null);
    return {
      deployable: !!identity,
      kind: 'rules',
      identity,
      deployRows: 1,
      deployLabel: 'recording rule',
    };
  }

  if (/^DASH-/.test(id) || defines.startsWith('dashboards.')) {
    const identity = defines.replace(/^dashboards\./, '') || artefactLabel(art, null);
    return {
      deployable: !!identity,
      kind: 'dashboard',
      identity,
      deployRows: 1,
      deployLabel: 'dashboard',
    };
  }

  return { deployable: false, kind: null, identity: null, deployRows: 0, deployLabel: null };
}

export function deploySelectionFromEntries(entries, deselected = new Set()) {
  const identities = new Set();
  let rows = 0;
  for (const e of entries || []) {
    if (!e?.deployable || !e.identity || deselected.has(e.identity) || identities.has(e.identity)) continue;
    identities.add(e.identity);
    rows += e.deployRows || 1;
  }
  return { identities, rows };
}

// Map a compile catalog (groups -> items) to a flat manifest with per-row
// deploy semantics. Rules' per-SLO items expand into separate recording and
// alerting rows so the type filter and Remediate counts remain honest.
export function catalogToDeployManifest(catalog) {
  const out = [];
  for (const g of (catalog?.groups || [])) {
    const deployable = g.flavors?.some(f => f.deployable);
    if (g.id === 'rules') {
      for (const it of (g.items || [])) {
        if (it.kind === 'rules-slo') {
          out.push({
            key: `rules:recording:slo:${it.sloId}`,
            type: 'recording',
            name: `${it.label} (recording rules)`,
            id: it.sloId,
            group: 'rules',
            flavor: 'prometheus',
            artifact: `slo:${it.sloId}`,
            scope: 'recording',
            deployable,
            source: 'Repo',
          });
          out.push({
            key: `rules:alert:slo:${it.sloId}`,
            type: 'alert',
            name: `${it.label} (burn-rate alerts)`,
            id: it.sloId,
            group: 'rules',
            flavor: 'prometheus',
            artifact: `slo:${it.sloId}`,
            scope: 'alerting',
            deployable,
            source: 'Repo',
          });
        } else if (it.kind === 'rules-declared') {
          out.push({
            key: `rules:recording:declared:${it.ruleIndex}`,
            type: 'recording',
            name: it.label,
            id: it.ruleName || it.id,
            group: 'rules',
            flavor: 'prometheus',
            artifact: `declared:${it.ruleIndex}`,
            scope: 'recording',
            deployable,
            source: 'Repo',
          });
        }
      }
    } else if (g.id === 'dashboards') {
      for (const it of (g.items || [])) {
        if (it.kind !== 'dashboard') continue;
        out.push({
          key: `dashboards:${it.dashboardId}`,
          type: 'dashboard',
          name: it.label,
          id: it.dashboardId,
          subtitle: it.subtitle,
          group: 'dashboards',
          flavor: 'grafana',
          dashboardId: it.dashboardId,
          deployable,
          source: 'Repo',
        });
      }
    }
  }
  return out;
}
