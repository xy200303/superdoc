// @ts-check
/**
 * Overlap-aware tracked edit compiler.
 *
 * Single entry point used by tracked text mutation paths:
 *
 *   - `trackedTransaction` (native UI text steps)
 *   - `replaceStep` (text insert/delete/replace step rewrites)
 *   - `addMarkStep` / `removeMarkStep` (tracked run formatting)
 *   - `insertTrackedChange` (document-api tracked writes)
 *   - the existing backspace-to-text-delete `ReplaceAroundStep` conversion
 *   - document-api `write-adapter` and tracked plan-engine text rewrites
 *
 * Callers MUST treat `ok: false` as an abort and MUST NOT fall through to
 * applying the original untracked step.
 *
 * Compiler scope (this plan): text-insert, text-delete, text-replace, and
 * run-formatting intents. Other intents fail closed with
 * `CAPABILITY_UNAVAILABLE`.
 */

import { Slice, Fragment } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { v4 as uuidv4 } from 'uuid';
import { TrackInsertMarkName, TrackDeleteMarkName, TrackFormatMarkName, TrackedFormatMarkNames } from '../constants.js';
import { buildReviewGraph, CanonicalChangeType, SegmentSide } from './review-graph.js';
import { graphHasErrors } from './graph-invariants.js';
import {
  classifyOwnership,
  getCurrentUserIdentity,
  getChangeAuthorIdentity,
  isSameUserHighConfidence,
} from './identity.js';

/**
 * @typedef {import('./edit-intent.js').TrackedEditIntent} TrackedEditIntent
 */

/**
 * @typedef {Object} SelectionHint
 * @property {'near'|'exact-text'} kind
 * @property {number} pos
 * @property {-1|1} [bias]
 */

/**
 * @typedef {Object} GraphDiagnostic
 * @property {string} code
 * @property {'info'|'warning'|'error'} severity
 * @property {string} message
 * @property {string[]} [changeIds]
 * @property {unknown} [details]
 */

/**
 * @typedef {Object} TrackedEditSuccess
 * @property {true} ok
 * @property {import('prosemirror-state').Transaction} tr
 * @property {string[]} createdChangeIds
 * @property {string[]} updatedChangeIds
 * @property {string[]} removedChangeIds
 * @property {Array<{ from: string, to: string }>} remappedChangeIds
 * @property {SelectionHint} [selection]
 * @property {GraphDiagnostic[]} [diagnostics]
 * @property {import('prosemirror-model').Mark} [insertedMark]
 * @property {import('prosemirror-model').Mark[]} [deletionMarks]
 * @property {import('prosemirror-model').Mark[]} [formatMarks]
 * @property {number} [insertedFrom]
 * @property {number} [insertedTo]
 */

/**
 * @typedef {Object} TrackedEditFailure
 * @property {false} ok
 * @property {'CAPABILITY_UNAVAILABLE'|'INVALID_TARGET'|'PRECONDITION_FAILED'} code
 * @property {string} message
 * @property {unknown} [details]
 */

/**
 * @typedef {TrackedEditSuccess | TrackedEditFailure} TrackedEditResult
 */

const SUPPORTED_KINDS = new Set(['text-insert', 'text-delete', 'text-replace', 'format-apply', 'format-remove']);

/**
 * Compile a tracked edit against an accumulated transaction.
 *
 * The compiler mutates `tr` in place. Callers MUST inspect `result.ok`
 * before dispatch; if `ok: false` the transaction has not been altered.
 *
 * @param {{
 *   state: import('prosemirror-state').EditorState,
 *   tr: import('prosemirror-state').Transaction,
 *   intent: TrackedEditIntent,
 *   replacements?: 'paired'|'independent',
 * }} input
 * @returns {TrackedEditResult}
 */
