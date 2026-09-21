// gen-site test fixture module: the smallest module that exercises every core seam
// (instance descriptor, params schema, product inventory rules, expected kinds, exact-count
// substitutions, a template, a per-instance template, a self-check). No boards. See
// tools/lib/site/run.mjs for the contract. It calls its instances queue managers — the shape
// the first real module (mq-observability-pack) has — so the fixtures and the messages the
// suite asserts read like a real fleet.

const list = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const instances = {
  key: 'queue_managers',
  kind: 'qmgr',
  label: 'qmgr',
  title: 'queue manager',
  schema: {
    required: ['shape'],
    properties: { shape: { type: 'string', enum: ['container', 'host', 'multi-instance', 'rdqm-ha', 'rdqm-dr'] } },
  },
};

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

// The product's inventory rules (what used to sit in the core): an rdqm-ha queue manager needs
// three hosts and a floating address; a dual-vantage non-container environment needs each
// queue manager's local exporter port; client_port is unique per exporter host across
// environments (an exporter host is a machine two environments may share; without one the port
// is scoped to the environment); native_port is unique per host within an environment.
export function checkInventory({ envs, itemLabel }) {
  const errors = [];
  const clientPortSeen = new Map();
  for (const [env, m] of Object.entries(envs)) {
    const nativePortSeen = new Map();
    for (const qm of m.instances) {
      const label = itemLabel(qm);
      const p = isObj(qm.params) ? qm.params : {};
      if (qm.shape === 'rdqm-ha') {
        if (list(qm.hosts).length < 3) errors.push(`${label}: shape rdqm-ha needs at least 3 hosts, has ${list(qm.hosts).length}`);
        if (!isObj(qm.address)) errors.push(`${label}: shape rdqm-ha needs an address (the floating IP)`);
      }
      if (m.vantage === 'dual' && m.profile === 'non-container' && p.native_port == null) errors.push(`${label}: environment ${env} is vantage dual with profile non-container, so params.native_port is required (the local exporter's port)`);
      if (p.client_port != null) {
        const eh = qm.exporter_host ?? '(no exporter_host)';
        const key = `${qm.exporter_host ? eh : `${env}/${eh}`}:${p.client_port}`;
        if (clientPortSeen.has(key)) errors.push(`${label}: client_port ${p.client_port} on exporter host ${eh} is also used by queue manager ${clientPortSeen.get(key)}`);
        else clientPortSeen.set(key, qm.name);
      }
      if (p.native_port != null) {
        for (const hn of list(qm.hosts)) {
          const key = `${hn}:${p.native_port}`;
          if (nativePortSeen.has(key)) errors.push(`${label}: native_port ${p.native_port} on host ${hn} is also used by queue manager ${nativePortSeen.get(key)}`);
          else nativePortSeen.set(key, qm.name);
        }
      }
    }
  }
  return errors;
}

// The expected sets: the queue managers answer on the `exporter` scrape job; queues are counted
// per queue manager (the inventory cannot enumerate them), with a floor where the site says so.
export function expectedKinds(ctx) {
  return {
    qmgr: { jobs: ['exporter'] },
    // hosts are observable in the fixture fleet (its host agents label `up` with host=), so opt in
    host: { jobs: [] },
    queue: {
      title: 'queue', label: 'queue', per: 'qmgr',
      query: `count by (qmgr) (last_over_time(fixture_queue_depth{queue=~"${ctx.p.queue_pattern}"}[5m]))`,
      min: Object.fromEntries(ctx.instances.filter(q => Number.isInteger(q.params?.expect_queues)).map(q => [q.name, q.params.expect_queues])),
    },
  };
}

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

export function perInstance(ctx, qm) {
  return {
    [`qmgrs/${qm.name}/exporter.yaml`]: `queueManager: ${qm.name}\nconnName: ${qm.address.host}(${qm.address.port})\npollInterval: ${ctx.timing.dur(ctx.timing.poll)}\nenv: ${ctx.env}\nport: ${qm.params.client_port}\n`,
  };
}

export function harness(ctx) { return { vantage: ctx.vantage, probe: ctx.timing.probe }; }

export function checks(ctx, files) {
  const errors = [];
  for (const qm of ctx.instances) if (!files.some(f => f.path === `qmgrs/${qm.name}/exporter.yaml`)) errors.push(`no exporter file for ${qm.name}`);
  return errors;
}
