/**
 * Track-changes convenience wrappers — bridge track-change operations to
 * the plan engine's revision management and execution path.
 *
 * Discovery (list / get) is a thin passthrough over the host-level
 * {@link getTrackedChangeIndex} service, so there is a single owner for
 * tracked-change enumeration across every revision-capable story.
 *
 * Mutating operations (accept, reject, acceptAll, rejectAll) route through
 * the story runtime resolver so that non-body tracked changes execute in
 * the owning story editor and commit back through `mutatePart(...)`.
 */

import type { Editor } from '../../core/Editor.js';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type {
  Receipt,
  RevisionGuardOptions,
  TextTarget,
  TrackChangeInfo,
  TrackChangeWordRevisionIds,
  TrackChangesAcceptAllInput,
  TrackChangesAcceptInput,
  TrackChangesGetInput,
  TrackChangesListInput,
  TrackChangesRejectAllInput,
  TrackChangesRejectInput,
  TrackChangeType,
  TrackChangesListResult,
  StoryLocator,
} from '@superdoc/document-api';
import { buildResolvedHandle, buildDiscoveryItem, buildDiscoveryResult } from '@superdoc/document-api';
import { DocumentApiAdapterError } from '../errors.js';
import { executeDomainCommand } from './plan-wrappers.js';
import { paginate, validatePaginationInput } from '../helpers/adapter-utils.js';
import { resolveTextRangeInBlock } from '../helpers/text-offset-resolver.js';
import { checkRevision, getRevision } from './revision-tracker.js';
import { resolveTrackedChangeInStory, resolveTrackedChangeType } from '../helpers/tracked-change-resolver.js';
import { getTrackedChangeIndex } from '../tracked-changes/tracked-change-index.js';
import type { TrackedChangeSnapshot } from '../tracked-changes/tracked-change-snapshot.js';
import { resolveStoryRuntime } from '../story-runtime/resolve-story-runtime.js';
import { BODY_STORY_KEY, buildStoryKey } from '../story-runtime/story-key.js';
import { makeTrackedChangeAnchorKey } from '../helpers/tracked-change-runtime-ref.js';
import { normalizeExcerpt, toNonEmptyString } from '../helpers/value-utils.js';