export const compileTrackedEdit = ({ state, tr, intent, replacements = 'paired' }) => {
  if (!intent || !SUPPORTED_KINDS.has(intent.kind)) {
    return failure('CAPABILITY_UNAVAILABLE', `Unsupported tracked edit kind ${intent?.kind ?? 'unknown'}.`);
  }

  const ctx = makeContext({ state, tr, intent, replacements });

  // Pre-validate the graph state before allowing the compiler to write.
  // graphHasErrors aborts the compile if the document is already in a state
  // that would corrupt downstream decisions.
  if (graphHasErrors(ctx.graph)) {
    return failure('PRECONDITION_FAILED', 'Tracked review graph has invariant errors before edit.', {
      diagnostics: ctx.graph.validate(),
    });
  }

  try {
    switch (intent.kind) {
      case 'text-insert':
        return compileTextInsert(ctx, intent);
      case 'text-delete':
        return compileTextDelete(ctx, intent);
      case 'text-replace':
        return compileTextReplace(ctx, intent);
      case 'format-apply':
      case 'format-remove':
        return compileFormat(ctx, intent);
      default:
        return failure('CAPABILITY_UNAVAILABLE', 'Unsupported tracked edit kind.');
    }
  } catch (error) {
    return failure('PRECONDITION_FAILED', /** @type {Error} */ (error).message ?? 'compile failed.', { error });
  }
};

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const makeContext = ({ state, tr, intent, replacements }) => {
  const schema = state.schema;
  const graph = buildReviewGraph({ state: { doc: tr.doc }, replacementsMode: replacements });
  const currentIdentity = getCurrentUserIdentity({ options: { user: intent.user } });
  return {
    state,
    tr,
    schema,
    graph,
    intent,
    replacements,
    currentIdentity,
    /** @type {string[]} */ createdChangeIds: [],
    /** @type {string[]} */ updatedChangeIds: [],
    /** @type {string[]} */ removedChangeIds: [],
    /** @type {Array<{from:string,to:string}>} */ remappedChangeIds: [],
    /** @type {GraphDiagnostic[]} */ diagnostics: [],
  };
};

/**
 * @param {'CAPABILITY_UNAVAILABLE'|'INVALID_TARGET'|'PRECONDITION_FAILED'} code
 * @param {string} message
 * @param {unknown} [details]
 * @returns {TrackedEditFailure}
 */
const failure = (code, message, details) => ({
  ok: false,
  code,
  message,
  ...(details !== undefined ? { details } : {}),
});

// ---------------------------------------------------------------------------
// Helpers — segments, ownership, marks
// ---------------------------------------------------------------------------

/**
 * Classify whether the segment is same-user-owned by the intent's user.
 *
 * @param {*} ctx
 * @param {*} segment
 * @returns {'same-user'|'different-user'}
 */
const classifySegment = (ctx, segment) => {
  const classification = classifyOwnership({
    currentUser: ctx.currentIdentity,
    change: getChangeAuthorIdentity(segment?.attrs ?? {}),
  });
  return isSameUserHighConfidence(classification) ? 'same-user' : 'different-user';
};

const findSegmentAt = (ctx, pos) => {
  // Prefer the segment that covers `pos` strictly (pos in [from, to)). When
  // `pos` sits exactly at the right edge of a segment, also consider it as a
  // boundary for "still inside the same logical change" so we can refine.
  const hits = ctx.graph.overlapAt(pos);
  if (hits.length) return hits[0];
  // Boundary fallback: a segment that ends exactly at `pos` is still
  // adjacent. We do not extend into a segment that starts at `pos`,
  // because the cursor is on the live side.
  const left = ctx.graph.segments.find((s) => s.to === pos);
  if (left) return left;
  return null;
};

const segmentsInRange = (ctx, from, to) => ctx.graph.segmentsInRange(from, to);

const insertSchema = (ctx) => ctx.schema.marks[TrackInsertMarkName];
const deleteSchema = (ctx) => ctx.schema.marks[TrackDeleteMarkName];

const makeInsertMark = (ctx, { id, overlapParentId = '', replacementGroupId = '', replacementSideId = '' }) => {
  const attrs = {
    id,
    author: ctx.intent.user.name || '',
    authorEmail: ctx.intent.user.email || '',
    authorImage: ctx.intent.user.image || '',
    date: ctx.intent.date,
    sourceId: '',
    importedAuthor: '',
    revisionGroupId: id,
    splitFromId: '',
    // When part of a paired replacement, both halves persist the canonical
    // `replacement` changeType so the graph projects one logical change.
    changeType: replacementGroupId ? CanonicalChangeType.Replacement : CanonicalChangeType.Insertion,
    replacementGroupId,
    replacementSideId,
    overlapParentId,
    sourceIds: null,
    origin: '',
  };
  return insertSchema(ctx).create(attrs);
};

const makeDeleteMark = (ctx, { id, overlapParentId = '', replacementGroupId = '', replacementSideId = '' }) => {
  const attrs = {
    id,
    author: ctx.intent.user.name || '',
    authorEmail: ctx.intent.user.email || '',
    authorImage: ctx.intent.user.image || '',
    date: ctx.intent.date,
    sourceId: '',
    importedAuthor: '',
    revisionGroupId: id,
    splitFromId: '',
    changeType: replacementGroupId ? CanonicalChangeType.Replacement : CanonicalChangeType.Deletion,
    replacementGroupId,
    replacementSideId,
    overlapParentId,
    sourceIds: null,
    origin: '',
  };
  return deleteSchema(ctx).create(attrs);
};

