// studio/clause-fixes.mjs — the specification's rules in plain words: for each rubric
// clause (tools/lib/conformance.mjs RUBRIC) why it is not met and what to do about it.
// Zero-import, browser-safe: Expert's Conformance (studio/conformance-view.mjs) and the
// board's Remediate (studio/overview-model.mjs rulesModel) read the same words.
//
// UI copy only — the verdict stays the engine's; an id not listed here
// falls back to the clause's own description and its layer.
export const CLAUSE_FIX = {
  'L1.MUST.availability_slo':             { reason: 'No availability SLO',                                   action: 'Add an availability SLO on a ratio SLI' },
  'L1.MUST.latency_slo':                  { reason: 'No latency SLO',                                        action: 'Add a latency SLO on a threshold or distribution SLI' },
  'L1.SHOULD.domain_slo':                 { reason: 'Fewer than four SLOs',                                  action: 'Add a domain-specific SLO' },
  'L1.MUST.sli_covered_by_slo':           { reason: 'An SLI has no SLO',                                     action: 'Give every SLI an SLO, or remove the unused SLI' },
  'L2.MUST.otlp_receiver':                { reason: 'No OTLP receiver in the collector pipeline',            action: 'Add an otlp receiver' },
  'L2.MUST.service_name_required':        { reason: 'service.name is not a required resource attribute',     action: 'Require service.name' },
  'L2.MUST.semconv_floor':                { reason: 'Semantic conventions older than 1.26.0',                action: 'Raise otel.semconv to 1.26.0 or later' },
  'L2.MUST.semconv_current':              { reason: 'Semantic conventions not at 1.27.0',                    action: 'Set otel.semconv to 1.27.0' },
  'L2.MUST.resource_attrs_5plus':         { reason: 'Fewer than five required resource attributes',          action: 'Require at least five resource attributes' },
  'L2.MUST.log_correlation':              { reason: 'Trace IDs are not injected into logs',                  action: 'Turn on otel.sdk.log_correlation' },
  'L2.MUST.metrics_exporter':             { reason: 'The pipeline exports no metrics',                       action: 'Add a metrics exporter' },
  'L2.MUST.logs_and_traces_exporters':    { reason: 'Logs or traces are not exported',                       action: 'Add logs and traces exporters' },
  'L2.MUST.tail_sampling':                { reason: 'No tail sampling',                                      action: 'Add a tail_sampling processor' },
  'L2.MUST.metrics_logs_traces_backends': { reason: 'Backends do not cover metrics, logs and traces',        action: 'Declare a backend for each signal' },
  'L2.SHOULD.backend_gating_enforce':     { reason: 'No backend pins a minimum version',                     action: 'Pin a minimum version with gating' },
  'L2X.MUST.extended_backend_refs_resolve': { reason: 'An extended surface names an undeclared backend',     action: 'Point each extended surface at a declared backend or an explicit ref: reference' },
  'L3.MUST.recording_rule_per_slo':       { reason: 'An SLO has no recording rule',                          action: 'Add a recording rule for each SLO' },
  'L3.SHOULD.derived_view':               { reason: 'No derived view',                                       action: 'Add a derived view (golden signals or a rollup)' },
  'L3.MUST.service_overview_dashboard':   { reason: 'No dashboard',                                          action: 'Add a service overview dashboard' },
  'L3.MUST.slo_burn_dashboard':           { reason: 'No SLO burn dashboard',                                 action: 'Add an SLO burn dashboard' },
  'L3.MUST.tier1_dashboards':             { reason: 'Fewer than four dashboards',                            action: 'Add deployment-overlay and customer-impact dashboards' },
  'L4.MUST.multi_window_burn_rate':       { reason: 'An SLO lacks a multi-window burn-rate alert',           action: 'Add a multi-window burn-rate alert for each SLO' },
  'L4.SHOULD.forecast_on_availability':   { reason: 'No forecast on availability',                           action: 'Add a forecast on the availability SLO' },
  'L4.MUST.tier1_voice_route':            { reason: 'L4 alert routing: the SEV1 route has no voice channel', action: 'Add a voice channel to the SEV1 route' },
  'L4.MUST.tier1_at_least_one_automation':{ reason: 'No self-healing remediation',                           action: 'Declare a remediation' },
  'L5.SHOULD.tier1_release_gate':         { reason: 'The regression gate does not block releases',           action: 'Set the regression gate to block releases' },
  'L5.MUST.synthetic_probe':              { reason: 'No synthetic check',                                    action: 'Add a synthetic check' },
  'L5.MUST.tier1_chaos_for_each_slo':     { reason: 'An SLO has no chaos experiment',                        action: 'Add a chaos experiment for each SLO' },
  'L5.MUST.tier2_chaos_staging':          { reason: 'No regular chaos experiment in staging',                action: 'Schedule a monthly (or more frequent) chaos experiment in staging' },
  'L5.MUST.tier1_weekly_prod_chaos':      { reason: 'No weekly production chaos with instrumented probes',   action: 'Schedule weekly production chaos with OTel-instrumented probes' },
};