function normalizeWordRevisionIds(
  wordRevisionIds: TrackChangeWordRevisionIds | undefined,
): TrackChangeWordRevisionIds | undefined {
  if (!wordRevisionIds) return undefined;

  const normalized: TrackChangeWordRevisionIds = {};
  if (wordRevisionIds.insert) normalized.insert = wordRevisionIds.insert;
  if (wordRevisionIds.delete) normalized.delete = wordRevisionIds.delete;
  if (wordRevisionIds.format) normalized.format = wordRevisionIds.format;

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function snapshotToInfo(snapshot: TrackedChangeSnapshot): TrackChangeInfo {
  const changedText = snapshot.excerpt
    ? { [snapshot.type === 'delete' ? 'deletedText' : 'insertedText']: snapshot.excerpt }
    : {};
  return {
    address: snapshot.address,
    id: snapshot.address.entityId,
    type: snapshot.type,
    wordRevisionIds: normalizeWordRevisionIds(snapshot.wordRevisionIds),
    overlap: snapshot.overlap,
    author: snapshot.author,
    authorEmail: snapshot.authorEmail,
    authorImage: snapshot.authorImage,
    date: snapshot.date,
    excerpt: snapshot.excerpt,
    ...(snapshot.type === 'format' ? {} : changedText),
  };
}

function filterByType(
  snapshots: ReadonlyArray<TrackedChangeSnapshot>,
  requestedType?: TrackChangeType,
): TrackedChangeSnapshot[] {
  if (!requestedType) return [...snapshots];
  return snapshots.filter((snapshot) => snapshot.type === requestedType);
}

function toNoOpReceipt(message: string, details?: unknown): Receipt {
  return {
    success: false,
    failure: {
      code: 'NO_OP',
      message,
      details,
    },
  };
}

function decisionFailureReceipt(editor: Editor, fallbackMessage: string, fallbackDetails?: unknown): Receipt {
  const storage = (
    editor as {
      storage?: {
        trackChanges?: {
          lastDecisionFailure?: { code?: string; message?: string; details?: unknown } | null;
        };
      };
    }
  ).storage;
  const failureInfo = storage?.trackChanges?.lastDecisionFailure ?? null;
  if (!failureInfo?.code) {
    return toNoOpReceipt(fallbackMessage, fallbackDetails);
  }
  return {
    success: false,
    failure: {
      code: failureInfo.code as Extract<Receipt, { success: false }>['failure']['code'],
      message: failureInfo.message ?? fallbackMessage,
      details: failureInfo.details ?? fallbackDetails,
    },
  };
}

function resolveListScope(input: TrackChangesListInput | undefined): 'body' | 'all' | { story: StoryLocator } {
  if (!input || input.in === undefined) return 'body';
  if (input.in === 'all') return 'all';
  return { story: input.in };
}

export function trackChangesListWrapper(editor: Editor, input?: TrackChangesListInput): TrackChangesListResult {
  validatePaginationInput(input?.offset, input?.limit);

  const index = getTrackedChangeIndex(editor);
  const scope = resolveListScope(input);

  let rawSnapshots: ReadonlyArray<TrackedChangeSnapshot>;
  if (scope === 'all') {
    rawSnapshots = index.getAll();
  } else if (scope === 'body') {
    rawSnapshots = index.get({ kind: 'story', storyType: 'body' });
  } else {
    rawSnapshots = index.get(scope.story);
  }

  const filtered = filterByType(rawSnapshots, input?.type);
  const paged = paginate(filtered, input?.offset, input?.limit);
  // Track-changes discovery uses a document-level revision token across every
  // scope. Part commits also advance the host revision, so one shared token
  // correctly guards body, story-scoped, and aggregate review flows.
  const evaluatedRevision = getRevision(editor);

  const items = paged.items.map((snapshot) => {
    const info = snapshotToInfo(snapshot);
    const handle = buildResolvedHandle(snapshot.anchorKey, 'stable', 'trackedChange');
    const {
      address,
      type,
      wordRevisionIds,
      overlap,
      author,
      authorEmail,
      authorImage,
      date,
      excerpt,
      insertedText,
      deletedText,
    } = info;
    return buildDiscoveryItem(info.id, handle, {
      address,
      type,
      wordRevisionIds,
      overlap,
      author,
      authorEmail,
      authorImage,
      date,
      excerpt,
      insertedText,
      deletedText,
    });
  });

  return buildDiscoveryResult({
    evaluatedRevision,
    total: paged.total,
    items,
    page: { limit: input?.limit ?? paged.total, offset: input?.offset ?? 0, returned: items.length },
  });
}

export function trackChangesGetWrapper(editor: Editor, input: TrackChangesGetInput): TrackChangeInfo {
  const { id, story } = input;
  const resolved = resolveTrackedChangeInStory(editor, {
    kind: 'entity',
    entityType: 'trackedChange',
    entityId: id,
    ...(story ? { story } : {}),
  });
  if (!resolved) {
    throw new DocumentApiAdapterError('TARGET_NOT_FOUND', `Tracked change "${id}" was not found.`, { id });
  }

  const index = getTrackedChangeIndex(editor);
  const storyKey = buildStoryKey(resolved.story);
  const anchorKey = makeTrackedChangeAnchorKey(resolved.runtimeRef);
  const snapshots =
    storyKey === BODY_STORY_KEY ? index.get({ kind: 'story', storyType: 'body' }) : index.get(resolved.story);
  const snapshot = snapshots.find((item) => item.anchorKey === anchorKey);

  if (snapshot) return snapshotToInfo(snapshot);

  const type = resolveTrackedChangeType(resolved.change);
  const excerpt =
    (resolved.change.excerpt !== undefined ? resolved.change.excerpt : undefined) ??
    normalizeExcerpt(resolved.editor.state.doc.textBetween(resolved.change.from, resolved.change.to, ' ', '\ufffc'));
  const changedText = excerpt ? { [type === 'delete' ? 'deletedText' : 'insertedText']: excerpt } : {};

  return {
    address: {
      kind: 'entity',
      entityType: 'trackedChange',
      entityId: resolved.change.id,
      ...(storyKey === BODY_STORY_KEY ? {} : { story: resolved.story }),
    },
    id: resolved.change.id,
    type,
    wordRevisionIds: normalizeWordRevisionIds(resolved.change.wordRevisionIds),
    overlap: resolved.change.overlap,
    author: toNonEmptyString(resolved.change.attrs.author),
    authorEmail: toNonEmptyString(resolved.change.attrs.authorEmail),
    authorImage: toNonEmptyString(resolved.change.attrs.authorImage),
    date: toNonEmptyString(resolved.change.attrs.date),
    excerpt,
    ...(type === 'format' ? {} : changedText),
  };
}

type ReviewDecision = 'accept' | 'reject';

function decideSingle(
  hostEditor: Editor,
  decision: ReviewDecision,
  id: string,
  story: StoryLocator | undefined,
  options: RevisionGuardOptions | undefined,
): Receipt {
  const resolved = resolveTrackedChangeInStory(hostEditor, {
    kind: 'entity',
    entityType: 'trackedChange',
    entityId: id,
    ...(story ? { story } : {}),
  });

  if (!resolved) {
    throw new DocumentApiAdapterError('TARGET_NOT_FOUND', `Tracked change "${id}" was not found.`, { id, story });
  }

  const commandName = decision === 'accept' ? 'acceptTrackedChangeById' : 'rejectTrackedChangeById';
  const command = (resolved.editor.commands as Record<string, ((rawId: string) => boolean) | undefined>)[commandName];
  if (typeof command !== 'function') {
    throw new DocumentApiAdapterError(
      'CAPABILITY_UNAVAILABLE',
      `${decision === 'accept' ? 'Accept' : 'Reject'} tracked change command is not available on the story editor.`,
      { reason: 'missing_command' },
    );
  }

  checkRevision(hostEditor, options?.expectedRevision);

  const commandRawId = resolved.change.commandRawId ?? resolved.change.rawId;
  const receipt = executeDomainCommand(resolved.editor, () => Boolean(command(commandRawId)));

  if (receipt.steps[0]?.effect !== 'changed') {
    return decisionFailureReceipt(
      resolved.editor,
      `${decision === 'accept' ? 'Accept' : 'Reject'} tracked change "${id}" produced no change.`,
      {
        id,
        story,
      },
    );
  }

  if (resolved.commit) {
    resolved.commit(hostEditor);
  }

  getTrackedChangeIndex(hostEditor).invalidate(resolved.story);

  return { success: true };
}

export function trackChangesAcceptWrapper(
  editor: Editor,
  input: TrackChangesAcceptInput,
  options?: RevisionGuardOptions,
): Receipt {
  return decideSingle(editor, 'accept', input.id, input.story, options);
}

export function trackChangesRejectWrapper(
  editor: Editor,
  input: TrackChangesRejectInput,
  options?: RevisionGuardOptions,
): Receipt {
  return decideSingle(editor, 'reject', input.id, input.story, options);
}

function decideAll(editor: Editor, decision: ReviewDecision, options: RevisionGuardOptions | undefined): Receipt {
  const index = getTrackedChangeIndex(editor);
  const allSnapshots = index.getAll();
  if (allSnapshots.length === 0) {
    return toNoOpReceipt(`${decision === 'accept' ? 'Accept' : 'Reject'} all tracked changes produced no change.`);
  }

  checkRevision(editor, options?.expectedRevision);

  const byStoryKey = new Map<string, { story: StoryLocator; snapshots: TrackedChangeSnapshot[] }>();
  for (const snapshot of allSnapshots) {
    const key = snapshot.runtimeRef.storyKey;
    const entry = byStoryKey.get(key);
    if (entry) {
      entry.snapshots.push(snapshot);
      continue;
    }
    byStoryKey.set(key, { story: snapshot.story, snapshots: [snapshot] });
  }

  let anyApplied = false;

  for (const { story, snapshots } of byStoryKey.values()) {
    const runtime = resolveStoryRuntime(editor, story);
    const commandName = decision === 'accept' ? 'acceptAllTrackedChanges' : 'rejectAllTrackedChanges';
    const bulkCommand = (runtime.editor.commands as Record<string, (() => boolean) | undefined>)[commandName];

    const receipt = executeDomainCommand(runtime.editor, (): boolean => {
      if (typeof bulkCommand === 'function') return Boolean(bulkCommand());

      const perChangeCommand = (runtime.editor.commands as Record<string, ((rawId: string) => boolean) | undefined>)[
        decision === 'accept' ? 'acceptTrackedChangeById' : 'rejectTrackedChangeById'
      ];
      if (typeof perChangeCommand !== 'function') return false;

      let applied = false;
      for (const snapshot of snapshots) {
        const resolved = resolveTrackedChangeInStory(editor, snapshot.address);
        const commandRawId = resolved?.change.commandRawId ?? snapshot.runtimeRef.rawId;
        if (perChangeCommand(commandRawId)) {
          applied = true;
        }
      }
      return applied;
    });

    const changed = receipt.steps[0]?.effect === 'changed';
    if (!changed) continue;

    anyApplied = true;
    if (runtime.commit) {
      runtime.commit(editor);
    }
    index.invalidate(story);
  }

  if (!anyApplied) {
    return decisionFailureReceipt(
      editor,
      `${decision === 'accept' ? 'Accept' : 'Reject'} all tracked changes produced no change.`,
    );
  }

  return { success: true };
}

export function trackChangesAcceptAllWrapper(
  editor: Editor,
  _input: TrackChangesAcceptAllInput,
  options?: RevisionGuardOptions,
): Receipt {
  return decideAll(editor, 'accept', options);
}

export function trackChangesRejectAllWrapper(
  editor: Editor,
  _input: TrackChangesRejectAllInput,
  options?: RevisionGuardOptions,
): Receipt {
  return decideAll(editor, 'reject', options);
}

// ---------------------------------------------------------------------------
// trackChanges.decide range targets
// ---------------------------------------------------------------------------

/**
 * Resolve a {@link TextTarget} into a single contiguous PM range within the
 * body story. Multi-segment ranges are deferred (CAPABILITY_UNAVAILABLE)
 * until fixtures land — partial decisions per phase0-004 only need a single
 * contiguous selection.
 */
function resolveRangeToPmCoords(editor: Editor, range: TextTarget): { from: number; to: number } | null {
  if (!range.segments?.length) return null;
  if (range.segments.length > 1) return null; // multi-segment ranges deferred.
  const seg = range.segments[0];
  const doc = editor.state.doc;
  const block = findBlockStart(doc, seg.blockId);
  if (!block) return null;
  return resolveTextRangeInBlock(block.node, block.pos, seg.range);
}

function findBlockStart(
  doc: {
    descendants: (fn: (node: ProseMirrorNode, pos: number) => boolean | void) => void;
  },
  blockId: string,
): { node: ProseMirrorNode; pos: number } | null {
  let found: { node: ProseMirrorNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    const attrs = node.attrs as Record<string, unknown>;
    if ((attrs?.blockId ?? attrs?.sdBlockId ?? attrs?.id) === blockId) {
      found = { node, pos };
      return false;
    }
    return true;
  });
  return found;
}

