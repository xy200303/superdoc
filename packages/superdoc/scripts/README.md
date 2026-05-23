# SuperDoc public-interface validation scripts

This directory holds the scripts that validate the published SuperDoc package's
public TypeScript surface. The repository also has a Document API public
interface under `packages/document-api/scripts/`; both are summarized here so
contributors have one place to learn the system.

If you only have time for one sentence: **run `pnpm check:public` before
opening or merging anything that touches public types.** It's the
public type/interface preflight — it does not replace `pnpm test` or
`pnpm build` for product correctness.

---

## TL;DR — what command to run when

| Question | Command | Speed | Mutates files? |
|---|---|---|---|
| Are public interfaces safe? | `pnpm check:public` | ~5 min | no |
| TypeScript compiles cleanly? | `pnpm check:types` | seconds | no |
| Only SuperDoc public surface changed? | `pnpm check:public:superdoc` | ~3 min | no |
| Only Document API contract changed? | `pnpm check:public:docapi` | seconds | no |
| Regenerate Document API artifacts after editing the contract? | `pnpm generate:docapi` | seconds | **yes** |
| Quickly see public-contract tier metadata? | `pnpm report:public:superdoc` | seconds | no |

`check:*` commands are non-mutating and safe to run anywhere. `generate:*`
commands write to the worktree (commit the changes). `report:*` commands are
read-only and not CI gates.

---

## Vocabulary

The repo's typed surface is split into two "public interfaces":

- **SuperDoc** — the `superdoc` npm package. Public types and runtime exports
  flow through `packages/superdoc/src/public/index.ts` and the subpath
  facades (`./types`, `./ui`, `./ui/react`, `./headless-toolbar`, etc.).
- **Document API** — `editor.doc.*` programmatic API typed in
  `packages/document-api/src/`. Built as TypeScript-only; the contract lives
  in `operation-definitions.ts` and several artifacts are generated from it.

Both are validated by the same root-level catch-all (`pnpm check:public`)
but have separate script chains because the validation needs differ.

---

## Command catalog (root `package.json`)

### Public-interface validation

| Command | Runs | What it gates |
|---|---|---|
| `check:public` | `check:public:superdoc` + `check:public:docapi` | Both public interfaces. The umbrella to run before merging. |
| `check:public:superdoc` | `check:public-contract` (legacy alias) | SuperDoc package: vite build + postbuild chain, consumer typecheck matrix, deep-type audit. |
| `check:public:docapi` | `docapi:check` (legacy alias) | Document API: contract parity, generated outputs are not stale, examples compile, overview alignment. **Requires generated artifacts to be up-to-date** — if it fails on staleness, run `generate:docapi` to refresh. |
| `report:public:superdoc` | `report:public-contract` (legacy alias) | Read-only tier metadata (supported / legacy / asset / deprecated). Not a gate. |

### TypeScript compiler

| Command | Runs | What it gates |
|---|---|---|
| `check:types` | `type-check` (legacy alias) | `tsc -b tsconfig.references.json` — raw TS compile across all referenced projects. Does NOT run the SuperDoc public-contract chain. |
| `type-check:force` | `tsc -b --force` | Same as above but ignores incremental cache. |

### Generation

| Command | Runs | Mutates? |
|---|---|---|
| `generate:docapi` | `docapi:sync` (legacy alias) | yes — writes Document API artifacts under `packages/document-api/generated/` (gitignored; run before `check:public:docapi` if it fails on missing files). |
| `generate:all` | schemas, SDK clients, tool catalogs, reference docs | yes — multi-target generator. Some outputs are gitignored (`generated/`), others are committed (e.g. `apps/docs/document-api/reference/`); any tracked generated changes should be committed. |

### Legacy aliases

These names predate the standardized vocabulary and stay as `pnpm`
aliases for back-compat. New CI workflows and docs should use the
canonical names above.

| Legacy | Canonical |
|---|---|
| `type-check` | `check:types` |
| `check:public-contract` | `check:public:superdoc` |
| `docapi:check` | `check:public:docapi` |
| `docapi:sync` | `generate:docapi` |
| `docapi:sync:check` | `generate:docapi && check:public:docapi` |
| `report:public-contract` | `report:public:superdoc` |

---

## SuperDoc scripts in this directory

These run as part of `check:public:superdoc` (most via the vite build's
postbuild chain). Each is described by what it gates and what would fail if
it stopped running.

| Script | Stage | Gates | If removed |
|---|---|---|---|
| `type-surface.config.cjs` | data | Canonical taxonomy: relocations, base includes, shared-common targets, allowlists. Source of truth for 5+ other scripts. | Every consumer becomes independent; drift between vite / tsconfig / audit is invisible. |
| `ensure-types.cjs` | postbuild | Rewrites workspace specifiers in emitted `.d.ts` so consumers can resolve them; copies hand-written `.d.ts` files into dist. | Published declarations contain unresolvable `@superdoc/*` imports. |
| `check-tsconfig-type-surface.cjs` | postbuild | Asserts `tsconfig.json#include` equals the union of base + relocation paths in `type-surface.config.cjs`. | tsconfig and vite drift silently; IDE checks diverge from CI. |
| `audit-bundle.cjs` | postbuild | prosemirror-view single-instance check + bundle size budgets. | Duplicate PM instances break collaboration; no size discipline. |
| `audit-declarations.cjs` | postbuild | Rule 1: bare `@superdoc/*` leaks. Rule 2: pnpm-internal paths. Rule 3: `_internal-shims.d.ts` regression. | Private specifiers ship to consumers; consumers hit unresolvable imports. |
| `check-export-coverage.cjs` | postbuild | Every `package.json#exports` subpath carries a `types` field or is on the runtime-only allowlist. | `TS7016` returns for consumers on runtime-only subpaths. |
| `verify-public-facade-emit.cjs` | postbuild | Per-facade expected symbol set + ESM/CJS parity + legacy command-signature compat. Has a hand-maintained `expectedNames` allowlist per facade (consolidation tracked separately). | Symbol set drift ships silently; CJS shims diverge from ESM. |
| `report-declaration-reachability.cjs` | postbuild | Instrumentation (not a gate): per-bucket reachability ratio of emitted declarations. | Loses visibility into unreachable emit (the SD-2952 trim target). |
| `check-jsdoc.cjs` | CI step | Per-file checkJs gate for files in a hand-curated `CHECKED_FILES` allowlist. Currently 6 files. **Note**: `SuperDoc.js` now has `// @ts-check` but is gated by `check:types`, not this script. The 6-file list is a historical ratchet from before the broader enablement; consolidating with `check:types` is tracked separately. | A targeted regression on one of the 6 ratcheted files ships silently. |

