// gen-site test fixture module: the smallest module that exercises every core seam
// (params schema, exact-count substitutions, a template, a per-queue-manager template,
// a self-check). No boards. See tools/lib/site/run.mjs for the contract.

export const paramsSchema = {
  site: {
    type: 'object',
    required: ['queue_pattern'],
    additionalProperties: false,
    properties: {
      queue_pattern: { type: 'string', minLength: 1 },
      monitoring_host: { type: 'string', minLength: 1 },
      exporter_poll_interval: { type: 'string', pattern: '^[0-9]+(ms|s|m|h)$' },
      canary_interval: { type: 'string', pattern: '^[0-9]+(ms|s|m|h)$' },
    },
  },
  host: { type: 'object', additionalProperties: false, properties: {} },
  instance: {
    type: 'object',
    additionalProperties: false,
    properties: {
      native_port: { type: 'integer', minimum: 1, maximum: 65535 },
      client_port: { type: 'integer', minimum: 1, maximum: 65535 },
    },
  },
};

export function packSubstitutions(ctx) {
  const { dur } = ctx.timing;
  return [
    { name: 'queue pattern', find: 'queue=~"APP.*"', replace: `queue=~"${ctx.p.queue_pattern}"`, count: 1 },
    { name: 'window3', find: '[30s]', replace: `[${dur(ctx.timing.window3)}]`, count: 2 },
    { name: 'pipeline scrape_interval', find: 'scrape_interval: 10s', replace: `scrape_interval: ${dur(ctx.timing.step)}`, count: 1 },
    { name: 'recording interval', find: 'interval: 10s }', replace: `interval: ${dur(ctx.timing.interval)} }`, count: 2 },
    { name: 'chaos environment', find: 'environment: lab', replace: `environment: ${ctx.env}`, count: 1 },
  ];
}

export function packRemovals() { return []; }

export function templates(ctx) {
  const t = ctx.timing;
  return {
    'prometheus/prometheus.yml': [
      `# rendered by the fixture module for ${ctx.env}`,
      'global:',
      `  scrape_interval: ${t.dur(t.step)}`,
      `  evaluation_interval: ${t.dur(t.interval)}`,
      `  external_labels: { environment: ${ctx.env} }`,
      '',
    ].join('\n'),
    'alertmanager/alertmanager.yml': (c) => [
      `global: { resolve_timeout: ${c.timing.alertmanager.resolve_timeout} }`,
      `route: { group_wait: ${c.timing.alertmanager.group_wait}, group_interval: ${c.timing.alertmanager.group_interval}, repeat_interval: ${c.timing.alertmanager.repeat_interval} }`,
      '',
    ].join('\n'),
  };
}

export function perQmgr(ctx, qm) {
  return {
    [`qmgrs/${qm.name}/exporter.yaml`]: `queueManager: ${qm.name}\nconnName: ${qm.address.host}(${qm.address.port})\npollInterval: ${ctx.timing.dur(ctx.timing.poll)}\nenv: ${ctx.env}\nport: ${qm.params.client_port}\n`,
  };
}

export function harness(ctx) { return { vantage: ctx.vantage, probe: ctx.timing.probe }; }

export function checks(ctx, files) {
  const errors = [];
  for (const qm of ctx.qmgrs) if (!files.some(f => f.path === `qmgrs/${qm.name}/exporter.yaml`)) errors.push(`no exporter file for ${qm.name}`);
  return errors;
}