/**
 * Strip every tracked insert/delete mark from a slice's text nodes. The
 * compiler always re-marks inserted content under its own logical id, so
 * leftover marks from the caller would shadow that decision.
 *
 * @param {import('prosemirror-model').Slice} slice
 * @param {*} schema
 */
const stripTrackedMarksFromSlice = (slice, schema) => {
  if (!slice || slice === Slice.empty) return slice;
  const trackedMarkNames = new Set([TrackInsertMarkName, TrackDeleteMarkName, TrackFormatMarkName]);
  const stripFragment = (fragment) => {
    /** @type {Array<import('prosemirror-model').Node>} */
    const children = [];
    for (let i = 0; i < fragment.childCount; i += 1) {
      const child = fragment.child(i);
      if (child.isText) {
        const filtered = child.marks.filter((mark) => !trackedMarkNames.has(mark.type.name));
        children.push(filtered.length === child.marks.length ? child : child.mark(filtered));
      } else if (child.content?.childCount) {
        children.push(child.copy(stripFragment(child.content)));
      } else {
        children.push(child);
      }
    }
    return Fragment.from(children);
  };
  return new Slice(stripFragment(slice.content), slice.openStart, slice.openEnd);
};

// ---------------------------------------------------------------------------
// text-insert
// ---------------------------------------------------------------------------

/**
 * @param {*} ctx
 * @param {TrackedEditIntent & { kind: 'text-insert' }} intent
 * @returns {TrackedEditResult}
 */
const compileTextInsert = (ctx, intent) => {
  const { at, content } = intent;
  const docSize = ctx.tr.doc.content.size;
  if (at < 0 || at > docSize) {
    return failure('INVALID_TARGET', `text-insert position ${at} out of range [0, ${docSize}].`);
  }

  const sanitizedSlice = stripTrackedMarksFromSlice(content ?? Slice.empty, ctx.schema);
  if (!sanitizedSlice.content.size) {
    return failure('INVALID_TARGET', 'text-insert requires non-empty content.');
  }

  // Resolve overlap context at the insertion point.
  const containing = findContainingSegment(ctx, at);
  const overlapParent = containing && containing.from < at && containing.to > at ? containing : null;
  const boundaryAdjacent =
    !overlapParent && containing && (containing.to === at || containing.from === at) ? containing : null;

  // Same-user refinement targets: own insertion that strictly contains `at`,
  // OR an own-insertion edge we are adjacent to. Adjacent same-user own
  // insertion still refines the same id (extend the run).
  const refinementTarget =
    overlapParent && overlapParent.side === SegmentSide.Inserted && classifySegment(ctx, overlapParent) === 'same-user'
      ? overlapParent
      : boundaryAdjacent &&
          boundaryAdjacent.side === SegmentSide.Inserted &&
          classifySegment(ctx, boundaryAdjacent) === 'same-user'
        ? boundaryAdjacent
        : null;

  if (refinementTarget) {
    const refinedId = refinementTarget.changeId;
    const insertedMark = makeInsertMark(ctx, {
      id: refinedId,
      overlapParentId: refinementTarget.attrs.overlapParentId || '',
      replacementGroupId: refinementTarget.attrs.replacementGroupId || '',
      replacementSideId: refinementTarget.attrs.replacementSideId || '',
    });
    return applyInsert(ctx, at, sanitizedSlice, insertedMark, refinedId, { update: true });
  }

  // Different-user content (or any non-insertion parent): exact location,
  // create a child insertion. For different-user inserted parent the rule is
  // the same — refine semantically with a new id and `overlapParentId`.
  if (overlapParent) {
    const childId = intent.replacementGroupHint || uuidv4();
    const overlapParentId = overlapParent.changeId;
    const insertedMark = makeInsertMark(ctx, { id: childId, overlapParentId });
    return applyInsert(ctx, at, sanitizedSlice, insertedMark, childId, { create: true });
  }

  // No overlap — fresh insertion at the cursor.
  const newId = intent.replacementGroupHint || uuidv4();
  const insertedMark = makeInsertMark(ctx, { id: newId });
  return applyInsert(ctx, at, sanitizedSlice, insertedMark, newId, { create: true });
};

