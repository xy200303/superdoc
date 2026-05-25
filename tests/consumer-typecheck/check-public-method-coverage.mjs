#!/usr/bin/env node
/**
 * Public-method fixture coverage gate.
 *
 * Walks `packages/superdoc/src/core/SuperDoc.ts` with the TypeScript AST,
 * enumerates the public instance methods + getters, and asserts each has
 * at least one consumer-side reference in `tests/consumer-typecheck/src/`.
 * "Reference" means any of:
 *
 *   - `Parameters<SuperDoc['methodName']>`  → parameter shape locked
 *   - `ReturnType<SuperDoc['methodName']>`  → return shape locked
 *   - `superdoc.methodName(` / `sd.methodName(` → call-site exercise
 *
 * Two gates run here:
 *
 *   1. RATCHET — A NEW public method/getter that lands without any
 *      fixture reference fails CI. The contributor must add a fixture
 *      (preferred) or, for genuinely-internal members, add an
 *      allowlist entry with a one-line reason.
 *
 *   2. DEBT SNAPSHOT — The committed debt snapshot at
 *      `public-method-coverage-debt-snapshot.json` is the set of
 *      currently-uncovered public members. The ratchet fails when
 *      the snapshot is stale: a member dropped off (someone added
 *      a fixture for it — yay! refresh the snapshot to lock the win)
 *      or a NEW member is uncovered (the regression class we're
 *      catching).
 *
 * Refresh the snapshot after intentional changes:
 *   node tests/consumer-typecheck/check-public-method-coverage.mjs --write
 *
 * This is a floor, not a ceiling: it guarantees a reviewer was asked
 * to write an assertion per new public method. It does NOT guarantee
 * the assertion is correct (a typed but wrong assertion would still
 * pass). The companion gate is the consumer matrix, which exercises
 * the real package shape end-to-end.
 *
 * Why this exists: the SuperDoc.js → SuperDoc.ts migration introduced
 * a regression where `search(text: string)` narrowed the previous
 * `string | RegExp` contract. Every existing gate passed — the only
 * catcher was a bot review. `search` had a `ReturnType<>` fixture
 * but no `Parameters<>` fixture. This script makes that class of miss
 * a CI failure for any NEW public method.
 *
 * Allowlist: `tests/consumer-typecheck/public-method-coverage-allowlist.cjs`.
 * Use only for members that are intentionally not consumer-callable
 * (e.g. internal lifecycle relays that escaped `private` for runtime
 * reasons). Each entry requires a one-line reason.
 *
 * Wrapper stage: `public-method-coverage` in `scripts/check-public-contract.mjs`.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SUPERDOC_TS = resolve(REPO_ROOT, 'packages/superdoc/src/core/SuperDoc.ts');
const FIXTURE_DIR = resolve(REPO_ROOT, 'tests/consumer-typecheck/src');
const ALLOWLIST_PATH = resolve(HERE, 'public-method-coverage-allowlist.cjs');
const SNAPSHOT_PATH = resolve(HERE, 'public-method-coverage-debt-snapshot.json');

const require = createRequire(import.meta.url);
const ts = require('typescript');

const flags = new Set(process.argv.slice(2));
const writeMode = flags.has('--write');

// EventEmitter members; inherited, not SuperDoc's own surface.
const EVENT_EMITTER_MEMBERS = new Set([
  'on',
  'off',
  'once',
  'emit',
  'addListener',
  'removeListener',
  'removeAllListeners',
  'listeners',
  'listenerCount',
  'eventNames',
  'prependListener',
  'prependOnceListener',
  'rawListeners',
]);

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return {};
  const mod = require(ALLOWLIST_PATH);
  if (typeof mod !== 'object' || mod === null) return {};
  return mod;
}

function loadSnapshot() {
  if (!existsSync(SNAPSHOT_PATH)) return [];
  const raw = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  if (!Array.isArray(raw.knownUncovered)) {
    console.error(`[public-method-coverage] invalid snapshot at ${SNAPSHOT_PATH} (missing "knownUncovered" array)`);
    process.exit(1);
  }
  return raw.knownUncovered.slice().sort();
}

function writeSnapshot(names) {
  const payload = {
    $comment:
      'Auto-managed by tests/consumer-typecheck/check-public-method-coverage.mjs. ' +
      'Run with --write to refresh after adding/removing fixture coverage for ' +
      'public SuperDoc members. Each entry is a public method/getter that has ' +
      'no Parameters<>, ReturnType<>, or call-site reference in any consumer fixture.',
    knownUncovered: names.slice().sort(),
  };
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(payload, null, 2) + '\n');
}

/** Walk SuperDoc.ts and return public method/getter metadata. */
function enumeratePublicMembers() {
  const src = readFileSync(SUPERDOC_TS, 'utf8');
  const sf = ts.createSourceFile(SUPERDOC_TS, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  let cls = null;
  for (const stmt of sf.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name?.text === 'SuperDoc') {
      cls = stmt;
      break;
    }
  }
  if (!cls) {
    console.error(`[public-method-coverage] could not find SuperDoc class in ${SUPERDOC_TS}`);
    process.exit(1);
  }

  const members = [];
  for (const m of cls.members) {
    if (!ts.isMethodDeclaration(m) && !ts.isGetAccessorDeclaration(m)) continue;
    if (!m.name || !ts.isIdentifier(m.name)) continue;

    const name = m.name.text;
    const mods = m.modifiers ?? [];
    if (mods.some((mod) => mod.kind === ts.SyntaxKind.PrivateKeyword)) continue;
    if (mods.some((mod) => mod.kind === ts.SyntaxKind.StaticKeyword)) continue;
    if (ts.getJSDocTags(m).some((tag) => tag.tagName?.text === 'internal')) continue;
    if (EVENT_EMITTER_MEMBERS.has(name)) continue;

    members.push({
      name,
      kind: ts.isGetAccessorDeclaration(m) ? 'getter' : 'method',
    });
  }
  return members;
}

