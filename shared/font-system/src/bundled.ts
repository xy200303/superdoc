import type { FontRegistry } from './registry';
import { BUNDLED_MANIFEST } from './bundled-manifest';

export type { BundledLicense, BundledFaceFile, BundledFamilyManifest } from './bundled-manifest';
export { BUNDLED_MANIFEST } from './bundled-manifest';

/**
 * Default base URL the bundled `.woff2` are served from. The build emits the pack to a
 * `fonts/` dir alongside the bundle (see the bundled-fonts vite plugin) and the dev
 * server serves the same path, so this default resolves in dev and in a root-served
 * deploy. Consumers serving the bundle under a sub-path override the base via
 * {@link installBundledSubstitutes}. Per-target auto-resolution (e.g. script-relative on
 * a CDN) is a follow-up; this seam is where it plugs in.
 */
export const DEFAULT_BUNDLED_FONT_BASE = '/fonts/';

export interface InstallBundledOptions {
  /** Base URL the `.woff2` are served from. Defaults to {@link DEFAULT_BUNDLED_FONT_BASE}. */
  baseUrl?: string;
}

const installedRegistries = new WeakSet<FontRegistry>();

function withTrailingSlash(base: string): string {
  return base.endsWith('/') ? base : `${base}/`;
}

/**
 * Register the bundled substitute pack into a registry, once, as URL-sourced faces.
 *
 * The pack is one font PROVIDER, no different from customer (`superdoc.fonts.add`) or
 * embedded-DOCX fonts: it registers `url(...)` faces through the same `registry.register`
 * path - it never imports font binaries into shared runtime code, so the bytes are
 * emitted as separate assets and are never inlined into the JS bundle.
 *
 * Loading stays lazy at the binary level: a face's `.woff2` is only fetched when the load
 * gate awaits the physical family a document declares (resolved from `getDocumentFonts()`),
 * not when it is registered. Idempotent per registry; editors sharing a document's
 * `FontFaceSet` install the pack once. The physical family names MUST match the resolver's
 * substitute targets (logical->physical is the resolver's job; this pack supplies the bytes).
 */
export function installBundledSubstitutes(registry: FontRegistry, options: InstallBundledOptions = {}): void {
  if (installedRegistries.has(registry)) return;
  installedRegistries.add(registry);
  const base = withTrailingSlash(options.baseUrl ?? DEFAULT_BUNDLED_FONT_BASE);
  for (const family of BUNDLED_MANIFEST) {
    for (const face of family.faces) {
      registry.register({
        family: family.family,
        source: `url(${base}${face.file})`,
        descriptors: { weight: face.weight, style: face.style },
      });
    }
  }
}