/**
 * @param {*} ctx
 * @param {number} at
 * @param {import('prosemirror-model').Slice} slice
 * @param {import('prosemirror-model').Mark} insertMark
 * @param {string} changeId
 * @param {{ update?: boolean, create?: boolean }} flags
 * @returns {TrackedEditResult}
 */
const applyInsert = (ctx, at, slice, insertMark, changeId, { update, create }) => {
  const beforeSize = ctx.tr.doc.content.size;
  try {
    ctx.tr.replaceRange(at, at, slice);
  } catch (error) {
    return failure('INVALID_TARGET', /** @type {Error} */ (error).message ?? 'replaceRange failed.');
  }
  const afterSize = ctx.tr.doc.content.size;
  if (afterSize === beforeSize) {
    return failure('INVALID_TARGET', 'text-insert did not change the document.');
  }

  const insertedFrom = at;
  const insertedTo = at + (afterSize - beforeSize);

  // Re-apply tracked-insert mark over the inserted range. The slice
  // contained no tracked marks (we stripped them), so this is the canonical
  // marking.
  ctx.tr.addMark(insertedFrom, insertedTo, insertMark);

  if (create) ctx.createdChangeIds.push(changeId);
  else if (update) ctx.updatedChangeIds.push(changeId);

  return {
    ok: true,
    tr: ctx.tr,
    createdChangeIds: ctx.createdChangeIds,
    updatedChangeIds: ctx.updatedChangeIds,
    removedChangeIds: ctx.removedChangeIds,
    remappedChangeIds: ctx.remappedChangeIds,
    selection: { kind: 'near', pos: insertedTo, bias: 1 },
    insertedMark: insertMark,
    insertedFrom,
    insertedTo,
  };
};

// ---------------------------------------------------------------------------
// text-delete
// ---------------------------------------------------------------------------

/**
 * Delete one inline byte range, decomposed by graph segments.
 *
 * Behavior per segment:
 *   - own-insertion (covered/partial) → collapse: remove the inserted slice
 *   - other-insertion → child trackDelete with overlapParentId
 *   - own-deletion → no-op (preserve)
 *   - other-deletion → preserve parent; child trackDelete with overlapParentId
 *   - live content → trackDelete mark
 *
 * @param {*} ctx
 * @param {import('./edit-intent.js').TrackedEditIntent & { kind: 'text-delete' }} intent
 * @returns {TrackedEditResult}
 */
const compileTextDelete = (ctx, intent) => {
  const docSize = ctx.tr.doc.content.size;
  if (intent.from < 0 || intent.to > docSize) {
    return failure('INVALID_TARGET', `text-delete range [${intent.from}, ${intent.to}] out of bounds.`);
  }
  if (intent.from === intent.to) {
    return failure('INVALID_TARGET', 'text-delete requires a non-empty range.');
  }

  const result = applyTrackedDelete(ctx, intent.from, intent.to, {
    replacementGroupId: '',
    replacementSideId: '',
    sharedDeletionId: intent.replacementGroupHint || null,
    recordSharedDeletionId: Boolean(intent.replacementGroupHint),
  });
  if (result.ok === false) return result;

  // Caret at original `from`: matches Word's behavior where the cursor sits
  // at the left edge of a tracked deletion.
  return {
    ok: true,
    tr: ctx.tr,
    createdChangeIds: ctx.createdChangeIds,
    updatedChangeIds: ctx.updatedChangeIds,
    removedChangeIds: ctx.removedChangeIds,
    remappedChangeIds: ctx.remappedChangeIds,
    selection: { kind: 'near', pos: intent.from, bias: -1 },
    deletionMarks: result.deletionMarks,
  };
};

/**
 * Apply tracked deletion semantics across [from, to], returning the marks
 * we wrote so callers (text-replace) can reuse the id.
 *
 * @param {*} ctx
 * @param {number} from
 * @param {number} to
 * @param {{ replacementGroupId: string, replacementSideId: string, sharedDeletionId: string | null, recordSharedDeletionId?: boolean, recordCollapsedIds?: boolean }} options
 * @returns {{ ok: true, deletionMarks: import('prosemirror-model').Mark[], deletionId: string } | TrackedEditFailure}
 */
