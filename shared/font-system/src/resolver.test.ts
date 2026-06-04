import { describe, it, expect } from 'vitest';
import {
  resolveFontFamily,
  resolvePhysicalFamily,
  resolvePrimaryPhysicalFamily,
  resolvePhysicalFamilies,
  createFontResolver,
} from './index';

describe('font resolver', () => {
  it('maps the five verified clean clones (bare names)', () => {
    expect(resolvePhysicalFamily('Calibri')).toBe('Carlito');
    expect(resolvePhysicalFamily('Cambria')).toBe('Caladea');
    expect(resolvePhysicalFamily('Arial')).toBe('Liberation Sans');
    expect(resolvePhysicalFamily('Times New Roman')).toBe('Liberation Serif');
    expect(resolvePhysicalFamily('Courier New')).toBe('Liberation Mono');
  });

  it('resolves the PRIMARY family of a CSS stack and keeps the fallbacks', () => {
    // The real shape reaching measure/paint (toCssFontFamily output).
    expect(resolvePhysicalFamily('Calibri, sans-serif')).toBe('Carlito, sans-serif');
    expect(resolvePhysicalFamily('Times New Roman, serif')).toBe('Liberation Serif, serif');
    expect(resolvePhysicalFamily('Calibri , Arial , sans-serif')).toBe('Carlito, Arial, sans-serif');
  });

  it('is case- and quote-insensitive on the primary name', () => {
    expect(resolvePhysicalFamily('"CAMBRIA", serif')).toBe('Caladea, serif');
    expect(resolvePhysicalFamily('courier new')).toBe('Liberation Mono');
  });

  it('passes through a family with no known substitute', () => {
    expect(resolvePhysicalFamily('Verdana, sans-serif')).toBe('Verdana, sans-serif');
    expect(resolveFontFamily('Verdana')).toEqual({
      logicalFamily: 'Verdana',
      physicalFamily: 'Verdana',
      reason: 'as_requested',
    });
    // Aptos/Georgia have no clean clone yet -> not mapped.
    expect(resolvePhysicalFamily('Aptos')).toBe('Aptos');
    expect(resolvePhysicalFamily('Georgia')).toBe('Georgia');
  });

  it('reports the substitution reason + preserves the logical family', () => {
    expect(resolveFontFamily('Cambria')).toEqual({
      logicalFamily: 'Cambria',
      physicalFamily: 'Caladea',
      reason: 'bundled_substitute',
    });
    expect(resolveFontFamily('Calibri, sans-serif').logicalFamily).toBe('Calibri, sans-serif');
  });

  it('extracts the bare physical face the gate must await', () => {
    expect(resolvePrimaryPhysicalFamily('Arial, sans-serif')).toBe('Liberation Sans');
    expect(resolvePrimaryPhysicalFamily('Verdana, sans-serif')).toBe('Verdana');
  });

  it('resolvePhysicalFamilies dedupes to the loadable face names', () => {
    expect(resolvePhysicalFamilies(['Calibri, sans-serif', 'Cambria', 'Calibri', 'Verdana']).sort()).toEqual([
      'Caladea',
      'Carlito',
      'Verdana',
    ]);
  });
});