---

## Consumer-typecheck infrastructure (`tests/consumer-typecheck/`)

These run against the **packed and installed** tarball, so they validate
what an actual consumer would see — not the workspace source.

| Script | Gates | Notes |
|---|---|---|
| `typecheck-matrix.mjs` | 83 scenarios across module resolution (bundler/node16/nodenext) × strict × skipLibCheck × import path. | Packs the superdoc tarball into `node_modules/` once; later scripts reuse the install. |
| `deep-type-audit.mjs --strict-supported-root` | Walks every type reachable from `superdoc`'s public exports; fails on `any` leaks at any depth. | Compares against a committed allowlist; new findings fail, stale findings fail. |
| `snapshot.mjs --all --check` | No-growth snapshots: super-editor package exports, legacy subpath exports, root facade symbol inventory. | `--write` regenerates snapshots. |
| `check-all-public-types-fixture.mjs` | Asserts every type-only root export has an `AssertNotAny<T>` line in `src/all-public-types.ts`. | Derives the expected set from `superdoc-root-classification.json`. |
| `package-shape-gate.mjs` | External package-shape linters (publint + attw) against the packed tarball. | Catches condition ordering, masquerading exports, missing field declarations. |
| `check-root-classification-closure.mjs` | Asserts no `supported-root` or `legacy-root` export references an `internal-candidate` symbol in its public declared type. | Closure rule from SD-3212. |

`check:public:superdoc` runs all six in order. `typecheck-matrix` packs
`superdoc.tgz` and installs it into the consumer fixture. The rest
reuse what matrix produced: `deep-type-audit`, `snapshot --all
--check`, and `check-root-classification-closure` read from the
installed fixture in `node_modules/superdoc/`; `package-shape-gate`
runs `publint` / `attw` against the packed tarball at
`packages/superdoc/superdoc.tgz` directly. CI (`ci-superdoc.yml`) and
release workflows (`release-superdoc.yml`, `release-stable.yml`) call
`pnpm check:public:superdoc --skip-build` directly — no duplicated step
lists.

---

## Document API scripts (`packages/document-api/scripts/`)

The Document API is contract-first: `operation-definitions.ts` is the
canonical source, and several artifacts are generated from it.

| Script | Phase | What it does |
|---|---|---|
| `generate-contract-outputs.ts` | generate | Writes `generated/schemas/**` + `generated/agent/**` from the contract. Called by `generate:docapi`. |
| `check-contract-parity.ts` | check | Asserts derived maps (`operation-registry`, `invoke`, etc.) project from `operation-definitions` correctly. |
| `check-contract-outputs.ts` | check | Asserts the committed `generated/**` files match what regeneration would produce. Fails if stale. |
| `check-examples.ts` | check | Asserts contract examples compile. |
| `check-overview-alignment.ts` | check | Asserts the documentation overview reflects the current operation set. |

The four `check-*` scripts run together via `check:public:docapi`.
Currently they require `generate:docapi` to have run first (the
stale-file check trips otherwise). Making the check self-contained
(in-memory generate and compare) is tracked as a follow-up.

---

## Dataflow

```
type-surface.config.cjs               (single source of truth)
   │
   ├─ vite.config.js              ──> emits dist/**/*.d.ts
   ├─ tsconfig.json#include       ──> typecheck source tree
   ├─ ensure-types.cjs            ──> rewrites + copies in dist
   ├─ check-tsconfig-type-surface ──> tsconfig parity gate
   └─ audit-declarations.cjs      ──> reads relocationGuardPackages

src/public/index.ts                  (declarative root facade)
   │
   ├─ vite-plugin-dts             ──> emits public/index.d.ts
   ├─ verify-public-facade-emit   ──> expected names allowlist
   ├─ snapshot.mjs (root family)  ──> drift snapshot
   └─ check-all-public-types-fixture ──> consumer fixture coverage

packages/document-api/src/contract/operation-definitions.ts
   │
   ├─ generate-contract-outputs   ──> writes generated/**
   ├─ check-contract-parity       ──> registry/invoke drift gate
   └─ check-contract-outputs      ──> committed-vs-fresh gate
```

---

## CI vs local

All three SuperDoc lanes call the same wrapper:

- **`ci-superdoc.yml`** (PR CI) — `pnpm check:public:superdoc --skip-build` after the Build step.
- **`release-superdoc.yml`** (preview/dev release) — same.
- **`release-stable.yml`** (stable release) — same.

The wrapper enforces every SuperDoc public-surface gate in one place.
A change to the validation chain (adding a stage, reordering, renaming)
lands in `scripts/check-public-contract.mjs` and propagates to all
three lanes automatically.

Local pre-commit: just run `pnpm check:public`. If anything fails, the
failure message tells you which script and (for `check:public:docapi`)
which command to run to regenerate missing or stale artifacts.
