#!/usr/bin/env node
/**
 * SD-3256 Phase 2: print the public-contract tier metadata as a
 * human-readable report. Read-only; no validation, no enforcement.
 *
 * Source of truth: `packages/superdoc/scripts/type-surface.config.cjs`
 * (the `publicContract` export). Adding a new public subpath without
 * adding it there means it is "internal" by definition of this report.
 *
 * Cross-checks done by this script:
 *   1. Every `package.json#exports` subpath has a `publicContract`
 *      entry. Missing entries are listed as MISSING.
 *   2. Every `publicContract` subpath actually exists in `exports`.
 *      Stale entries are listed as STALE.
 *
 * Both cross-checks are reported but do NOT change exit code in this
 * phase (Phase 2 is read-only by design). The script always exits 0
 * unless it cannot load the config or package.json.
 *
 * Usage:
 *   pnpm report:public-contract
 *
 * Tracking: SD-3256 Phase 2.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const config = require(resolve(REPO_ROOT, 'packages/superdoc/scripts/type-surface.config.cjs'));
const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/superdoc/package.json'), 'utf8'));

const { publicContract } = config;
if (!publicContract) {
  console.error('FAIL: publicContract not exported from type-surface.config.cjs');
  process.exit(1);
}

const exportsMap = pkg.exports || {};
const exportSubpaths = new Set(Object.keys(exportsMap));

const allContractEntries = [
  ...publicContract.supported,
  ...publicContract.legacy,
  ...publicContract.legacyRaw,
  ...publicContract.asset,
  ...publicContract.deprecated,
];
const contractSubpaths = new Set(allContractEntries.map((e) => e.subpath));

const HR = '='.repeat(72);

const printTier = (name, entries) => {
  console.log('');
  console.log(`## ${name} (${entries.length})`);
  if (entries.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const e of entries) {
    console.log(`  ${e.subpath.padEnd(28)}  ${e.note || ''}`);
  }
};

console.log(HR);
console.log('SuperDoc public type contract (SD-3256 Phase 2)');
console.log(HR);
console.log('');
console.log('Tier definitions live in:');
console.log('  packages/superdoc/scripts/type-surface.config.cjs (publicContract)');
console.log('');
console.log(`Total exports in package.json: ${exportSubpaths.size}`);
console.log(`Total entries in publicContract: ${contractSubpaths.size}`);

printTier('Supported', publicContract.supported);
printTier('Legacy (curated through src/public/legacy/**)', publicContract.legacy);
printTier('Legacy-raw (NOT yet curated; SD-3256 Phase 3 target)', publicContract.legacyRaw);
printTier('Asset (non-type)', publicContract.asset);
printTier('Deprecated', publicContract.deprecated);

// Cross-check: missing (in exports but not in contract)
const missing = [...exportSubpaths].filter((s) => !contractSubpaths.has(s));
// Cross-check: stale (in contract but not in exports)
const stale = [...contractSubpaths].filter((s) => !exportSubpaths.has(s));

console.log('');
console.log(HR);
console.log('Cross-checks vs package.json#exports');
console.log(HR);
if (missing.length === 0 && stale.length === 0) {
  console.log('OK: every export has a contract entry and vice versa.');
} else {
  if (missing.length > 0) {
    console.log(`MISSING (${missing.length}): in package.json#exports but not in publicContract:`);
    for (const s of missing) console.log(`  ${s}`);
  }
  if (stale.length > 0) {
    console.log(`STALE (${stale.length}): in publicContract but not in package.json#exports:`);
    for (const s of stale) console.log(`  ${s}`);
  }
  console.log('');
  console.log('(Phase 2 is read-only; this does not fail CI. Phase 4 will gate.)');
}

console.log('');
