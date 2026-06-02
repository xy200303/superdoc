/**
 * `@superdoc/font-system` - runtime font registry, load-state, and logical->physical
 * resolution shared across the SuperDoc rendering pipeline.
 *
 * Consumed by measurement (`@superdoc/measuring-dom`), paint (`painters/dom`),
 * and the editor core (`@superdoc/super-editor`) so all three agree on which
 * physical face is used and whether it is ready. Separate from
 * `@superdoc/font-utils` (CSS fallback-string composition only).
 *
 * Surfaces: the load-state contract + `FontRegistry` (a registry per `FontFaceSet`);
 * the resolver (`resolveFontFamily`/`resolvePhysicalFamily`, e.g. Calibri->Carlito);
 * and a `fontConfigVersion` epoch that reuse signatures fold in so a font change busts
 * stale measure/paint reuse. The bundled substitute pack ships from the `./bundled`
 * subpath; the public DX surface (T7) builds on `FontRegistry.register`.
 */
export type {
  FontLoadStatus,
  FontFaceSource,
  FontFaceDescriptor,
  RegisteredFace,
  FontLoadResult,
  FontLoadSummary,
  RequiredFace,
} from './types';
export { SETTLED_STATUSES, isSettled } from './types';

export type { FontResolution, FontResolutionReason } from './resolver';
export {
  resolveFontFamily,
  resolvePhysicalFamily,
  resolvePrimaryPhysicalFamily,
  resolvePhysicalFamilies,
} from './resolver';

export { getFontConfigVersion, bumpFontConfigVersion, __resetFontConfigVersion } from './epoch';

export type { FontResolutionRecord } from './report';
export { buildFontReport } from './report';

export type { FontSetLike, FontFaceLike, FontFaceCtor, FontRegistryOptions } from './registry';
export {
  FontRegistry,
  getFontRegistryFor,
  getDefaultFontRegistry,
  DEFAULT_FONT_LOAD_TIMEOUT_MS,
  __resetDefaultFontRegistry,
} from './registry';