function loadFixtures() {
  const files = readdirSync(FIXTURE_DIR).filter(
    (f) => f.endsWith('.ts') || f.endsWith('.cts') || f.endsWith('.mts'),
  );
  return files
    .map((f) => `// === ${f} ===\n${readFileSync(join(FIXTURE_DIR, f), 'utf8')}`)
    .join('\n');
}

function hasAnyReference(fixtureText, name) {
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const paramRe = new RegExp(`Parameters<\\s*SuperDoc\\[['"]${safe}['"]\\]\\s*>`);
  const returnRe = new RegExp(`ReturnType<\\s*SuperDoc\\[['"]${safe}['"]\\]\\s*>`);
  const callRe = new RegExp(`(?:superdoc|sd)\\.${safe}\\s*\\(`);
  return paramRe.test(fixtureText) || returnRe.test(fixtureText) || callRe.test(fixtureText);
}

// ─── Main ────────────────────────────────────────────────────────────

const members = enumeratePublicMembers();
const fixtures = loadFixtures();
const allowlist = loadAllowlist();
const allowlistedSet = new Set(Object.keys(allowlist));

const uncoveredNow = members
  .filter((m) => !allowlistedSet.has(m.name))
  .filter((m) => !hasAnyReference(fixtures, m.name))
  .map((m) => m.name)
  .sort();

if (writeMode) {
  writeSnapshot(uncoveredNow);
  console.log(
    `[public-method-coverage] wrote ${SNAPSHOT_PATH.replace(REPO_ROOT + '/', '')} (${uncoveredNow.length} entries).`,
  );
  process.exit(0);
}

const snapshot = loadSnapshot();
const snapshotSet = new Set(snapshot);
const uncoveredSet = new Set(uncoveredNow);

const newUncovered = uncoveredNow.filter((n) => !snapshotSet.has(n));
const stale = snapshot.filter((n) => !uncoveredSet.has(n));

const HR = '='.repeat(72);
console.log('[public-method-coverage] SuperDoc public-surface fixture coverage');
console.log(HR);
console.log(`Members inspected:           ${members.length}`);
console.log(`  Methods (non-EventEmitter): ${members.filter((m) => m.kind === 'method').length}`);
console.log(`  Getters:                    ${members.filter((m) => m.kind === 'getter').length}`);
console.log(`Allowlisted (with reason):    ${allowlistedSet.size}`);
console.log(`Tracked as known debt:        ${uncoveredNow.length - newUncovered.length}`);
console.log(`Snapshot at:                  ${SNAPSHOT_PATH.replace(REPO_ROOT + '/', '')}`);
console.log('');

const failures = [];
if (newUncovered.length > 0) {
  failures.push(
    `${newUncovered.length} NEW public member(s) without any fixture reference:`,
  );
  for (const n of newUncovered) failures.push(`  + ${n}`);
  failures.push('');
  failures.push(
    `Add a consumer fixture under tests/consumer-typecheck/src/ asserting`,
  );
  failures.push(
    `Parameters<SuperDoc['<name>']>, ReturnType<SuperDoc['<name>']>, or a real call site.`,
  );
  failures.push(
    `If the member is intentionally not consumer-callable, add an entry with`,
  );
  failures.push(
    `a one-line reason to public-method-coverage-allowlist.cjs.`,
  );
}
if (stale.length > 0) {
  if (failures.length > 0) failures.push('');
  failures.push(`${stale.length} stale entry/entries in the debt snapshot (fixture coverage now exists):`);
  for (const n of stale) failures.push(`  - ${n}`);
  failures.push('');
  failures.push(
    `Run \`node tests/consumer-typecheck/check-public-method-coverage.mjs --write\``,
  );
  failures.push(`to refresh the snapshot and lock in the win.`);
}

if (failures.length > 0) {
  console.log('FAIL  fixture coverage drift:');
  for (const line of failures) console.log(line);
  process.exit(1);
}

console.log(`OK    ${members.length - allowlistedSet.size} public members; ${uncoveredNow.length} tracked as known debt; ratchet snapshot in sync.`);
process.exit(0);