const applyTrackedDelete = (
  ctx,
  from,
  to,
  {
    replacementGroupId,
    replacementSideId,
    sharedDeletionId,
    recordSharedDeletionId = false,
    recordCollapsedIds = true,
  },
) => {
  /** @type {Array<import('prosemirror-model').Mark>} */
  const deletionMarks = [];
  // Walk inline leaf nodes and act per node. We never mutate while iterating
  // — collect operations first, then apply in reverse position order so
  // earlier positions remain stable.
  /** @type {Array<{ kind: 'collapse'|'reassign'|'mark-delete'|'noop', from: number, to: number, changeId?: string, parentId?: string, parentSide?: string, parentReplacementGroupId?: string }>} */
  const ops = [];

  ctx.tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isInline || !node.isLeaf) return;
    if (node.type.name.includes('table')) return;
    const segFrom = Math.max(from, pos);
    const segTo = Math.min(to, pos + node.nodeSize);
    if (segFrom >= segTo) return;

    const insertMark = node.marks.find((m) => m.type.name === TrackInsertMarkName);
    const existingDelete = node.marks.find((m) => m.type.name === TrackDeleteMarkName);

    if (insertMark) {
      const segmentAtPos = ctx.graph.overlapAt(pos)[0] ?? null;
      const ownership = classifySegment(ctx, segmentAtPos ?? { attrs: insertMark.attrs });
      if (ownership === 'same-user') {
        // Own insertion → collapse (remove proposed content).
        ops.push({ kind: 'collapse', from: segFrom, to: segTo, changeId: insertMark.attrs.id });
        return;
      }
      // Different-user inserted content → child trackDelete with overlapParentId.
      const parentId = insertMark.attrs.id;
      ops.push({ kind: 'mark-delete', from: segFrom, to: segTo, parentId, parentSide: SegmentSide.Inserted });
      return;
    }

    if (existingDelete) {
      const ownership = classifySegment(ctx, { attrs: existingDelete.attrs });
      if (ownership === 'same-user') {
        // Inside own deletion → no semantic change (preserve original).
        ops.push({ kind: 'noop', from: segFrom, to: segTo });
        return;
      }
      // Inside different-user deletion → child trackDelete with overlapParentId.
      ops.push({
        kind: 'mark-delete',
        from: segFrom,
        to: segTo,
        parentId: existingDelete.attrs.id,
        parentSide: SegmentSide.Deleted,
      });
      return;
    }

    // Live content.
    ops.push({ kind: 'mark-delete', from: segFrom, to: segTo });
  });

  if (!ops.length) {
    return failure('CAPABILITY_UNAVAILABLE', `text-delete range [${from}, ${to}] has no inline text content to track.`);
  }

  // Apply in reverse so earlier positions stay stable for `collapse` ops.
  const sortedOps = [...ops].sort((a, b) => b.from - a.from);
  // Allocate a deletion id. For paired replacement, the caller provides one.
  const deletionId = sharedDeletionId ?? uuidv4();
  let mintedThisCall = false;
  const collapsedIds = new Set();

  for (const op of sortedOps) {
    if (op.kind === 'collapse') {
      try {
        ctx.tr.replaceRange(op.from, op.to, Slice.empty);
      } catch {
        // Defensive — if PM refuses the deletion, fail closed.
        return failure('INVALID_TARGET', `Cannot collapse own-insertion range [${op.from}, ${op.to}].`);
      }
      if (op.changeId) collapsedIds.add(op.changeId);
      continue;
    }
    if (op.kind === 'noop') continue;
    if (op.kind === 'mark-delete') {
      const mark = makeDeleteMark(ctx, {
        id: deletionId,
        overlapParentId: op.parentId || '',
        replacementGroupId,
        replacementSideId,
      });
      try {
        ctx.tr.addMark(op.from, op.to, mark);
        deletionMarks.push(mark);
        if (!mintedThisCall) {
          if (!sharedDeletionId || recordSharedDeletionId) ctx.createdChangeIds.push(deletionId);
          mintedThisCall = true;
        }
      } catch (error) {
        return failure('INVALID_TARGET', /** @type {Error} */ (error).message ?? 'addMark failed.');
      }
    }
  }

  if (recordCollapsedIds && collapsedIds.size) {
    const finalGraph = buildReviewGraph({
      state: { doc: ctx.tr.doc },
      replacementsMode: ctx.replacements,
    });
    for (const id of collapsedIds) {
      if (finalGraph.changes.has(id)) ctx.updatedChangeIds.push(id);
      else ctx.removedChangeIds.push(id);
    }
  }

  return { ok: true, deletionMarks, deletionId };
};

// ---------------------------------------------------------------------------
// text-replace
// ---------------------------------------------------------------------------

/**
 * @param {*} ctx
 * @param {TrackedEditIntent & { kind: 'text-replace' }} intent
 * @returns {TrackedEditResult}
 */
