import type { Receipt, TrackChangeInfo, TrackChangesListQuery, TrackChangesListResult } from '../types/index.js';
import type { StoryLocator } from '../types/story.types.js';
import type { TextTarget } from '../types/address.js';
import type { RevisionGuardOptions } from '../write/write.js';
import { DocumentApiValidationError } from '../errors.js';

export type TrackChangesListInput = TrackChangesListQuery;

export interface TrackChangesGetInput {
  id: string;
  /** Story containing the tracked change. Omit for body (backward compatible). */
  story?: StoryLocator;
}

export interface TrackChangesAcceptInput {
  id: string;
  /** Story containing the tracked change. Omit for body (backward compatible). */
  story?: StoryLocator;
}

export interface TrackChangesRejectInput {
  id: string;
  /** Story containing the tracked change. Omit for body (backward compatible). */
  story?: StoryLocator;
}

export type TrackChangesAcceptAllInput = Record<string, never>;

export type TrackChangesRejectAllInput = Record<string, never>;

/**
 * Range target for partial-range decisions.
 *
 * `range` is a canonical {@link TextTarget}; the engine resolves the
 * selected overlap with each affected logical tracked change and applies
 * the {@link https://www.w3.org/TR/selection-api/ selection-style} partial
 * resolution rules from the tracked-changes spec § 9.
 */
export interface TrackChangesRangeInput {
  range: TextTarget;
  /** Story containing the range. Omit for body (backward compatible). */
  story?: StoryLocator;
}

// ---------------------------------------------------------------------------
// trackChanges.decide: consolidated accept/reject operation
// ---------------------------------------------------------------------------

/**
 * Canonical decide input shape per
 * `../labs/tests/requirements/specs/tracked-changes-comments/tracked-changes-spec.md`
 * § 9. The legacy `{ id }` and `{ scope: 'all' }` aliases are preserved during
 * the migration window so existing headless callers keep working; the executor
 * normalizes them into the canonical `{ kind: ... }` form before dispatch.
 */
export type ReviewDecisionTarget =
  | { kind: 'id'; id: string; story?: StoryLocator }
  | { kind: 'range'; range: TextTarget; story?: StoryLocator; part?: string }
  | { kind: 'all'; story?: StoryLocator | 'all' }
  // Legacy aliases — kept for backwards compatibility with the previous
  // call shape. Emitted as deprecation diagnostics during normalization.
  | { id: string; story?: StoryLocator; kind?: undefined }
  | { scope: 'all'; kind?: undefined };

export type ReviewDecideInput =
  | { decision: 'accept'; target: ReviewDecisionTarget }
  | { decision: 'reject'; target: ReviewDecisionTarget };

export interface TrackChangesAdapter {
  /** List tracked changes matching the given query. */
  list(input?: TrackChangesListInput): TrackChangesListResult;
  /** Retrieve full information for a single tracked change. */
  get(input: TrackChangesGetInput): TrackChangeInfo;
  /** Accept a tracked change, applying it to the document. */
  accept(input: TrackChangesAcceptInput, options?: RevisionGuardOptions): Receipt;
  /** Reject a tracked change, reverting it from the document. */
  reject(input: TrackChangesRejectInput, options?: RevisionGuardOptions): Receipt;
  /** Accept all tracked changes in the document. */
  acceptAll(input: TrackChangesAcceptAllInput, options?: RevisionGuardOptions): Receipt;
  /** Reject all tracked changes in the document. */
  rejectAll(input: TrackChangesRejectAllInput, options?: RevisionGuardOptions): Receipt;
  /**
   * Accept or reject a tracked-change selection range. Adapters
   * that have not been updated to handle `kind: 'range'` may return a
   * `CAPABILITY_UNAVAILABLE` failure receipt; the document-api executor
   * surfaces that to callers without falling back to the legacy id/all
   * paths because their semantics are not equivalent.
   */
  decideRange?(
    input: { decision: 'accept' | 'reject' } & TrackChangesRangeInput,
    options?: RevisionGuardOptions,
  ): Receipt;
}

/** Public surface for trackChanges on DocumentApi. */
export interface TrackChangesApi {
  list(input?: TrackChangesListInput): TrackChangesListResult;
  get(input: TrackChangesGetInput): TrackChangeInfo;
  decide(input: ReviewDecideInput, options?: RevisionGuardOptions): Receipt;
}

/**
 * Execute wrappers below are the canonical interception point for input
 * normalization and validation before delegating to the adapter.
 */
export function executeTrackChangesList(
  adapter: TrackChangesAdapter,
  input?: TrackChangesListInput,
): TrackChangesListResult {
  return adapter.list(input);
}

