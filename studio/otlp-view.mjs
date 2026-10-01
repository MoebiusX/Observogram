// studio/otlp-view.mjs
//
// The OTLP coverage view (Advanced, spec §3) — "what OTLP-shaped wire does
// this pack run on?": receiver analysis, a per-signal in/out matrix, the SDK
// contract, and a summary. Reads from the canonical pack (fetched once,
// cached under state._otlpCanonical). Self-contained — no orchestrator calls.

import { state } from './state.mjs';
import { focusedPack, focusedPackId, focusedEnv, effectiveFocus } from './focus.mjs';
import { escapeHtml } from './util.mjs';

const OTLP_SIGNALS = ['traces', 'metrics', 'logs', 'profiles'];
const OTLP_EXPORTER_KINDS = new Set(['otlp', 'otlphttp', 'otlp-grpc', 'otlp-http']);

export function renderOtlpView(host) {
  const pack    = focusedPack();
  const packId  = focusedPackId();
  const env     = focusedEnv() || pack?.meta?.environment;
  if (!pack) {
    host.innerHTML = '<div class="placeholder">No pack loaded.</div>';
    return;
  }

  const wrap = document.createElement('section');
  wrap.className = 'section otlp-view';
  wrap.dataset.layer = 'OTLP';
  wrap.dataset.focus = effectiveFocus();
  host.appendChild(wrap);

  const focusBadge = state.packB ? ` · pack ${effectiveFocus().toUpperCase()} (${escapeHtml(pack?.id || '')})` : '';
  const head = document.createElement('div');
  head.className = 'section-head';
  head.innerHTML = `
    <span class="section-num">OTLP</span>
    <span class="section-name">Wire coverage · OpenTelemetry Protocol${focusBadge}</span>
    <span class="section-count">${escapeHtml(pack?.meta?.binding || 'unknown binding')}</span>
  `;
  wrap.appendChild(head);

  // Loading placeholder while the canonical lands.
  const body = document.createElement('div');
  body.className = 'otlp-body';
  body.innerHTML = '<div class="placeholder">loading canonical manifest…</div>';
  wrap.appendChild(body);

  const cacheKey = `${packId}::${env || ''}`;
  state._otlpCanonical = state._otlpCanonical || {};
  const apply = (canonical) => renderOtlpBody(body, canonical, pack);
  if (state._otlpCanonical[cacheKey]) { apply(state._otlpCanonical[cacheKey]); return; }
  const envQ = env ? `?env=${encodeURIComponent(env)}` : '';
  fetch(`/api/packs/${encodeURIComponent(packId)}/canonical${envQ}`, {
    headers: { Accept: 'application/json' },
  }).then(async r => {
    if (!r.ok) throw new Error(`server ${r.status}`);
    const c = await r.json();
    state._otlpCanonical[cacheKey] = c;
    apply(c);
  }).catch(e => {
    body.innerHTML = `<div class="placeholder">Failed to load canonical: ${escapeHtml(e.message)}</div>`;
  });
}

