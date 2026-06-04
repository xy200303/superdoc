/**
 * Logical -> physical font resolution.
 *
 * A document refers to a font by its *logical* family - the name Word wrote, e.g.
 * "Calibri". The browser may not have that font (it is proprietary), so SuperDoc
 * renders a metric-compatible *physical* substitute - e.g. Carlito, whose advance
 * widths match Calibri so line breaks land where Word puts them. The logical name
 * stays the source of truth (toolbar, export); only measurement and paint use the
 * physical family, and they MUST use the same one or text is measured in one font
 * and painted in another.
 *
 * The value reaching measure and paint is a CSS font-family *stack* the layout
 * builds via `toCssFontFamily`, e.g. "Calibri, sans-serif" - so resolution applies
 * to the PRIMARY family and keeps the remaining fallbacks ("Carlito, sans-serif").
 *
 * Resolution is a {@link FontResolver} INSTANCE, not a global: each document gets its
 * own so two editors on one page can map the same logical family differently (a
 * customer `fonts.map`) without leaking across documents - the same per-document
 * isolation the registry already has per `FontFaceSet`. Every instance is seeded with
 * the five verified clean clones (Calibri->Carlito, Cambria->Caladea, Arial->Liberation
 * Sans, Times New Roman->Liberation Serif, Courier New->Liberation Mono). The
 * module-level `resolve*` functions delegate to a shared default instance for callers
 * that have no document context (and for backward compatibility).
 */

export type FontResolutionReason =
  /** No substitute is known; the requested family is used as-is. */
  | 'as_requested'
  /** Replaced by a bundled metric-compatible clone. */
  | 'bundled_substitute'
  /** Replaced by a runtime mapping set on this document's resolver (customer `fonts.map`). */
  | 'custom_mapping';

export interface FontResolution {
  /** The family the document asked for (preserved for toolbar/export). */
  logicalFamily: string;
  /** The bare physical family that is actually loaded, measured, and painted. */
  physicalFamily: string;
  reason: FontResolutionReason;
}

/**
 * Logical (normalized) -> physical family. Lowercased, quote-stripped keys.
 *
 * Only metric-verified clean clones (advance widths + OS/2 line metrics match the Word
 * original) belong here. Each target MUST be a family the bundled pack supplies
 * (see `bundled.ts`). Aptos/Georgia are intentionally absent - no clean clone yet.
 */
const BUNDLED_SUBSTITUTES: Readonly<Record<string, string>> = Object.freeze({
  calibri: 'Carlito',
  cambria: 'Caladea',
  arial: 'Liberation Sans',
  'times new roman': 'Liberation Serif',
  'courier new': 'Liberation Mono',
});

/** Normalize a family name for lookup: trim, strip surrounding quotes, lowercase. */
function normalizeFamilyKey(family: string): string {
  return family
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase();
}

