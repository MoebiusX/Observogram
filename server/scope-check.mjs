// server/scope-check.mjs — what a live scope would leave out, before it is saved
// (POST /api/services/:id/scope-check, server/routes/services.mjs).
//
// A scope typed for a service's environment narrows what its Run reads live.
// Two mistakes are cheap to make and expensive to find: a rule group the live
// folders do not hold (the Run then compares none of that service's rules), and
// a scope that leaves every artefact of a declared family outside (the Run then
// compares none of them). This module answers both from what the server already
// keeps — never a call to an MCP:
//   declared  the environment's last scan (its check's Pack A), else the
//             service's own pack: per family the scope narrows, how many of its
//             declared artefacts are inside, outside, or do not say
//             (tools/lib/live-fetch.mjs inScope, the diff's own test)
//   live      the live pack the environment's last Run kept: the rule groups it
//             listed (mcp.discovered.rule_groups, recorded before a rule-group
//             scope narrowed them), and the scope's rule groups not among them —
//             none said missing when the read listed more groups than it kept
//             (mcp.discovered.rule_groups_count): one not kept may be there
// An artefact the repository files under a folder TITLE (a provisioning
// file's rule, a provisioned dashboard) whose title the live read did not give
// for the scope's folder uids is not known to be inside: counted apart
// (`byTitle`, with the titles), so the form never says it names no folder.
// Pure over canonicals: the route resolves the packs (server/index.mjs).

import { adapt } from '../tools/lib/adapter.mjs';
import { classify } from '../tools/lib/artefact-model.mjs';
import { scopeAnnotations, scopeOf, inScope, folderUidOf, folderTitleOf, LIVE_SCOPE_ANNOTATION } from '../tools/lib/live-fetch.mjs';

const TITLES_SHOWN = 5;

const RULE_FAMILIES = Object.freeze(['alert_rule', 'recording_rule']);

// The families each field of a scope narrows, every one applied (the check asks
// what the scope WOULD leave out, whatever a live answer turns out to name).
function familiesOf(scope) {
  const out = [];
  if ((scope.metricPrefixes || []).length || (scope.metricExclude || []).length) out.push('metric');
  if ((scope.folderUids || []).length) out.push('dashboard');
  if ((scope.folderUids || []).length || (scope.ruleGroups || []).length) out.push(...RULE_FAMILIES);
  return out;
}

const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

// The folder titles a live read named for folder uids: its scope's entries, and
// the rule groups it recorded (a Grafana ruler is keyed by folder title).
function learnedTitles(annotations) {
  const out = {};
  for (const [key, value] of Object.entries(annotations || {})) {
    if (!key.startsWith('observogram.scope.')) continue;
    const entry = parse(value);
    for (const v of Array.isArray(entry?.values) ? entry.values : []) {
      if (v && typeof v.uid === 'string' && typeof v.title === 'string' && v.title && !out[v.uid]) out[v.uid] = v.title;
    }
  }
  const groups = parse(annotations?.['mcp.discovered.rule_groups']);
  for (const g of Array.isArray(groups) ? groups : []) {
    if (g && typeof g.folderUid === 'string' && typeof g.folder === 'string' && g.folder && !out[g.folderUid]) out[g.folderUid] = g.folder;
  }
  return out;
}

/**
 * The answer for `scope` (normalised, compact) in environment `envName`:
 *   { declared: { packId, label, families: [{ family, declared, inside, outside, unknown,
 *       byTitle?, titles?, untitledFolders? }] } | null,
 *     live: { packId, label, readAt, folders, ruleGroups, ruleGroupsKept, foldersNotRead, missingGroups } | null }
 * `byTitle`: of `unknown`, those filed under a folder title the live read gave for none of the
 * scope's folders (`titles`, the first five; `untitledFolders`, the scope's folder uids it gave no
 * title of). `ruleGroupsKept`: { kept, of } when the read listed more rule groups than it kept
 * (`missingGroups` is null then), else null.
 * `declared` / `live`: { packId, label, canonical } (live: and `refreshedAt`), or null.
 */
