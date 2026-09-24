// tools/lib/l2x.mjs
//
// Shared materialisation for the spec's extended technology surfaces (§5.12.4).
// The crawler and the live MCP fetcher both discover telemetry.backends[];
// this module promotes those backend rows into the canonical optional
// L2X sections so repo-vs-live drift compares the same first-class surfaces.

const PRODUCT_ALIASES = {
  'fluent-bit': 'fluentbit',
  'fluent/bit': 'fluentbit',
  'opentelemetry-collector-contrib': 'opentelemetry-collector',
};

const MESH_PRODUCTS = new Set(['envoy', 'consul', 'kong', 'traefik']);
const COLLECTION_PRODUCTS = new Set([
  'fluentbit',
  'beats',
  'vector',
  'alloy',
]);

export function materializeL2XFromBackends(backends = [], opts = {}) {
  const sections = {};
  const evidence = [];
  const markVerified = typeof opts.markVerified === 'function' ? opts.markVerified : null;

  const emit = (symbol, backend, sectionName, value) => {
    if (!backend?.id) return;
    evidence.push({ artifactId: symbol, backendId: backend.id, section: sectionName });
    if (markVerified) markVerified(symbol);
    return value;
  };

  const profiling = firstSurface(backends, (b) =>
    b.signal === 'profiles' || productOf(b) === 'pyroscope' || productOf(b) === 'parca');
  if (profiling) {
    sections.profiling = emit('profiling', profiling, 'profiling', {
      ...surfaceRef(profiling),
      profile_types: profileTypesFor(profiling),
    });
  }

  const network = firstSurface(backends, (b) =>
    b.signal === 'network' || productOf(b) === 'cilium');
  if (network) {
    sections.network = emit('network', network, 'network', {
      ...surfaceRef(network),
      observe: ['endpoints', 'policy', 'services', 'flows'],
    });
  }

  const policy = firstSurface(backends, (b) =>
    b.signal === 'policy' || productOf(b) === 'opa');
  if (policy) {
    sections.policy_engine = emit('policy_engine', policy, 'policy_engine', surfaceRef(policy));
  }

  const mesh = backends
    .filter((b) => b?.id && (b.signal === 'mesh' || b.signal === 'gateway' || MESH_PRODUCTS.has(productOf(b))))
    .map((b) => ({
      backend: b,
      value: {
        product: productOf(b),
        role: meshRoleFor(b),
        backend: b.id,
        ...versionPart(b),
      },
    }))
    .filter((x) => isProduct(x.value.product));
  if (mesh.length) {
    sections.mesh = mesh.map((x, i) => emit(`mesh[${i}]`, x.backend, 'mesh', x.value));
  }

  const collection = backends
    .filter((b) => b?.id && COLLECTION_PRODUCTS.has(productOf(b)))
    .map((b) => ({
      backend: b,
      value: {
        product: productOf(b),
        role: collectionRoleFor(b),
        backend: b.id,
        ...versionPart(b),
      },
    }))
    .filter((x) => isProduct(x.value.product));
  if (collection.length) {
    sections.collection = collection.map((x, i) => emit(`collection[${i}]`, x.backend, 'collection', x.value));
  }

  return { sections, evidence };
}

function firstSurface(backends, predicate) {
  return backends.find((b) => b?.id && isProduct(productOf(b)) && predicate(b)) || null;
}

function surfaceRef(backend) {
  return {
    backend: backend.id,
    product: productOf(backend),
    ...versionPart(backend),
  };
}

function versionPart(backend) {
  const v = backend?.version;
  if (!v || typeof v !== 'object') return {};
  const out = {};
  for (const k of ['declared', 'min', 'max', 'gating']) {
    if (v[k] !== undefined && v[k] !== null && v[k] !== '') out[k] = v[k];
  }
  if (Array.isArray(v.capabilities) && v.capabilities.length) {
    out.capabilities = v.capabilities.slice();
  }
  return Object.keys(out).length ? { version: out } : {};
}

function productOf(backend) {
  const raw = String(backend?.product || '').toLowerCase();
  return PRODUCT_ALIASES[raw] || raw;
}

function isProduct(product) {
  return /^[a-z][a-z0-9_-]{1,39}$/.test(product);
}

function profileTypesFor(backend) {
  const caps = Array.isArray(backend?.version?.capabilities) ? backend.version.capabilities : [];
  const fromCaps = caps
    .map((c) => String(c).toLowerCase())
    .filter((c) => /^(cpu|heap|alloc_space|inuse_space|goroutine|mutex|block)$/.test(c));
  return fromCaps.length ? [...new Set(fromCaps)] : ['cpu'];
}

function meshRoleFor(backend) {
  const p = productOf(backend);
  if (p === 'consul') return 'service-discovery';
  if (p === 'kong' || p === 'traefik' || backend?.signal === 'gateway') return 'gateway';
  return 'proxy';
}

function collectionRoleFor(backend) {
  const p = productOf(backend);
  if (p === 'vector') return 'aggregator';
  if (p === 'fluentbit' || p === 'beats' || p === 'alloy') return 'agent';
  return 'forwarder';
}