/** Split a CSS font-family value into trimmed, non-empty families (primary first). */
function splitStack(cssFontFamily: string): string[] {
  return cssFontFamily
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Per-document logical -> physical font resolver. Seeded with the bundled clean-clone
 * map; also holds per-instance runtime overrides (a customer `fonts.map`). Because each
 * document owns its instance, two documents can map the same logical family to different
 * physical families without interfering. Its {@link signature} (NOT the numeric
 * {@link version}) is the identity measure-cache keys and paint reuse signatures must fold in,
 * so two documents at the same version with different mappings never collide.
 */
export class FontResolver {
  /** Normalized logical family -> physical family. Takes precedence over the bundled map. */
  readonly #overrides = new Map<string, string>();
  #version = 0;

  /**
   * Map a logical family to a physical render family for this document, overriding the
   * bundled default (e.g. "Georgia" -> "Gelasio", or a customer family -> their font).
   * The physical family must be one the registry can load.
   */
  map(logicalFamily: string, physicalFamily: string): void {
    const key = normalizeFamilyKey(logicalFamily);
    // The physical name is the bare family the registry loads and CSS renders, so trim
    // surrounding whitespace (" Gelasio " and "Gelasio" must be one mapping, not two).
    const physical = physicalFamily?.trim();
    if (!key || !physical) return;
    if (this.#overrides.get(key) === physical) return;
    this.#overrides.set(key, physical);
    this.#version += 1;
  }

  /** Remove a runtime mapping; the family reverts to its bundled default (or identity). */
  unmap(logicalFamily: string): void {
    if (this.#overrides.delete(normalizeFamilyKey(logicalFamily))) this.#version += 1;
  }

  /**
   * Drop all runtime overrides, reverting to the bundled-only map. Call on a document swap
   * (the same editor instance is reused, so the prior document's `fonts.map` must not leak
   * into the next). Bumps {@link version} only if something was actually cleared.
   */
  reset(): void {
    if (this.#overrides.size === 0) return;
    this.#overrides.clear();
    this.#version += 1;
  }

  /** Monotonic version; bumps on every mapping change. A lightweight "did it change" signal. */
  get version(): number {
    return this.#version;
  }

  /**
   * Stable content signature of this resolver's runtime mappings - the deterministic,
   * order-independent serialization of its overrides. This (NOT {@link version}) is what
   * measure-cache keys and paint reuse signatures must fold in: two documents can both be at
   * version 1 with DIFFERENT mappings (Georgia->Gelasio vs Georgia->Tinos), and a numeric
   * version would collide; their signatures differ. Empty (no overrides) is `''`, so all
   * default documents share cache safely because they resolve identically.
   */
  get signature(): string {
    if (this.#overrides.size === 0) return '';
    // JSON of sorted [logical, physical] pairs: deterministic and collision-safe even when a
    // font name contains punctuation (a delimited "logical=physical|..." form would not be).
    return JSON.stringify([...this.#overrides.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  /** The physical family + why, for a bare logical name. Overrides beat the bundled map. */
  #physicalFor(bareFamily: string): { physical: string; reason: FontResolutionReason } {
    const key = normalizeFamilyKey(bareFamily);
    const override = this.#overrides.get(key);
    if (override) return { physical: override, reason: 'custom_mapping' };
    const bundled = BUNDLED_SUBSTITUTES[key];
    if (bundled) return { physical: bundled, reason: 'bundled_substitute' };
    return { physical: bareFamily, reason: 'as_requested' };
  }

  /**
   * Structured resolution of a logical family (or CSS stack) to its bare physical render
   * family. The primary (first) family drives the result; this is what the load gate
   * awaits and what diagnostics report.
   */
  resolveFontFamily(logicalFamily: string): FontResolution {
    const parts = splitStack(logicalFamily);
    const primary = parts[0] ?? logicalFamily;
    const { physical, reason } = this.#physicalFor(primary);
    return { logicalFamily, physicalFamily: physical, reason };
  }

  /**
   * Resolve a CSS font-family value for MEASURE and PAINT: swap the primary family to its
   * physical substitute and keep the original fallbacks. "Calibri, sans-serif" ->
   * "Carlito, sans-serif"; "Calibri" -> "Carlito". An unmapped value is returned unchanged.
   */
  resolvePhysicalFamily(cssFontFamily: string): string {
    if (!cssFontFamily) return cssFontFamily;
    const parts = splitStack(cssFontFamily);
    if (parts.length === 0) return cssFontFamily;
    const { physical, reason } = this.#physicalFor(parts[0]);
    if (reason === 'as_requested') return cssFontFamily;
    return [physical, ...parts.slice(1)].join(', ');
  }

  /**
   * The bare physical family the load gate must await - the primary family resolved to its
   * substitute. "Calibri, sans-serif" -> "Carlito"; "Calibri" -> "Carlito".
   */
  resolvePrimaryPhysicalFamily(family: string): string {
    const parts = splitStack(family);
    const primary = parts[0] ?? family;
    return this.#physicalFor(primary).physical;
  }

  /** The deduped set of physical face families a set of logical families needs loaded. */
  resolvePhysicalFamilies(families: Iterable<string>): string[] {
    const out = new Set<string>();
    for (const family of families) {
      if (family) out.add(this.resolvePrimaryPhysicalFamily(family));
    }
    return [...out];
  }
}

/** Create a per-document resolver seeded with the bundled clean-clone map. */
export function createFontResolver(): FontResolver {
  return new FontResolver();
}

/**
 * Shared default resolver for callers without a document context. Document rendering
 * threads its OWN {@link FontResolver} (so per-document `map` stays isolated); these
 * module functions delegate here and preserve the prior global behavior.
 */
const defaultResolver = new FontResolver();

export function resolveFontFamily(logicalFamily: string): FontResolution {
  return defaultResolver.resolveFontFamily(logicalFamily);
}

export function resolvePhysicalFamily(cssFontFamily: string): string {
  return defaultResolver.resolvePhysicalFamily(cssFontFamily);
}

export function resolvePrimaryPhysicalFamily(family: string): string {
  return defaultResolver.resolvePrimaryPhysicalFamily(family);
}

export function resolvePhysicalFamilies(families: Iterable<string>): string[] {
  return defaultResolver.resolvePhysicalFamilies(families);
}