export function trackChangesDecideRangeWrapper(
  editor: Editor,
  input: { decision: 'accept' | 'reject'; range: TextTarget; story?: StoryLocator },
  options?: RevisionGuardOptions,
): Receipt {
  // Story routing — for now partial-range decisions are implemented
  // for the body story only. Non-body stories require structural plumbing
  // owned by phase0-005 and fail closed here.
  const story = input.story;
  if (story && (story.kind !== 'story' || story.storyType !== 'body')) {
    return {
      success: false,
      failure: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'trackChanges.decide range targets currently support the body story only.',
        details: { story: input.story },
      },
    };
  }
  const resolved = resolveRangeToPmCoords(editor, input.range);
  if (!resolved) {
    return {
      success: false,
      failure: {
        code: 'INVALID_TARGET',
        message: 'trackChanges.decide range could not be resolved to a contiguous PM coordinate.',
        details: { range: input.range },
      },
    };
  }
  checkRevision(editor, options?.expectedRevision);

  const commandName = input.decision === 'accept' ? 'acceptTrackedChangesBetween' : 'rejectTrackedChangesBetween';
  const command = (editor.commands as Record<string, ((from: number, to: number) => boolean) | undefined>)[commandName];
  if (typeof command !== 'function') {
    return {
      success: false,
      failure: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: `${commandName} command is not available on the editor.`,
      },
    };
  }
  const applied = Boolean(command(resolved.from, resolved.to));
  if (!applied) {
    return decisionFailureReceipt(editor, 'No tracked changes matched the requested decision target.', {
      range: input.range,
      story: input.story,
    });
  }
  getTrackedChangeIndex(editor).invalidate({ kind: 'story', storyType: 'body' });
  return { success: true };
}