export function scopeCheckAnswer({ scope, declared = null, live = null }) {
  const s = scope && typeof scope === 'object' ? scope : {};
  const liveAnnotations = live?.canonical?.metadata?.annotations || {};
  const kinds = familiesOf(s);
  const entries = scopeOf(scopeAnnotations(s, {
    applied: ['metric', 'dashboard', ...RULE_FAMILIES],
    appliedGroups: [...RULE_FAMILIES],
    folderTitles: learnedTitles(liveAnnotations),
  }));
  let declaredOut = null;
  if (declared?.canonical) {
    let layered;
    try { layered = adapt(declared.canonical); } catch { layered = null; }
    const artefacts = layered ? [
      ...layered.layers.L1, ...layered.layers.L2, ...layered.layers.L2X, ...layered.layers.L3,
      ...layered.layers.L4.policy, ...layered.layers.L4.alerting, ...layered.layers.L4.healing, ...layered.layers.L5,
    ].filter((a) => a && a.source !== 'Scaffold') : [];
    declaredOut = {
      packId: declared.packId ?? null, label: declared.label ?? null,
      families: kinds.map((family) => {
        const mine = artefacts.filter((a) => classify(a) === family);
        const entry = entries.get(family);
        const verdicts = mine.map((a) => inScope(family, a, entry));
        const out = { family, declared: mine.length, inside: verdicts.filter((v) => v === true).length, outside: verdicts.filter((v) => v === false).length, unknown: verdicts.filter((v) => v === null).length };
        // Not known for its folder TITLE alone: the title is stated, the live read named none it matches.
        const titled = entry?.by === 'folder'
          ? mine.filter((a, i) => verdicts[i] === null && folderUidOf(a) === null && folderTitleOf(a) !== null && inScope(family, a, { by: 'folder', values: entry.values }) === null)
          : [];
        if (titled.length) {
          out.byTitle = titled.length;
          out.titles = [...new Set(titled.map((a) => folderTitleOf(a)))].slice(0, TITLES_SHOWN);
          out.untitledFolders = entry.values.filter((v) => v.title === null).map((v) => v.uid);
        }
        return out;
      }),
    };
  }
  let liveOut = null;
  if (live?.canonical) {
    const said = parse(liveAnnotations[LIVE_SCOPE_ANNOTATION]);
    const readFolders = Array.isArray(said?.folderUids) && said.folderUids.length ? said.folderUids.filter((u) => typeof u === 'string') : null;
    const wanted = s.folderUids || [];
    const foldersNotRead = readFolders && wanted.length ? wanted.filter((u) => !readFolders.includes(u)) : [];
    const recorded = parse(liveAnnotations['mcp.discovered.rule_groups']);
    const ruleGroups = Array.isArray(recorded)
      ? [...new Set(recorded.filter((g) => g && typeof g.group === 'string' && (!wanted.length || !g.folderUid || wanted.includes(g.folderUid))).map((g) => g.group))].sort()
      : null;
    // The read listed more rule groups than its record keeps (the fetcher keeps the first 500): a group
    // not among those kept is not known to be missing.
    const listedCount = Number(liveAnnotations['mcp.discovered.rule_groups_count']);
    const ruleGroupsKept = Array.isArray(recorded) && Number.isInteger(listedCount) && listedCount > recorded.length ? { kept: recorded.length, of: listedCount } : null;
    const askedGroups = s.ruleGroups || [];
    liveOut = {
      packId: live.packId ?? null, label: live.label ?? null,
      readAt: live.refreshedAt ?? liveAnnotations['mcp.refreshedAt'] ?? null,
      folders: readFolders,
      ruleGroups,
      ruleGroupsKept,
      foldersNotRead,
      missingGroups: ruleGroups === null || foldersNotRead.length || ruleGroupsKept ? null : askedGroups.filter((g) => !ruleGroups.includes(g)),
    };
  }
  return { declared: declaredOut, live: liveOut };
}
