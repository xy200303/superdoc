#!/usr/bin/env node
/**
 * Single command to validate the published superdoc package's public
 * TypeScript surface end-to-end.
 *
 * Stages:
 *   1. tier-discipline:test - unit tests for the pure tier validator.
 *                             Cheap (~50ms). Verifies the validator
 *                             catches every failure class before the
 *                             next stage trusts its verdict.
 *   2. tier-discipline      - package.json#exports vs publicContract
 *                             tier coverage, routing, and legacy-raw
 *                             allowlist. Cheap (~10ms); runs early so
 *                             tier drift fails fast before the slow
 *                             build/matrix work.
 *   3. build:superdoc       - vite build + the postbuild validator chain
 *                             (check-tsconfig-type-surface, ensure-types,
 *                             audit-bundle, audit-declarations,
 *                             check-export-coverage, verify-public-facade-emit,
 *                             report-declaration-reachability).
 *                             Skipped when `--skip-build` is passed (CI calls
 *                             `pnpm run build` separately in its own step).
 *   4. typecheck-matrix     - packs superdoc + installs the tarball into
 *                             tests/consumer-typecheck/node_modules/, then
 *                             runs every consumer scenario.
 *   5. deep-type-audit      - strict gate on the supported-root public
 *                             surface (must be 0 findings). Reuses the
 *                             install that stage 4 produced (no `--pack`).
 *   6. package-shape        - publint + attw against the packed manifest
 *                             (reuses the tarball from stage 4).
 *   7. snapshots            - super-editor / legacy / root no-growth
 *                             snapshots (reuses the install).
 *   8. closure              - root-classification closure gate:
 *                             no supported-root/legacy-root export
 *                             references an internal-candidate type.
 *
 * Matrix runs BEFORE stages 5-8 on purpose: it packs `superdoc.tgz`
 * and installs the tarball into the consumer fixture once. Stages 5,
 * 7, and 8 (deep-type-audit, snapshots, closure) reuse the installed
 * fixture; stage 6 (package-shape-gate) reuses the packed tarball
 * directly. Without this ordering each downstream stage would
 * `--pack` separately and multiply the work.
 *
 * Local usage:
 *   pnpm check:public           (umbrella, runs SuperDoc + Document API)
 *   pnpm check:public:superdoc  (SuperDoc only, this script)
 *
 * CI usage (Build step already ran):
 *   pnpm check:public:superdoc --skip-build
 *
 * SD-3256 Phase 1 (initial wrapper) / SD-673 Phase 1 (CI wiring).
 * Extended in the typecheck-wrapper consolidation PR to subsume the
 * package-shape / snapshots / closure steps that release-superdoc.yml,
 * release-stable.yml, and ci-superdoc.yml previously ran separately.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const flags = new Set(process.argv.slice(2));
const skipBuild = flags.has('--skip-build');

const stages = [
  {
    name: 'tier-discipline:test',
    cwd: REPO_ROOT,
    cmd: 'node',
    args: ['--test', 'scripts/check-public-contract-tiers.test.mjs'],
    blurb:
      'Unit tests for the pure tier validator. Cheap (~50ms); verifies ' +
      'the validator catches every failure class before the next stage ' +
      'trusts its verdict.',
  },
  {
    name: 'tier-discipline',
    cwd: REPO_ROOT,
    cmd: 'node',
    args: ['scripts/check-public-contract-tiers.mjs'],
    blurb:
      'Public-contract tier discipline: package.json#exports vs publicContract ' +
      '(tier coverage, routing, legacy-raw allowlist). Cheap; fast-fails before ' +
      'the slow build/matrix stages.',
  },
  {
    name: 'build:superdoc',
    cwd: REPO_ROOT,
    cmd: 'pnpm',
    args: ['run', 'build:superdoc'],
    blurb:
      'Build dist + run postbuild validators (audit-bundle, audit-declarations, ' +
      'check-export-coverage, verify-public-facade-emit, ensure-types, ...).',
    skipIf: skipBuild,
    skipReason: '--skip-build passed; CI Build step already ran this',
  },
  {
    name: 'typecheck-matrix',
    cwd: resolve(REPO_ROOT, 'tests/consumer-typecheck'),
    cmd: 'node',
    args: ['typecheck-matrix.mjs'],
    blurb:
      'Packs superdoc + installs the tarball into the consumer fixture, ' +
      'then runs every typecheck scenario.',
  },
  {
    name: 'deep-type-audit --strict-supported-root',
    cwd: resolve(REPO_ROOT, 'tests/consumer-typecheck'),
    cmd: 'node',
    args: ['deep-type-audit.mjs', '--strict-supported-root'],
    blurb:
      'Strict gate on the supported-root public surface (must be 0 findings). ' +
      'Reuses the install produced by typecheck-matrix.',
  },
  {
    name: 'package-shape-gate',
    cwd: resolve(REPO_ROOT, 'tests/consumer-typecheck'),
    cmd: 'node',
    args: ['package-shape-gate.mjs'],
    blurb:
      'External npm-package linters (publint + attw) against the packed manifest. ' +
      'Reuses the tarball produced by typecheck-matrix (not the installed fixture).',
  },
  {
    name: 'snapshot --all --check',
    cwd: resolve(REPO_ROOT, 'tests/consumer-typecheck'),
    cmd: 'node',
    args: ['snapshot.mjs', '--all', '--check'],
    blurb:
      'No-growth snapshots for super-editor / legacy / root export inventories. ' +
      'Run with `node snapshot.mjs --family <name> --write` to regenerate intentionally.',
  },
  {
    name: 'check-root-classification-closure',
    cwd: resolve(REPO_ROOT, 'tests/consumer-typecheck'),
    cmd: 'node',
    args: ['check-root-classification-closure.mjs'],
    blurb:
      'Closure gate: no supported-root or legacy-root export references an ' +
      'internal-candidate type in its public declared shape (SD-3212 A1b).',
  },
];

const HR = '='.repeat(72);
const start = Date.now();

let failed = null;
let ranCount = 0;
for (const [i, s] of stages.entries()) {
  console.log('');
  console.log(HR);
  console.log(`[${i + 1}/${stages.length}] ${s.name}`);
  if (s.skipIf) {
    console.log(`SKIP: ${s.skipReason}`);
    console.log(HR);
    continue;
  }
  console.log(s.blurb);
  console.log(HR);
  const result = spawnSync(s.cmd, s.args, { cwd: s.cwd, stdio: 'inherit' });
  ranCount += 1;
  if (result.status !== 0) {
    failed = { stage: s.name, status: result.status ?? 1 };
    break;
  }
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log('');
console.log(HR);
if (failed) {
  console.log(`FAIL: stage "${failed.stage}" exited ${failed.status} (after ${elapsed}s)`);
  console.log('');
  console.log('Re-run the failing stage directly to iterate:');
  const failedStage = stages.find((s) => s.name === failed.stage);
  console.log(`  cd ${failedStage.cwd}`);
  console.log(`  ${failedStage.cmd} ${failedStage.args.join(' ')}`);
  process.exit(failed.status);
} else {
  const skipped = stages.length - ranCount;
  const ranLabel = skipped > 0 ? `${ranCount} ran, ${skipped} skipped` : `${ranCount} stages`;
  console.log(`PASS: ${ranLabel}, ${elapsed}s`);
}