const compileTextReplace = (ctx, intent) => {
  const docSize = ctx.tr.doc.content.size;
  if (intent.from < 0 || intent.to > docSize) {
    return failure('INVALID_TARGET', `text-replace range [${intent.from}, ${intent.to}] out of bounds.`);
  }
  if (intent.from > intent.to) {
    return failure('INVALID_TARGET', 'text-replace `from` must be <= `to`.');
  }

  const sanitizedSlice = stripTrackedMarksFromSlice(intent.content ?? Slice.empty, ctx.schema);
  if (!sanitizedSlice.content.size && intent.from === intent.to) {
    return failure('INVALID_TARGET', 'text-replace requires a non-empty replacement or non-empty range.');
  }

  const segments = segmentsInRange(ctx, intent.from, intent.to);

  // Replacing text inside own insertion/replacement-inserted side refines
  // that inserted side. Rejecting the original insertion must still remove
  // all proposed content, including the replacement text.
  const ownInsertedTarget = getSingleFullyCoveringOwnInsertedSegment(ctx, segments, intent.from, intent.to);
  if (ownInsertedTarget) {
    const deleteResult = applyTrackedDelete(ctx, intent.from, intent.to, {
      replacementGroupId: '',
      replacementSideId: '',
      sharedDeletionId: null,
      recordCollapsedIds: false,
    });
    if (deleteResult.ok === false) return deleteResult;

    if (!sanitizedSlice.content.size) {
      ctx.updatedChangeIds.push(ownInsertedTarget.changeId);
      return {
        ok: true,
        tr: ctx.tr,
        createdChangeIds: ctx.createdChangeIds,
        updatedChangeIds: ctx.updatedChangeIds,
        removedChangeIds: ctx.removedChangeIds,
        remappedChangeIds: ctx.remappedChangeIds,
        selection: { kind: 'near', pos: intent.from, bias: -1 },
      };
    }

    const insertMark = makeInsertMark(ctx, {
      id: ownInsertedTarget.changeId,
      overlapParentId: ownInsertedTarget.attrs.overlapParentId || '',
      replacementGroupId: ownInsertedTarget.attrs.replacementGroupId || '',
      replacementSideId: ownInsertedTarget.attrs.replacementSideId || '',
    });
    return applyInsert(
      ctx,
      clampToDocSize(ctx.tr.doc.content.size, intent.from),
      sanitizedSlice,
      insertMark,
      ownInsertedTarget.changeId,
      {
        update: true,
      },
    );
  }

  // SD-2335: replacing text inside own deletion preserves the deletion and
  // creates an insertion at the exact edit point. We detect this case by
  // looking at the segments in the original range before any mutation.
  const ownDeletionFullyCovers =
    segments.length > 0 &&
    segments.every(
      (s) =>
        s.side === SegmentSide.Deleted &&
        classifySegment(ctx, s) === 'same-user' &&
        s.from <= intent.from &&
        s.to >= intent.to,
    );

  if (ownDeletionFullyCovers && sanitizedSlice.content.size) {
    // Insertion at exact `from` — preserve original deletion as-is.
    const insertId = uuidv4();
    const insertMark = makeInsertMark(ctx, { id: insertId });
    return applyInsert(ctx, intent.from, sanitizedSlice, insertMark, insertId, { create: true });
  }

  // Paired vs independent: in paired mode share one id between insert+delete
  // sides so the logical change projects as a `replacement` in the graph.
  const sharedId = intent.replacements === 'paired' ? intent.replacementGroupHint || uuidv4() : null;
  const replacementGroupId = sharedId ?? '';
  const replacementSideId = sharedId ? `${sharedId}#deleted` : '';
  const replacementParentId = getReplacementParentId(ctx, segments);

  // Step 1 — tracked delete (collapses own insertions, marks live/other content).
  if (intent.from !== intent.to) {
    const delResult = applyTrackedDelete(ctx, intent.from, intent.to, {
      replacementGroupId,
      replacementSideId,
      sharedDeletionId: sharedId,
    });
    if (delResult.ok === false) return delResult;
    if (sharedId && delResult.deletionMarks?.length) {
      ctx.createdChangeIds.push(sharedId);
    }
  }

  // Step 2 — tracked insert at the original `from`. Recompute graph context
  // after the deletion so own-insertion collapse adjustments don't push the
  // insertion past the intended cursor.
  if (sanitizedSlice.content.size) {
    // We must re-resolve the insertion position because collapsed
    // own-insertion content shrinks the doc.
    const insertId = sharedId ?? intent.replacementGroupHint ?? uuidv4();
    const insertMark = makeInsertMark(ctx, {
      id: insertId,
      overlapParentId: replacementParentId,
      replacementGroupId,
      replacementSideId: sharedId ? `${sharedId}#inserted` : '',
    });
    const insertPos = clampToDocSize(ctx.tr.doc.content.size, intent.from);
    const insertResult = applyInsert(ctx, insertPos, sanitizedSlice, insertMark, insertId, {
      create: sharedId ? false : true,
      update: sharedId ? true : false,
    });
    if (!insertResult.ok) return insertResult;
    return {
      ...insertResult,
      selection: { kind: 'near', pos: insertResult.insertedTo, bias: 1 },
    };
  }

  return {
    ok: true,
    tr: ctx.tr,
    createdChangeIds: ctx.createdChangeIds,
    updatedChangeIds: ctx.updatedChangeIds,
    removedChangeIds: ctx.removedChangeIds,
    remappedChangeIds: ctx.remappedChangeIds,
    selection: { kind: 'near', pos: intent.from, bias: -1 },
  };
};

