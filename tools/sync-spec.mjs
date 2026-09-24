#!/usr/bin/env node
/**
 * tools/sync-spec.mjs
 *
 * Refreshes the vendored copy of the ObservabilityPack spec under
 * vendor/observability-pack-spec/. Pulls the four canonical files (SOURCE_FILES) from
 * MoebiusX/otel-observability-pack via `gh api`, writes them under v<spec version>/ — the
 * version is read from the header table of the fetched spec (`| Spec version | 1.3 |`), never
 * typed here — recomputes sha256 checksums, and rewrites VERSIONS.json.
 *
 * Usage:
 *   node tools/sync-spec.mjs              # sync to the upstream default branch (develop) HEAD
 *   node tools/sync-spec.mjs --ref <ref>  # sync to a specific branch, tag or sha
 *   node tools/sync-spec.mjs --check      # verify on-disk checksums match VERSIONS.json; exit 1 on drift
 *
 * A spec bump lands in a new directory (v1.2/ → v1.3/) and VERSIONS.json follows it; the previous
 * directory is not deleted here — remove it in the commit that moves tools/lib/validator.mjs
 * SPEC_VERSION (git history keeps it).
 *
 * Exit codes:
 *   0  success / no drift
 *   1  hard failure or drift detected (with --check)
 *
 * Requires: Node 22.16+ (the package floor), `gh` CLI authenticated.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const VENDOR = join(ROOT, 'vendor', 'observability-pack-spec');
const MANIFEST = join(VENDOR, 'VERSIONS.json');
const UPSTREAM_REPO = 'MoebiusX/otel-observability-pack';
const DEFAULT_REF = 'develop';   // the upstream default branch (main stopped at 1.2)

/** The vendored files: [upstream path, path under v<version>/]. The spec comes first: the version is read from it. */
const SOURCE_FILES = [
  ['spec/ObservabilityPack-Spec.md', 'spec.md'],
  ['schema/observability-pack.schema.json', 'observability-pack.schema.json'],
  ['examples/payment-service.pack.yaml', 'examples/payment-service.pack.yaml'],
  ['docs/maturity-model.md', 'docs/maturity-model.md'],
];
/** The spec's header table row that names its own version. */
const SPEC_VERSION_RE = /^\|\s*Spec version\s*\|\s*(\d+\.\d+)\s*\|/m;

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const refIdx = args.indexOf('--ref');
const refOverride = refIdx !== -1 ? args[refIdx + 1] : null;

function ghRun(ghArgs) {
  const r = spawnSync('gh', ghArgs, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`gh ${ghArgs.join(' ')} failed: ${String(r.stderr || r.stdout)}`);
  }
  return r.stdout;
}
/** A gh api call whose answer is one token (a sha, a URL): trimmed. */
const gh = (...ghArgs) => ghRun(ghArgs).toString('utf8').trim();
/** A file body, byte for byte: never trimmed (a trailing newline is part of the file and of its checksum). */
const ghBody = (url) => ghRun(['api', url]);

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function relFromVendor(p) {
  return p.replace(VENDOR + '\\', '').replace(VENDOR + '/', '').replaceAll('\\', '/');
}

function loadManifest() {
  if (!existsSync(MANIFEST)) {
    throw new Error(`manifest not found: ${MANIFEST} — run sync without --check first`);
  }
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

function check() {
  const m = loadManifest();
  let drift = 0;
  const dir = `v${m.schema}/`;
  for (const [vendorRel, meta] of Object.entries(m.files)) {
    if (!vendorRel.startsWith(dir)) {
      process.stderr.write(`✗ ${vendorRel}: not under ${dir} (manifest schema ${m.schema})\n`);
      drift++;
    }
    const onDisk = join(VENDOR, vendorRel);
    if (!existsSync(onDisk)) {
      process.stderr.write(`✗ ${vendorRel}: file missing\n`);
      drift++;
      continue;
    }
    const buf = readFileSync(onDisk);
    const got = sha256(buf);
    if (got !== meta.sha256) {
      process.stderr.write(`✗ ${vendorRel}: sha256 drift\n    expected ${meta.sha256}\n    got      ${got}\n`);
      drift++;
    } else if (buf.length !== meta.bytes) {
      process.stderr.write(`✗ ${vendorRel}: byte count drift (expected ${meta.bytes}, got ${buf.length})\n`);
      drift++;
    } else {
      process.stdout.write(`✓ ${vendorRel}\n`);
    }
  }
  if (drift) {
    process.stderr.write(`\n${drift} drift finding(s). Re-run \`node tools/sync-spec.mjs\` to refresh.\n`);
    process.exit(1);
  }
  process.stdout.write(`\nclean: ${Object.keys(m.files).length} file(s) match VERSIONS.json (spec ${m.schema}, commit ${m.upstream.commit.slice(0, 8)})\n`);
}

function sync() {
  const previous = existsSync(MANIFEST) ? loadManifest() : null;
  const ref = refOverride || DEFAULT_REF;
  const commitSha = gh('api', `repos/${UPSTREAM_REPO}/commits/${ref}`, '--jq', '.sha');
  process.stdout.write(`[sync-spec] upstream ${UPSTREAM_REPO}@${ref} -> ${commitSha.slice(0, 8)}\n`);

  // Fetch every file first (the spec names the version directory), then write.
  const fetched = SOURCE_FILES.map(([sourcePath, name]) => {
    const url = gh('api', `repos/${UPSTREAM_REPO}/contents/${sourcePath}?ref=${commitSha}`, '--jq', '.download_url');
    return { sourcePath, name, buf: ghBody(url) };
  });
  const spec = fetched.find(f => f.name === 'spec.md');
  const version = SPEC_VERSION_RE.exec(spec.buf.toString('utf8'))?.[1];
  if (!version) throw new Error(`${spec.sourcePath}: no "| Spec version | x.y |" row in its header table`);
  if (previous && previous.schema !== version) process.stdout.write(`[sync-spec] spec ${previous.schema} -> ${version}: writing v${version}/ (remove v${previous.schema}/ with the SPEC_VERSION bump)\n`);

  const files = {};
  for (const f of fetched) {
    const vendorRel = `v${version}/${f.name}`;
    const onDisk = join(VENDOR, vendorRel);
    mkdirSync(dirname(onDisk), { recursive: true });
    writeFileSync(onDisk, f.buf);
    const got = sha256(f.buf);
    files[vendorRel] = { sourcePath: f.sourcePath, sha256: got, bytes: f.buf.length };
    const before = previous?.files?.[vendorRel]?.sha256;
    const changed = before === undefined ? 'NEW' : got !== before ? 'CHANGED' : 'unchanged';
    process.stdout.write(`  ${changed.padEnd(9)} ${vendorRel} (${f.buf.length} bytes)\n`);
  }

  const fetchedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const next = {
    schema: version,
    upstream: { repo: UPSTREAM_REPO, ref, commit: commitSha },
    fetchedAt,
    files,
  };
  writeFileSync(MANIFEST, JSON.stringify(next, null, 2) + '\n');
  process.stdout.write(`[sync-spec] wrote ${relFromVendor(MANIFEST)} (spec ${version}, commit ${commitSha.slice(0, 8)}, ${fetchedAt})\n`);
}

try {
  if (CHECK_ONLY) check();
  else sync();
} catch (e) {
  process.stderr.write(`[sync-spec] FATAL: ${e.message}\n`);
  process.exit(1);
}