export function executeTrackChangesGet(adapter: TrackChangesAdapter, input: TrackChangesGetInput): TrackChangeInfo {
  const raw = input as unknown;
  if (typeof raw !== 'object' || raw == null) {
    throw new DocumentApiValidationError('INVALID_INPUT', 'trackChanges.get input must be a non-null object.', {
      value: raw,
    });
  }
  const { id } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || id.length === 0) {
    throw new DocumentApiValidationError('INVALID_INPUT', 'trackChanges.get id must be a non-empty string.', {
      field: 'id',
      value: id,
    });
  }
  return adapter.get(input);
}

/**
 * Executes the consolidated `trackChanges.decide` operation by routing to the
 * appropriate adapter method based on the discriminated input.
 *
 * Accepting/rejecting changes is a resolution action, not a content mutation -
 * changeMode and dryRun are not applicable, so this accepts
 * {@link RevisionGuardOptions} rather than `MutationOptions`.
 */
export function executeTrackChangesDecide(
  adapter: TrackChangesAdapter,
  rawInput: ReviewDecideInput,
  options?: RevisionGuardOptions,
): Receipt {
  // Dynamic invoke callers may pass arbitrary values: validate before narrowing.
  const raw = rawInput as unknown;

  if (typeof raw !== 'object' || raw == null) {
    throw new DocumentApiValidationError('INVALID_INPUT', 'trackChanges.decide input must be a non-null object.', {
      value: raw,
    });
  }

  const input = raw as Record<string, unknown>;

  if (input.decision !== 'accept' && input.decision !== 'reject') {
    throw new DocumentApiValidationError(
      'INVALID_INPUT',
      `trackChanges.decide decision must be "accept" or "reject", got "${String(input.decision)}".`,
      { field: 'decision', value: input.decision },
    );
  }

  if (typeof input.target !== 'object' || input.target == null) {
    throw new DocumentApiValidationError(
      'INVALID_TARGET',
      'trackChanges.decide target must be an object with { kind: "id" | "range" | "all" }.',
      { field: 'target', value: input.target },
    );
  }

  const target = input.target as Record<string, unknown>;
  const story = (target as { story?: StoryLocator }).story;
  const decision = input.decision as 'accept' | 'reject';

  // Canonical shape: `{ kind: 'id' | 'range' | 'all' }`.
  if (target.kind === 'id') {
    if (typeof target.id !== 'string' || target.id.length === 0) {
      throw new DocumentApiValidationError(
        'INVALID_TARGET',
        'trackChanges.decide target.kind = "id" requires a non-empty id.',
        { field: 'target', value: input.target },
      );
    }
    if (decision === 'accept') return adapter.accept({ id: target.id, ...(story ? { story } : {}) }, options);
    return adapter.reject({ id: target.id, ...(story ? { story } : {}) }, options);
  }

  if (target.kind === 'range') {
    if (typeof adapter.decideRange !== 'function') {
      return {
        success: false,
        failure: {
          code: 'CAPABILITY_UNAVAILABLE',
          message: 'trackChanges.decide range targets are not supported by the active adapter.',
          details: { target: input.target },
        },
      };
    }
    const range = target.range as TextTarget;
    if (
      !range ||
      typeof range !== 'object' ||
      range.kind !== 'text' ||
      !Array.isArray(range.segments) ||
      range.segments.length === 0
    ) {
      throw new DocumentApiValidationError(
        'INVALID_TARGET',
        'trackChanges.decide target.kind = "range" requires a non-empty TextTarget range.',
        { field: 'target.range', value: target.range },
      );
    }
    return adapter.decideRange({ decision, range, ...(story ? { story } : {}) }, options);
  }

  if (target.kind === 'all') {
    if (decision === 'accept') return adapter.acceptAll({} as TrackChangesAcceptAllInput, options);
    return adapter.rejectAll({} as TrackChangesRejectAllInput, options);
  }

  // Legacy aliases — `{ id }` / `{ scope: 'all' }`. Preserved for backwards
  // compatibility per the closed product decision in `phase0-checkpoint.md`.
  const isAll = target.scope === 'all';
  if (!isAll) {
    if (typeof target.id !== 'string' || target.id.length === 0) {
      throw new DocumentApiValidationError(
        'INVALID_TARGET',
        'trackChanges.decide target must have { kind: "id" | "range" | "all" } or the legacy { id } / { scope: "all" } shape.',
        { field: 'target', value: input.target },
      );
    }
  }

  if (decision === 'accept') {
    if (isAll) return adapter.acceptAll({} as TrackChangesAcceptAllInput, options);
    return adapter.accept({ id: target.id as string, ...(story ? { story } : {}) }, options);
  }
  if (isAll) return adapter.rejectAll({} as TrackChangesRejectAllInput, options);
  return adapter.reject({ id: target.id as string, ...(story ? { story } : {}) }, options);
}