const clampToDocSize = (size, pos) => Math.max(0, Math.min(size, pos));

const getSingleFullyCoveringOwnInsertedSegment = (ctx, segments, from, to) => {
  if (!segments.length) return null;
  const inserted = segments.filter(
    (s) => s.side === SegmentSide.Inserted && classifySegment(ctx, s) === 'same-user' && s.from <= from && s.to >= to,
  );
  if (inserted.length !== segments.length) return null;
  const [first] = inserted;
  if (!first) return null;
  return inserted.every((s) => s.changeId === first.changeId) ? first : null;
};

const getReplacementParentId = (ctx, segments) => {
  for (const segment of segments) {
    if (classifySegment(ctx, segment) !== 'different-user') continue;
    if (segment.attrs?.overlapParentId) return segment.attrs.overlapParentId;
    return segment.changeId || '';
  }
  return '';
};

// ---------------------------------------------------------------------------
// format-apply / format-remove (SD-486 folding)
// ---------------------------------------------------------------------------

/**
 * @param {*} ctx
 * @param {TrackedEditIntent & { kind: 'format-apply'|'format-remove' }} intent
 * @returns {TrackedEditResult}
 */
const compileFormat = (ctx, intent) => {
  if (!TrackedFormatMarkNames.includes(intent.mark.type.name)) {
    return failure('CAPABILITY_UNAVAILABLE', `Mark ${intent.mark.type.name} is not a tracked formatting mark.`);
  }

  // Walk segments in range. For each contiguous subrange:
  //   - if covered by same-user own insertion (or replacement inserted side),
  //     directly apply/remove the mark (SD-486 fold).
  //   - if covered by other-user inserted content, defer to trackFormat
  //     creation. To minimize compiler/legacy duplication we leave this to
  //     the existing addMarkStep/removeMarkStep helper by returning a hint;
  //     however since the compiler must drive consistent semantics, we
  //     directly create the formatting change here over the entire other-
  //     content range using the same canonical attrs.
  //   - if mixed structural ranges (paragraph boundaries we can't safely
  //     model under the tracked text scope), fail closed.
  const subranges = computeFormatSubranges(ctx, intent.from, intent.to);
  if (!subranges) return failure('CAPABILITY_UNAVAILABLE', 'format range crosses unsupported structural boundary.');

  const trackFormatType = ctx.schema.marks[TrackFormatMarkName];
  if (!trackFormatType) return failure('CAPABILITY_UNAVAILABLE', 'schema is missing trackFormat mark.');

  /** @type {Array<import('prosemirror-model').Mark>} */
  const formatMarks = [];

  for (const range of subranges) {
    if (intent.kind === 'format-apply') {
      if (range.fold) {
        ctx.tr.addMark(range.from, range.to, intent.mark);
      } else {
        ctx.tr.addMark(range.from, range.to, intent.mark);
        const formatMark = trackFormatType.create({
          id: uuidv4(),
          author: ctx.intent.user.name || '',
          authorEmail: ctx.intent.user.email || '',
          authorImage: ctx.intent.user.image || '',
          date: ctx.intent.date,
          before: [],
          after: [{ type: intent.mark.type.name, attrs: intent.mark.attrs }],
          sourceId: '',
          importedAuthor: '',
          revisionGroupId: '',
          splitFromId: '',
          changeType: CanonicalChangeType.Formatting,
          replacementGroupId: '',
          replacementSideId: '',
          overlapParentId: range.parentId || '',
          sourceIds: null,
          origin: '',
        });
        ctx.tr.addMark(range.from, range.to, formatMark);
        formatMarks.push(formatMark);
        ctx.createdChangeIds.push(formatMark.attrs.id);
      }
    } else {
      if (range.fold) {
        ctx.tr.removeMark(range.from, range.to, intent.mark);
      } else {
        ctx.tr.removeMark(range.from, range.to, intent.mark);
        const formatMark = trackFormatType.create({
          id: uuidv4(),
          author: ctx.intent.user.name || '',
          authorEmail: ctx.intent.user.email || '',
          authorImage: ctx.intent.user.image || '',
          date: ctx.intent.date,
          before: [{ type: intent.mark.type.name, attrs: intent.mark.attrs }],
          after: [],
          sourceId: '',
          importedAuthor: '',
          revisionGroupId: '',
          splitFromId: '',
          changeType: CanonicalChangeType.Formatting,
          replacementGroupId: '',
          replacementSideId: '',
          overlapParentId: range.parentId || '',
          sourceIds: null,
          origin: '',
        });
        ctx.tr.addMark(range.from, range.to, formatMark);
        formatMarks.push(formatMark);
        ctx.createdChangeIds.push(formatMark.attrs.id);
      }
    }
  }

  return {
    ok: true,
    tr: ctx.tr,
    createdChangeIds: ctx.createdChangeIds,
    updatedChangeIds: ctx.updatedChangeIds,
    removedChangeIds: ctx.removedChangeIds,
    remappedChangeIds: ctx.remappedChangeIds,
    formatMarks,
  };
};

