#!/usr/bin/env node
/**
 * tools/fetch-validators.mjs
 *
 * Downloads the pinned backend-validator binaries used by
 * tools/test-backend-validate.mjs into .tools/ (gitignored). Versions
 * AND sha256 checksums are hardcoded below — a download that does not
 * match its pinned checksum is deleted and the run fails. This keeps
 * the zero-dependency stance: validators are dev tooling fetched on
 * demand, never npm packages, never shipped.
 *
 *   node tools/fetch-validators.mjs            # fetch everything missing
 *   node tools/fetch-validators.mjs --force    # re-fetch even if present
 *   node tools/fetch-validators.mjs --only promtool,amtool
 *
 * Extraction uses the system `tar` (GNU tar on Linux, bsdtar on macOS
 * and Windows 10+ — bsdtar also reads .zip, which is why the Windows
 * Prometheus/Alertmanager archives can be .zip without extra tooling).
 *
 * Pin review rides the monthly dependency pass — see
 * docs/TEST_PLAN_COMPILER_VALIDITY.md §9.
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = join(ROOT, '.tools');
const DL_DIR = join(TOOLS_DIR, 'dl');
const BIN_DIR = join(TOOLS_DIR, 'bin');
const MANIFEST = join(TOOLS_DIR, 'manifest.json');

const EXE = process.platform === 'win32' ? '.exe' : '';

// ---------- pinned releases (version + sha256 per platform) ----------
// promtool: Prometheus 3.5 LTS line. amtool: Alertmanager stable.
// otelcol-contrib: the contrib distribution (the emitted exporters live
// in contrib). Platform key: `${process.platform}-${process.arch}`.

const PROM_V = '3.5.3';
const AM_V = '0.32.2';
const OTEL_V = '0.154.0';
const MIMIR_V = '3.1.0';
const DLINT_V = '0.1.1';

const PINS = {
  promtool: {
    version: PROM_V,
    archives: {
      'linux-x64': {
        url: `https://github.com/prometheus/prometheus/releases/download/v${PROM_V}/prometheus-${PROM_V}.linux-amd64.tar.gz`,
        sha256: '8c30b9d99664e39b0363c0ba54fab30a7958e9d3de27246bf26ed85e6cfb8946',
        binPath: `prometheus-${PROM_V}.linux-amd64/promtool`,
      },
      'win32-x64': {
        url: `https://github.com/prometheus/prometheus/releases/download/v${PROM_V}/prometheus-${PROM_V}.windows-amd64.zip`,
        sha256: '6ebe148731493138e9a020766487c5e16f0591e35006aeeb561197078948b32d',
        binPath: `prometheus-${PROM_V}.windows-amd64/promtool.exe`,
      },
      'darwin-x64': {
        url: `https://github.com/prometheus/prometheus/releases/download/v${PROM_V}/prometheus-${PROM_V}.darwin-amd64.tar.gz`,
        sha256: '408eec9f1138ad5d30509038b2e8ae798ed2910e7faaa0e7f61ca22db222aaf5',
        binPath: `prometheus-${PROM_V}.darwin-amd64/promtool`,
      },
      'darwin-arm64': {
        url: `https://github.com/prometheus/prometheus/releases/download/v${PROM_V}/prometheus-${PROM_V}.darwin-arm64.tar.gz`,
        sha256: '1883df59fbea254b2e3f112feb6406533be7c062aef20f5d0b40b9e9acdb77e2',
        binPath: `prometheus-${PROM_V}.darwin-arm64/promtool`,
      },
    },
  },
  amtool: {
    version: AM_V,
    archives: {
      'linux-x64': {
        url: `https://github.com/prometheus/alertmanager/releases/download/v${AM_V}/alertmanager-${AM_V}.linux-amd64.tar.gz`,
        sha256: '842f30671734e9920327aa8308e19aea7bb79c2b9905e941d83236267f87b13d',
        binPath: `alertmanager-${AM_V}.linux-amd64/amtool`,
      },
      'win32-x64': {
        url: `https://github.com/prometheus/alertmanager/releases/download/v${AM_V}/alertmanager-${AM_V}.windows-amd64.zip`,
        sha256: '7422a4c1b4dba75a0ca46cce191295abe84f2fe648d3e48c630e7153946d22dd',
        binPath: `alertmanager-${AM_V}.windows-amd64/amtool.exe`,
      },
      'darwin-x64': {
        url: `https://github.com/prometheus/alertmanager/releases/download/v${AM_V}/alertmanager-${AM_V}.darwin-amd64.tar.gz`,
        sha256: '5f9fa961a03278e17733517c03f674f92938a0f96f63617739df68c44df785ce',
        binPath: `alertmanager-${AM_V}.darwin-amd64/amtool`,
      },
      'darwin-arm64': {
        url: `https://github.com/prometheus/alertmanager/releases/download/v${AM_V}/alertmanager-${AM_V}.darwin-arm64.tar.gz`,
        sha256: '837e2be3b0086070080a23c2328c604f7f9b08e11d9ef59dcc4455a7068e74c5',
        binPath: `alertmanager-${AM_V}.darwin-arm64/amtool`,
      },
    },
  },
  // mimirtool attests the rules flavor's "Mimir-compatible" claim.
  // Grafana ships it as a RAW binary (no archive) and publishes no
  // Windows build — Windows devs get a loud skip; CI (linux) runs it.
  mimirtool: {
    version: MIMIR_V,
    archives: {
      'linux-x64': {
        url: `https://github.com/grafana/mimir/releases/download/mimir-${MIMIR_V}/mimirtool-linux-amd64`,
        sha256: 'afe3e9b7e5063c0b5c7cb262a09d190882e3018497b45730e2abff600bccfaca',
        raw: true,
      },
      'darwin-x64': {
        url: `https://github.com/grafana/mimir/releases/download/mimir-${MIMIR_V}/mimirtool-darwin-amd64`,
        sha256: 'cabc9c5161df47a16a4ff090230ef8d11731feb253fa34cea5bc9bf865280d95',
        raw: true,
      },
      'darwin-arm64': {
        url: `https://github.com/grafana/mimir/releases/download/mimir-${MIMIR_V}/mimirtool-darwin-arm64`,
        sha256: '43d353daea81ca69d6d30afb180b3422030643de22b90ad099e65496b9efb3eb',
        raw: true,
      },
    },
  },
  // dashboard-linter is ADVISORY (it encodes opinions beyond validity);
  // the authoritative dashboard gate is the live Grafana import (T2).
  'dashboard-linter': {
    version: DLINT_V,
    archives: {
      'linux-x64': {
        url: `https://github.com/grafana/dashboard-linter/releases/download/v${DLINT_V}/dashboard-linter_${DLINT_V}_linux_amd64.tar.gz`,
        sha256: 'ab8891fa0e55b60baf0eb25c76cc92768c5e829a1ed525efd651bbd0c5ba9457',
        binPath: 'dashboard-linter',
      },
      'win32-x64': {
        url: `https://github.com/grafana/dashboard-linter/releases/download/v${DLINT_V}/dashboard-linter_${DLINT_V}_windows_amd64.zip`,
        sha256: '3c0792a652cb5b5c2072c756b1f7a39f483ea6ad91114a98b8ef7d135ce7340c',
        binPath: 'dashboard-linter.exe',
      },
      'darwin-x64': {
        url: `https://github.com/grafana/dashboard-linter/releases/download/v${DLINT_V}/dashboard-linter_${DLINT_V}_darwin_amd64.tar.gz`,
        sha256: '8ac4724705e7dc215cc6e1f80206c550cac345edddb110059593364191beb2af',
        binPath: 'dashboard-linter',
      },
      'darwin-arm64': {
        url: `https://github.com/grafana/dashboard-linter/releases/download/v${DLINT_V}/dashboard-linter_${DLINT_V}_darwin_arm64.tar.gz`,
        sha256: '058a3fedd7a0d85e57933f029cbc0ae392548fe1256472e5a39dc6137c6d3ce7',
        binPath: 'dashboard-linter',
      },
    },
  },
  'otelcol-contrib': {
    version: OTEL_V,
    archives: {
      'linux-x64': {
        url: `https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTEL_V}/otelcol-contrib_${OTEL_V}_linux_amd64.tar.gz`,
        sha256: 'f0fe6e7b1d81936d4e5a3aad7a678f3fc2f8ada2a9f8f37f37542813c12ed322',
        binPath: 'otelcol-contrib',
      },
      'win32-x64': {
        url: `https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTEL_V}/otelcol-contrib_${OTEL_V}_windows_amd64.tar.gz`,
        sha256: '3f68a2f48da37da37e478b50814f2da408fb66593b288d4bb57bd3d832339e3b',
        binPath: 'otelcol-contrib.exe',
      },
      'darwin-x64': {
        url: `https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTEL_V}/otelcol-contrib_${OTEL_V}_darwin_amd64.tar.gz`,
        sha256: '14f7f825a7ad7ee0799947ff70a42b9a5528a9c1411ab45f8fcc4caeb9346f7b',
        binPath: 'otelcol-contrib',
      },
      'darwin-arm64': {
        url: `https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTEL_V}/otelcol-contrib_${OTEL_V}_darwin_arm64.tar.gz`,
        sha256: 'de3af70ef0b80af213911cc9ba8daf553348dd22ed1fb15db561d207fc2cb3d9',
        binPath: 'otelcol-contrib',
      },
    },
  },
};

// ---------- helpers ----------

function platformKey() { return `${process.platform}-${process.arch}`; }

function readManifest() {
  try { return JSON.parse(readFileSync(MANIFEST, 'utf8')); } catch (_) { return {}; }
}

function download(url, dest, redirects = 0) {
  return new Promise((resolveDl, reject) => {
    if (redirects > 5) return reject(new Error(`too many redirects for ${url}`));
    httpsGet(url, { headers: { 'User-Agent': 'observogram-fetch-validators' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolveDl(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const out = createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolveDl()));
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function extract(archive, intoDir) {
  mkdirSync(intoDir, { recursive: true });
  // bsdtar (macOS, Windows 10+) reads .zip as well as .tar.gz; GNU tar
  // (Linux) only sees .tar.gz here — the Linux pins are all tarballs.
  const r = spawnSync('tar', ['-xf', archive, '-C', intoDir], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`tar extraction failed for ${archive}: ${r.stderr || r.error?.message || 'unknown'}`);
  }
}

async function fetchTool(name, pin, { force }) {
  const key = platformKey();
  const arch = pin.archives[key];
  if (!arch) {
    // A platform with no published build (e.g. mimirtool on Windows) is
    // a skip, not a failure — CI runs on linux where every pin exists,
    // and the validate suite skips loudly per missing binary.
    console.log(`  ${name}: no ${key} build published upstream — skipped (runs in CI)`);
    return { name, ok: true, skipped: true };
  }
  const finalBin = join(BIN_DIR, name + EXE);
  const manifest = readManifest();
  if (!force && manifest[name]?.version === pin.version && existsSync(finalBin)) {
    console.log(`  ${name} ${pin.version} already present — skipping (use --force to re-fetch)`);
    return { name, ok: true, path: finalBin };
  }

  mkdirSync(DL_DIR, { recursive: true });
  mkdirSync(BIN_DIR, { recursive: true });
  const archiveFile = join(DL_DIR, arch.url.split('/').pop());

  if (!existsSync(archiveFile) || force || sha256Of(archiveFile) !== arch.sha256) {
    console.log(`  ${name} ${pin.version}: downloading ${arch.url}`);
    await download(arch.url, archiveFile);
  }
  const got = sha256Of(archiveFile);
  if (got !== arch.sha256) {
    rmSync(archiveFile, { force: true });
    throw new Error(`${name}: sha256 mismatch for ${archiveFile}\n  expected ${arch.sha256}\n  got      ${got}\nDownload deleted — the pin or the mirror is wrong; do NOT bypass this.`);
  }
  console.log(`  ${name} ${pin.version}: checksum verified (${got.slice(0, 12)}…)`);

  if (arch.raw) {
    // Release asset IS the binary (mimirtool style) — no extraction.
    copyFileSync(archiveFile, finalBin);
  } else {
    const extractDir = join(TOOLS_DIR, 'extract', name);
    rmSync(extractDir, { recursive: true, force: true });
    extract(archiveFile, extractDir);
    const extractedBin = join(extractDir, arch.binPath);
    if (!existsSync(extractedBin)) {
      throw new Error(`${name}: expected binary missing after extraction: ${extractedBin}`);
    }
    copyFileSync(extractedBin, finalBin);
  }
  if (process.platform !== 'win32') chmodSync(finalBin, 0o755);

  const m = readManifest();
  m[name] = { version: pin.version, path: finalBin, sha256: arch.sha256, fetchedAt: new Date().toISOString() };
  mkdirSync(TOOLS_DIR, { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
  console.log(`  ${name} ${pin.version}: installed → ${finalBin}`);
  return { name, ok: true, path: finalBin };
}

// ---------- main ----------

const args = process.argv.slice(2);
const force = args.includes('--force');
const onlyArg = args.find(a => a.startsWith('--only'));
const only = onlyArg
  ? (onlyArg.includes('=') ? onlyArg.split('=')[1] : args[args.indexOf(onlyArg) + 1] || '').split(',').filter(Boolean)
  : null;

const wanted = Object.entries(PINS).filter(([name]) => !only || only.includes(name));
console.log(`fetch-validators: ${wanted.map(([n, p]) => `${n}@${p.version}`).join(' · ')} → ${BIN_DIR}`);

let failed = 0;
for (const [name, pin] of wanted) {
  try {
    const r = await fetchTool(name, pin, { force });
    if (!r.ok) failed++;
  } catch (e) {
    console.error(`  ${name}: FAILED — ${e.message}`);
    failed++;
  }
}
if (failed) {
  console.error(`fetch-validators: ${failed} tool(s) failed`);
  process.exit(1);
}
console.log('fetch-validators: done');
