// tools/lib/alert-routes.mjs
//
// Alertmanager configuration -> spec.alerting.routes.
//
// One reading of an Alertmanager config for both ways it reaches us: the
// file a repository ships (tools/lib/crawler.mjs) and the configuration a
// running Alertmanager reports through its status API
// (tools/fetch-live-pack.mjs). The same config must give the same routes,
// or a repo scan and its own live deployment compare as different.
//
// Pure ESM, no Node APIs.

import { REDACTED_CHANNEL_VALUE, UNRESOLVED_CHANNEL_PREFIX, isWithheldValue } from './artefact-model.mjs';

// What a running Alertmanager prints in place of a secret (webhook URLs,
// API keys): the value exists, and it will not say what it is.
const ALERTMANAGER_SECRET = '<secret>';

// The values written in place of an address the source does not state are
// the behavioural model's (artefact-model.mjs): URI-shaped, so a webhook
// carrying one still validates, and read by the model as "a channel of
// this kind exists, address not stated" — never as an address that differs.
export { REDACTED_CHANNEL_VALUE, UNRESOLVED_CHANNEL_PREFIX };

export function isRedactedChannelValue(value) {
  return value === ALERTMANAGER_SECRET || isWithheldValue(value);
}

// Does this channel value carry an unresolved deploy-time placeholder
// (${VAR}) AND fail the spec's URI shape? Embedded placeholders inside an
// otherwise URI-shaped value (https://ntfy.sh/${TOPIC}?…) still parse as a
// webhook target and stay declared as written. A value that is ONLY a
// placeholder has no scheme and cannot pass `format: uri`, so it is never
// written into the pack as an address: the channel is declared with
// `unresolved:<VAR>` in its place (unresolvedChannelValue) and the
// placeholder is recorded as evidence. The reader never emits a pack that
// fails its own schema, and never invents an address.
const CHANNEL_URI_RE = /^[a-z][a-z0-9+.-]*:\S+$/i;   // mirrors validator.mjs URI_RE
export function isUnresolvedChannelValue(value) {
  const v = String(value || '');
  return v.includes('${') && !CHANNEL_URI_RE.test(v);
}

/** `${WEBHOOK_URL}` → `unresolved:WEBHOOK_URL`: the variable the address comes from. */
export function unresolvedChannelValue(value) {
  const name = /\$\{\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(String(value || ''))?.[1];
  return `${UNRESOLVED_CHANNEL_PREFIX}${name || 'placeholder'}`;
}

// Map Prometheus / Alertmanager severity labels to the spec's severity
// enum: SEV1 (critical) / SEV2 (warning) / SEV3 (info) / SEV4 (debug).
// If the input already matches SEV1..SEV4, pass through. Common
// Prometheus conventions map as below.
export function normalizeSeverity(s) {
  if (!s) return 'SEV2';
  const up = String(s).toUpperCase();
  if (/^SEV[1234]$/.test(up)) return up;
  if (/^(CRITICAL|FATAL|EMERGENCY|PAGE)$/.test(up)) return 'SEV1';
  if (/^(WARNING|ERROR|MAJOR|HIGH)$/.test(up))      return 'SEV2';
  if (/^(INFO|NOTICE|MINOR|LOW)$/.test(up))         return 'SEV3';
  if (/^(DEBUG|TRACE)$/.test(up))                   return 'SEV4';
  return 'SEV2';
}

export function receiverChannels(recv, unresolved = [], ctx = {}) {
  // Spec Channel allows only: msteams, voice, whatsapp, email, webhook.
  // Map Alertmanager's broader vocabulary onto that closed set; flag
  // anything we couldn't map as a webhook with a placeholder URL.
  // A webhook whose URL the source does not state keeps its channel: one
  // the source redacted carries the redaction marker, one that is only a
  // ${VAR} placeholder carries `unresolved:<VAR>` and is recorded for the
  // evidence annotation (see isUnresolvedChannelValue). Leaving the channel
  // out instead made a route the repository declares read "not declared"
  // beside the same route on the running Alertmanager.
  const out = [];
  const webhook = (url, fallback) => {
    const v = url || fallback;
    if (isRedactedChannelValue(v)) {
      out.push({ webhook: isWithheldValue(v) ? v : REDACTED_CHANNEL_VALUE });
      return;
    }
    if (isUnresolvedChannelValue(v)) {
      unresolved.push({ receiver: recv.name || null, severity: ctx.severity || null, value: String(v), source: ctx.source || null });
      out.push({ webhook: unresolvedChannelValue(v) });
      return;
    }
    out.push({ webhook: v });
  };
  if (Array.isArray(recv.email_configs))     out.push(...recv.email_configs.map(c => ({ email: c.to || `oncall@${recv.name || 'example'}.com` })));
  if (Array.isArray(recv.msteams_configs))   out.push(...recv.msteams_configs.map(c => ({ msteams: c.channel_url || `#${recv.name || 'oncall'}` })));
  if (Array.isArray(recv.webhook_configs))   for (const c of recv.webhook_configs) webhook(c.url, 'https://hooks.example.com/oncall');
  if (Array.isArray(recv.pagerduty_configs)) out.push({ voice: `pagerduty:${recv.name || 'oncall'}` });
  if (Array.isArray(recv.slack_configs))     for (const c of recv.slack_configs) webhook(c.api_url, `https://hooks.slack.example.com/${c.channel || 'oncall'}`);
  return out;
}

function walkRoute(route, out, receivers, unresolved, source) {
  const sev = route.match?.severity || route.match_re?.severity || route.matchers?.find?.(m => /severity/i.test(m))?.split('=')?.[1]?.replace(/"/g, '');
  const recvName = route.receiver;
  const recv = receivers.find(r => r.name === recvName);
  const channels = recv ? receiverChannels(recv, unresolved, { severity: normalizeSeverity(sev), source }) : [];
  if (channels.length) {
    out.push({ severity: normalizeSeverity(sev), channels });
  } else if (sev || recvName) {
    // Receiver kinds we can't map → keep the route on a synthetic Teams
    // placeholder (long-standing behaviour for unmapped receivers).
    out.push({ severity: normalizeSeverity(sev), channels: [{ msteams: `#${recvName || 'oncall'}` }] });
  }
  for (const child of route.routes || []) walkRoute(child, out, receivers, unresolved, source);
}

/**
 * The routes an Alertmanager config declares: the top-level route and its
 * children, one entry per route node that resolves to at least one channel.
 * `config` is the parsed document ({ route, receivers }); `unresolved`
 * collects the channels whose address is a deploy-time placeholder;
 * `source` names where the config came from, for that evidence.
 */
export function routesFromAlertmanagerConfig(config, { unresolved = [], source = null } = {}) {
  if (!config?.route) return [];
  const out = [];
  walkRoute(config.route, out, Array.isArray(config.receivers) ? config.receivers : [], unresolved, source);
  return out;
}