/**
 * Build the list of contiguous subranges inside [from, to] that share the
 * same "format folding" decision. Returns null when the range crosses a
 * boundary the compiler refuses to handle (e.g. a non-textblock structural
 * node).
 *
 * @returns {Array<{ from: number, to: number, fold: boolean, parentId?: string }> | null}
 */
const computeFormatSubranges = (ctx, from, to) => {
  /** @type {Array<{ from: number, to: number, fold: boolean, parentId?: string }>} */
  const out = [];
  let boundaryCrossed = false;
  let lastTextBlock = null;

  ctx.tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isInline || node.type.name === 'run') return;
    if (boundaryCrossed) return false;
    // Identify the textblock parent of this inline leaf.
    const $pos = ctx.tr.doc.resolve(pos);
    const parent = $pos.parent?.type?.name ?? '';
    if (!parent) return;
    if (lastTextBlock === null) lastTextBlock = parent;
    // We do not consider crossing textblocks unsafe here; PM clips ranges
    // to inline content. The compiler refuses only structural marks (handled
    // by the SUPPORTED_KINDS check above).

    const segFrom = Math.max(from, pos);
    const segTo = Math.min(to, pos + node.nodeSize);
    if (segFrom >= segTo) return;

    const insertMark = node.marks.find((m) => m.type.name === TrackInsertMarkName);
    if (insertMark) {
      const ownership = classifySegment(ctx, { attrs: insertMark.attrs });
      if (ownership === 'same-user') {
        appendSubrange(out, { from: segFrom, to: segTo, fold: true });
      } else {
        appendSubrange(out, { from: segFrom, to: segTo, fold: false, parentId: insertMark.attrs.id });
      }
      return;
    }
    const deleteMark = node.marks.find((m) => m.type.name === TrackDeleteMarkName);
    if (deleteMark) {
      // Tracked-deleted content: do not modify formatting; legacy addMarkStep
      // also skips this. Fail closed to avoid silent drift.
      boundaryCrossed = true;
      return false;
    }
    appendSubrange(out, { from: segFrom, to: segTo, fold: false });
  });

  if (boundaryCrossed) return null;
  return out;
};

const appendSubrange = (out, range) => {
  const last = out[out.length - 1];
  if (last && last.fold === range.fold && last.parentId === range.parentId && last.to === range.from) {
    last.to = range.to;
    return;
  }
  out.push(range);
};

/**
 * Find the segment that strictly contains `pos` if any. When no segment
 * strictly contains the position, returns the segment whose right edge is at
 * `pos` (for adjacent same-user refinement detection).
 */
const findContainingSegment = (ctx, pos) => findSegmentAt(ctx, pos);

// ---------------------------------------------------------------------------
// Diagnostics surfaced for telemetry/tests.
// ---------------------------------------------------------------------------

export const compilerInternalsForTest = { stripTrackedMarksFromSlice, classifySegment, computeFormatSubranges };