function renderOtlpBody(host, canonical, layered) {
  host.innerHTML = '';
  const spec = canonical?.spec || {};
  const pipelines = spec.pipelines || {};
  const otel = spec.otel || {};
  const sdk = otel.sdk || {};
  const ra  = otel.resource_attributes || {};

  // --- Receiver analysis ---
  const receivers = Array.isArray(pipelines.receivers) ? pipelines.receivers : [];
  const otlpReceiver = receivers.find(r => /^otlp(http)?$/i.test(r?.name || ''));
  const hasOtlpReceiver = !!otlpReceiver;
  const otherReceivers = receivers.filter(r => r !== otlpReceiver).map(r => r?.name).filter(Boolean);
  const protocols = Array.isArray(otlpReceiver?.protocols) ? otlpReceiver.protocols : [];
  const hasGrpc = protocols.some(p => /grpc/i.test(p));
  const hasHttp = protocols.some(p => /http/i.test(p));
  const endpoint = otlpReceiver?.endpoint || '—';

  // --- Per-signal coverage ---
  const exporters = pipelines.exporters || {};
  const signals = OTLP_SIGNALS.map(sig => {
    const exporter = exporters[sig];
    const exporterKind = exporter?.kind || (sig === 'profiles' ? null : null);
    const exporterEndpoint = exporter?.endpoint || null;
    const exporterIsOtlp = exporter ? OTLP_EXPORTER_KINDS.has(String(exporterKind).toLowerCase()) : false;

    // For profiles we look at spec.profiling — the spec doesn't put
    // profiles in pipelines.exporters today.
    let profilingNote = null;
    if (sig === 'profiles' && spec.profiling) {
      profilingNote = `${spec.profiling.product || 'profiling backend'} native`;
    }

    // OTLP receiver in spec carries every signal by default; we mark
    // "in" as ● when the receiver is present, ○ when it isn't.
    return {
      sig,
      receiverIn: hasOtlpReceiver,
      exporter,
      exporterKind: exporterKind || (profilingNote || null),
      exporterEndpoint,
      exporterIsOtlp,
      profilingNote,
    };
  });
  const endToEndOtlpCount = signals.filter(s => s.receiverIn && s.exporterIsOtlp).length;
  const wiredCount = signals.filter(s => s.exporter || s.profilingNote).length;

  // --- Render ---
  const sdLangs = Array.isArray(sdk.languages) ? sdk.languages.join(', ') : '—';
  const sdSampling = sdk.sampling
    ? `${sdk.sampling.policy || ''} ${sdk.sampling.ratio != null ? `(ratio ${sdk.sampling.ratio})` : ''}`.trim()
    : '—';
  const sdProps = Array.isArray(sdk.propagators) ? sdk.propagators.join(', ') : '—';
  const raReq  = Array.isArray(ra.required) ? ra.required.join(', ') : '—';
  const raCustom = Array.isArray(ra.custom) ? ra.custom.join(', ') : null;

  host.innerHTML = `
    <div class="otlp-block otlp-block-receiver">
      <div class="otlp-block-head">Receiver</div>
      <div class="otlp-receiver-status ${hasOtlpReceiver ? 'is-pass' : 'is-fail'}">
        <span class="otlp-pip">${hasOtlpReceiver ? '✓' : '✗'}</span>
        <span class="otlp-receiver-msg">
          ${hasOtlpReceiver
            ? `<strong>otlp</strong> receiver declared <em>(spec MUST)</em>`
            : `<strong>otlp receiver missing</strong> — spec MUST violation`}
        </span>
      </div>
      <div class="otlp-receiver-grid">
        <div class="otlp-receiver-row">
          <span class="otlp-receiver-key">Protocols</span>
          <span class="otlp-receiver-val">
            ${hasGrpc ? '<span class="otlp-proto-chip is-on">● gRPC</span>' : '<span class="otlp-proto-chip">○ gRPC</span>'}
            ${hasHttp ? '<span class="otlp-proto-chip is-on">● HTTP</span>' : '<span class="otlp-proto-chip">○ HTTP</span>'}
          </span>
        </div>
        <div class="otlp-receiver-row">
          <span class="otlp-receiver-key">Endpoint</span>
          <span class="otlp-receiver-val"><code>${escapeHtml(String(endpoint))}</code></span>
        </div>
        ${otherReceivers.length ? `
          <div class="otlp-receiver-row">
            <span class="otlp-receiver-key">Side-channel receivers</span>
            <span class="otlp-receiver-val">${otherReceivers.map(n => `<code>${escapeHtml(n)}</code>`).join(' · ')}</span>
          </div>` : ''}
      </div>
    </div>

    <div class="otlp-block otlp-block-matrix">
      <div class="otlp-block-head">Per-signal coverage</div>
      <table class="otlp-matrix">
        <thead>
          <tr>
            <th>Signal</th>
            <th>Receiver (in)</th>
            <th>Exporter (out)</th>
            <th>End-to-end OTLP</th>
          </tr>
        </thead>
        <tbody>
          ${signals.map(s => `
            <tr data-signal="${escapeHtml(s.sig)}">
              <td class="otlp-sig-name">${escapeHtml(s.sig)}</td>
              <td>${s.receiverIn ? '<span class="otlp-cell is-otlp">● OTLP</span>' : '<span class="otlp-cell is-off">○ not received</span>'}</td>
              <td>
                ${s.exporter
                  ? `<span class="otlp-cell ${s.exporterIsOtlp ? 'is-otlp' : 'is-native'}">${s.exporterIsOtlp ? '●' : '○'} ${escapeHtml(String(s.exporterKind))}</span>${s.exporterEndpoint ? ` <code class="otlp-endpoint">${escapeHtml(s.exporterEndpoint)}</code>` : ''}`
                  : s.profilingNote
                    ? `<span class="otlp-cell is-native">○ ${escapeHtml(s.profilingNote)}</span>`
                    : '<span class="otlp-cell is-off">— not declared</span>'}
              </td>
              <td>${s.receiverIn && s.exporterIsOtlp ? '<span class="otlp-e2e is-pass">✓</span>' : '<span class="otlp-e2e is-warn">○</span>'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div class="otlp-matrix-legend">
        ● OTLP-shaped wire · ○ non-OTLP native or absent · — not declared in spec
      </div>
    </div>

    <div class="otlp-block otlp-block-sdk">
      <div class="otlp-block-head">SDK contract</div>
      <dl class="otlp-sdk-grid">
        <div><dt>Semantic conventions</dt><dd><code>${escapeHtml(otel.semconv || '—')}</code></dd></div>
        <div><dt>Propagators</dt><dd><code>${escapeHtml(sdProps)}</code></dd></div>
        <div><dt>Languages</dt><dd><code>${escapeHtml(sdLangs)}</code></dd></div>
        <div><dt>Sampling</dt><dd><code>${escapeHtml(sdSampling)}</code></dd></div>
        <div><dt>Log ↔ Trace correlation</dt><dd>${otel.log_correlation === true ? '✓' : otel.log_correlation === false ? '✗' : '—'}</dd></div>
        <div><dt>Resource attrs (required)</dt><dd><code>${escapeHtml(raReq)}</code></dd></div>
        ${raCustom ? `<div><dt>Resource attrs (custom)</dt><dd><code>${escapeHtml(raCustom)}</code></dd></div>` : ''}
      </dl>
    </div>

    <div class="otlp-block otlp-block-summary">
      <div class="otlp-summary-row">
        <div class="otlp-summary-key">Signals wired</div>
        <div class="otlp-summary-val">${wiredCount} of ${OTLP_SIGNALS.length}</div>
      </div>
      <div class="otlp-summary-row">
        <div class="otlp-summary-key">End-to-end OTLP</div>
        <div class="otlp-summary-val">${endToEndOtlpCount} of ${OTLP_SIGNALS.length}</div>
      </div>
      <div class="otlp-summary-row">
        <div class="otlp-summary-key">Receiver MUST</div>
        <div class="otlp-summary-val">${hasOtlpReceiver ? 'pass' : 'fail'}</div>
      </div>
      <div class="otlp-summary-note">
        Spec v1.3 §3 — every pack <strong>MUST</strong> declare an <code>otlp</code> receiver.
        The OTLP-out column is informational: many production stacks intentionally use
        native protocols downstream (Prometheus remote-write, Loki native, Tempo OTLP)
        for backend efficiency.
      </div>
    </div>
  `;
}
