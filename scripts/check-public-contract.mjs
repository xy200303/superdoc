#!/usr/bin/env node
/**
 * Single command to validate the published superdoc package's public
 * TypeScript surface end-to-end.
 *
 * Stages:
 *   1. build:superdoc      - vite build + the postbuild validator chain
 *                            (check-tsconfig-type-surface, ensure-types,
 *                            audit-bundle, audit-declarations,
 *                            check-export-coverage, verify-public-facade-emit,
 *                            report-declaration-reachability).
 *                            Skipped when `--skip-build` is passed (CI calls
 *                            `pnpm run build` separately in its own step).
 *   2. typecheck-matrix    - packs superdoc + installs the tarball into
 *                            tests/consumer-typecheck/node_modules/, then
 *                            runs every consumer scenario.
 *   3. deep-type-audit     - strict gate on the supported-root public
 *                            surface (must be 0 findings). Reuses the
 *                            install that stage 2 produced (no `--pack`).
 *
 * Matrix runs BEFORE audit on purpose: matrix packs + installs the
 * tarball once, and the audit then reuses that install. Without this
 * order the audit would `--pack` separately and double the work.
 *
 * Local usage:
 *   pnpm check:public-contract
 *
 * CI usage (Build step already ran):
 *   pnpm check:public-contract --skip-build
 *
 * SD-3256 Phase 1 (initial wrapper) / SD-673 Phase 1 (CI wiring).
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const flags = new Set(process.argv.slice(2));
const skipBuild = flags.has('--skip-build');

const stages = [
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