describe('FontResolver (per-document context)', () => {
  it('is seeded with the bundled clean-clone map', () => {
    const resolver = createFontResolver();
    expect(resolver.resolvePrimaryPhysicalFamily('Calibri')).toBe('Carlito');
    expect(resolver.resolvePhysicalFamily('Arial, sans-serif')).toBe('Liberation Sans, sans-serif');
    expect(resolver.version).toBe(0);
  });

  it('map() overrides the bundled default and reports custom_mapping', () => {
    const resolver = createFontResolver();
    resolver.map('Georgia', 'Gelasio');
    expect(resolver.resolvePrimaryPhysicalFamily('Georgia, serif')).toBe('Gelasio');
    expect(resolver.resolveFontFamily('Georgia')).toEqual({
      logicalFamily: 'Georgia',
      physicalFamily: 'Gelasio',
      reason: 'custom_mapping',
    });
    // An override beats the bundled map for the same logical family.
    resolver.map('Calibri', 'MyCalibri');
    expect(resolver.resolvePrimaryPhysicalFamily('Calibri')).toBe('MyCalibri');
  });

  it('version bumps on each distinct mapping change, not on no-ops', () => {
    const resolver = createFontResolver();
    resolver.map('Georgia', 'Gelasio');
    expect(resolver.version).toBe(1);
    resolver.map('Georgia', 'Gelasio'); // same -> no bump
    expect(resolver.version).toBe(1);
    resolver.unmap('Georgia');
    expect(resolver.version).toBe(2);
    resolver.unmap('Georgia'); // absent -> no bump
    expect(resolver.version).toBe(2);
    expect(resolver.resolvePrimaryPhysicalFamily('Georgia')).toBe('Georgia'); // reverted to identity
  });

  it('isolates mappings per instance: two documents map the same logical family differently', () => {
    const docA = createFontResolver();
    const docB = createFontResolver();
    docA.map('Georgia', 'Gelasio');
    docB.map('Georgia', 'Tinos');

    expect(docA.resolvePrimaryPhysicalFamily('Georgia')).toBe('Gelasio');
    expect(docB.resolvePrimaryPhysicalFamily('Georgia')).toBe('Tinos');
    // A document with no override still gets the bundled default, unaffected by the others.
    expect(createFontResolver().resolvePrimaryPhysicalFamily('Georgia')).toBe('Georgia');
    expect(docA.resolvePrimaryPhysicalFamily('Calibri')).toBe('Carlito'); // bundled map intact
  });

  it('signature is stable, order-independent, and distinguishes different mappings at the same version', () => {
    const empty = createFontResolver();
    expect(empty.signature).toBe(''); // default docs share cache safely

    const docA = createFontResolver();
    docA.map('Georgia', 'Gelasio');
    const docB = createFontResolver();
    docB.map('Georgia', 'Tinos');
    // Same version (1), DIFFERENT mappings -> signatures MUST differ (else measure/paint collide).
    expect(docA.version).toBe(docB.version);
    expect(docA.signature).not.toBe(docB.signature);

    // Order-independent: the same set of mappings yields the same signature regardless of insertion order.
    const x = createFontResolver();
    x.map('Georgia', 'Gelasio');
    x.map('Arial', 'MyArial');
    const y = createFontResolver();
    y.map('Arial', 'MyArial');
    y.map('Georgia', 'Gelasio');
    expect(x.signature).toBe(y.signature);

    // Identical mapping -> identical signature (safe cross-document cache sharing).
    const z = createFontResolver();
    z.map('Georgia', 'Gelasio');
    expect(z.signature).toBe(docA.signature);
  });

  it('reset() drops all overrides (document swap) and reverts to the bundled-only map', () => {
    const resolver = createFontResolver();
    resolver.map('Georgia', 'Gelasio');
    resolver.map('Calibri', 'MyCalibri');
    expect(resolver.signature).not.toBe('');

    resolver.reset();
    expect(resolver.signature).toBe(''); // back to default identity
    expect(resolver.resolvePrimaryPhysicalFamily('Georgia')).toBe('Georgia'); // override gone
    expect(resolver.resolvePrimaryPhysicalFamily('Calibri')).toBe('Carlito'); // bundled default restored
    expect(resolver.version).toBe(3); // 2 maps + 1 reset

    const before = resolver.version;
    resolver.reset(); // already empty -> no-op, no version bump
    expect(resolver.version).toBe(before);
  });

  it('trims the physical family and ignores empty/whitespace mappings', () => {
    const resolver = createFontResolver();
    resolver.map('Georgia', '  Gelasio  ');
    expect(resolver.resolvePrimaryPhysicalFamily('Georgia')).toBe('Gelasio'); // trimmed
    expect(resolver.version).toBe(1);
    resolver.map('Georgia', 'Gelasio'); // same after trim -> no bump
    expect(resolver.version).toBe(1);
    resolver.map('Tahoma', '   '); // whitespace-only physical -> ignored
    expect(resolver.resolvePrimaryPhysicalFamily('Tahoma')).toBe('Tahoma');
    expect(resolver.version).toBe(1);
  });
});
