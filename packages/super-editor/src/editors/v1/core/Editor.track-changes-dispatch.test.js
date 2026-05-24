import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initTestEditor } from '@tests/helpers/helpers.js';
import { Editor } from '@core/Editor.js';
import { getTrackChanges } from '@extensions/track-changes/trackChangesHelpers/getTrackChanges.js';
import { TrackDeleteMarkName, TrackInsertMarkName } from '@extensions/track-changes/constants.js';
import { TrackChangesBasePluginKey } from '@extensions/track-changes/plugins/trackChangesBasePlugin.js';

const ALICE = { name: 'Alice Reviewer', email: 'alice@example.com' };
const BOB = { name: 'Bob Reviewer', email: 'bob@example.com' };
const FIXED_DATE = '2026-05-21T00:00:00.000Z';
const FOREIGN_INSERT_ID = 'foreign-insert';
const INSERTED_TEXT = 'here is my new text, do you like it?';
const INSERTED_TAIL = 'do you like it?';
const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const WORD_REPLACEMENT_FIXTURE = resolve(
  CURRENT_DIR,
  '../../../../../../tests/behavior/tests/comments/fixtures/sd-1960-word-replacement-no-comments.docx',
);

const findTextRange = (editor, text) => {
  let found = null;
  editor.state.doc.descendants((node, pos) => {
    if (found || !node.isText || !node.text) return;
    const index = node.text.indexOf(text);
    if (index === -1) return;
    found = { from: pos + index, to: pos + index + text.length };
    return false;
  });
  if (!found) throw new Error(`Text not found: ${text}`);
  return found;
};

const markEntries = (editor, markName) => {
  const entries = [];
  editor.state.doc.descendants((node) => {
    if (!node.isText || !node.text) return;
    for (const mark of node.marks ?? []) {
      if (mark.type?.name === markName) entries.push({ text: node.text, mark });
    }
  });
  return entries;
};

const textForMarkId = (editor, markName, id) =>
  markEntries(editor, markName)
    .filter(({ mark }) => mark.attrs?.id === id)
    .map(({ text }) => text)
    .join('');

const setDocumentWithTrackedInsertion = (editor, { author = ALICE, id = FOREIGN_INSERT_ID } = {}) => {
  const { schema } = editor;
  const insertMark = schema.marks[TrackInsertMarkName].create({
    id,
    author: author.name,
    authorEmail: author.email,
    date: FIXED_DATE,
  });
  const doc = schema.nodes.doc.create(
    {},
    schema.nodes.paragraph.create(
      {},
      schema.nodes.run.create({}, [
        schema.text('hello there '),
        schema.text(INSERTED_TEXT, [insertMark]),
        schema.text(' after'),
      ]),
    ),
  );

  editor.dispatch(
    editor.state.tr
      .replaceWith(0, editor.state.doc.content.size, doc.content)
      .setMeta('skipTrackChanges', true)
      .setMeta('inputType', 'test-setup'),
  );
};

const setDocumentWithSeparateRunTrackedInsertion = (editor, { author = ALICE, id = FOREIGN_INSERT_ID } = {}) => {
  const { schema } = editor;
  const insertMark = schema.marks[TrackInsertMarkName].create({
    id,
    author: author.name,
    authorEmail: author.email,
    date: FIXED_DATE,
  });
  const doc = schema.nodes.doc.create(
    {},
    schema.nodes.paragraph.create({}, [
      schema.nodes.run.create({}, schema.text('The quick brown fox jumps over the ')),
      schema.nodes.run.create({}, schema.text('lazy ', [insertMark])),
      schema.nodes.run.create({}, schema.text('dog.')),
    ]),
  );

  editor.dispatch(
    editor.state.tr
      .replaceWith(0, editor.state.doc.content.size, doc.content)
      .setMeta('skipTrackChanges', true)
      .setMeta('inputType', 'test-setup'),
  );
};

const deleteText = (editor, text) => {
  const { from, to } = findTextRange(editor, text);
  editor.dispatch(editor.state.tr.delete(from, to).setMeta('inputType', 'deleteContentBackward'));
};

const replaceText = (editor, text, replacement) => {
  const { from, to } = findTextRange(editor, text);
  editor.dispatch(editor.state.tr.insertText(replacement, from, to).setMeta('inputType', 'insertText'));
};

const getFirstMatchRef = (editor, pattern) => {
  const match = editor.doc.query.match({
    select: { type: 'text', pattern },
    require: 'first',
  });
  const ref = match?.items?.[0]?.handle?.ref;
  if (!ref) throw new Error(`Could not resolve ref for pattern "${pattern}"`);
  return ref;
};

describe('Editor dispatch tracked-change meta', () => {
  let editor;

  afterEach(() => {
    if (editor && !editor.isDestroyed) {
      editor.destroy();
      editor = null;
    }
  });

  it('treats forceTrackChanges programmatic transactions as tracked even when global mode is off', () => {
    ({ editor } = initTestEditor({
      mode: 'text',
      content: '<p>Hello</p>',
      user: { name: 'Test', email: 'test@example.com' },
      useImmediateSetTimeout: false,
    }));

    const trackInsertMark = editor.schema?.marks?.[TrackInsertMarkName];
    expect(trackInsertMark).toBeDefined();

    const trackState = TrackChangesBasePluginKey.getState(editor.state);
    expect(trackState?.isTrackChangesActive ?? false).toBe(false);
    expect(getTrackChanges(editor.state)).toHaveLength(0);

    const tr = editor.state.tr
      .insertText('X', 1, 1)
      .setMeta('inputType', 'programmatic')
      .setMeta('forceTrackChanges', true);

    editor.dispatch(tr);

    const tracked = getTrackChanges(editor.state);
    expect(tracked.some((entry) => entry.mark.type.name === TrackInsertMarkName)).toBe(true);
  });

  it('skipTrackChanges overrides forceTrackChanges — no tracking applied', () => {
    ({ editor } = initTestEditor({
      mode: 'text',
      content: '<p>Hello</p>',
      user: { name: 'Test', email: 'test@example.com' },
      useImmediateSetTimeout: false,
    }));

    const trackState = TrackChangesBasePluginKey.getState(editor.state);
    expect(trackState?.isTrackChangesActive ?? false).toBe(false);

    const tr = editor.state.tr
      .insertText('X', 1, 1)
      .setMeta('inputType', 'programmatic')
      .setMeta('forceTrackChanges', true)
      .setMeta('skipTrackChanges', true);

    editor.dispatch(tr);

    const tracked = getTrackChanges(editor.state);
    expect(tracked).toHaveLength(0);
  });

  it('throws a clear error when forceTrackChanges is used without a configured user', () => {
    ({ editor } = initTestEditor({
      mode: 'text',
      content: '<p>Hello</p>',
      useImmediateSetTimeout: false,
    }));

    const tr = editor.state.tr
      .insertText('X', 1, 1)
      .setMeta('inputType', 'programmatic')
      .setMeta('forceTrackChanges', true);

    expect(() => editor.dispatch(tr)).toThrow(
      'forceTrackChanges requires a user to be configured on the editor instance.',
    );
  });

  it('global track-changes mode still produces tracked entities without forceTrackChanges', () => {
    ({ editor } = initTestEditor({
      mode: 'text',
      content: '<p>Hello</p>',
      user: { name: 'Test', email: 'test@example.com' },
      useImmediateSetTimeout: false,
    }));

    const enableTr = editor.state.tr.setMeta(TrackChangesBasePluginKey, {
      type: 'TRACK_CHANGES_ENABLE',
      value: true,
    });
    editor.dispatch(enableTr);

    const trackState = TrackChangesBasePluginKey.getState(editor.state);
    expect(trackState?.isTrackChangesActive).toBe(true);

    const tr = editor.state.tr.insertText('Y', 1, 1).setMeta('inputType', 'programmatic');

    editor.dispatch(tr);

    const tracked = getTrackChanges(editor.state);
    expect(tracked.some((entry) => entry.mark.type.name === TrackInsertMarkName)).toBe(true);
  });

  it('emits an add commentsUpdate when a native suggesting insert creates a tracked insertion', () => {
    ({ editor } = initTestEditor({
      mode: 'text',
      content: '<p>Hello</p>',
      user: { name: 'Test', email: 'test@example.com' },
      useImmediateSetTimeout: false,
    }));

    editor.setDocumentMode('suggesting');

    const emitSpy = vi.spyOn(editor, 'emit');
    const tr = editor.state.tr.insertText('Tracked ', 1, 1).setMeta('inputType', 'insertText');

    editor.dispatch(tr);

    const tracked = getTrackChanges(editor.state);
    expect(tracked.some((entry) => entry.mark.type.name === TrackInsertMarkName)).toBe(true);

    const addPayload = emitSpy.mock.calls.find(
      ([eventName, payload]) =>
        eventName === 'commentsUpdate' &&
        payload?.type === 'trackedChange' &&
        payload?.event === 'add' &&
        payload?.trackedChangeType === TrackInsertMarkName,
    )?.[1];

    expect(addPayload).toEqual(
      expect.objectContaining({
        trackedChangeText: expect.stringContaining('Tracked'),
        author: 'Test',
        authorEmail: 'test@example.com',
      }),
    );
  });

  it('normalizes modules.trackChanges.replacements for direct Editor.open callers', async () => {
    const opened = await Editor.open(undefined, {
      isHeadless: true,
      modules: { trackChanges: { replacements: 'independent' } },
    });

    try {
      expect(opened.options.trackedChanges?.replacements).toBe('independent');
    } finally {
      opened.destroy();
    }
  });

  it('uses modules.trackChanges.replacements during Word replacement import projection', async () => {
    const fixture = await readFile(WORD_REPLACEMENT_FIXTURE);
    const paired = await Editor.open(fixture, {
      isHeadless: true,
      modules: { trackChanges: { replacements: 'paired' } },
    });
    const independent = await Editor.open(fixture, {
      isHeadless: true,
      modules: { trackChanges: { replacements: 'independent' } },
    });

    try {
      const pairedItems = paired.doc.trackChanges.list().items;
      const independentItems = independent.doc.trackChanges.list().items;

      expect(pairedItems).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'replacement', grouping: 'replacement-pair' })]),
      );
      expect(independentItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'insert', grouping: 'standalone' }),
          expect.objectContaining({ type: 'delete', grouping: 'standalone' }),
        ]),
      );
      expect(independentItems.some((item) => item.grouping === 'replacement-pair')).toBe(false);
      expect(independentItems.length).toBeGreaterThan(pairedItems.length);
    } finally {
      paired.destroy();
      independent.destroy();
    }
  });

  it('protects another user tracked insertion from direct delete while local track mode is off', () => {
    ({ editor } = initTestEditor({
      mode: 'text',
      content: '<p></p>',
      user: BOB,
      useImmediateSetTimeout: false,
    }));
    setDocumentWithTrackedInsertion(editor);

    const trackState = TrackChangesBasePluginKey.getState(editor.state);
    expect(trackState?.isTrackChangesActive ?? false).toBe(false);

    deleteText(editor, INSERTED_TAIL);

    expect(editor.state.doc.textContent).toContain(INSERTED_TEXT);
    expect(textForMarkId(editor, TrackInsertMarkName, FOREIGN_INSERT_ID)).toBe(INSERTED_TEXT);

    const childDeletion = markEntries(editor, TrackDeleteMarkName).find(({ text }) => text === INSERTED_TAIL);
    expect(childDeletion?.mark.attrs).toEqual(
      expect.objectContaining({
        authorEmail: BOB.email,
        overlapParentId: FOREIGN_INSERT_ID,
      }),
    );
  });

  it('protects anonymous live tracked insertion from direct delete without a configured editor user', () => {
    ({ editor } = initTestEditor({
      mode: 'text',
      content: '<p></p>',
      useImmediateSetTimeout: false,
    }));
    setDocumentWithTrackedInsertion(editor, { author: { name: '', email: '' }, id: FOREIGN_INSERT_ID });

    const trackState = TrackChangesBasePluginKey.getState(editor.state);
    expect(trackState?.isTrackChangesActive ?? false).toBe(false);

    deleteText(editor, INSERTED_TAIL);

    expect(editor.state.doc.textContent).toContain(INSERTED_TEXT);
    expect(textForMarkId(editor, TrackInsertMarkName, FOREIGN_INSERT_ID)).toBe(INSERTED_TEXT);

    const childDeletion = markEntries(editor, TrackDeleteMarkName).find(({ text }) => text === INSERTED_TAIL);
    expect(childDeletion?.mark.attrs).toEqual(
      expect.objectContaining({
        author: '',
        authorEmail: '',
        overlapParentId: FOREIGN_INSERT_ID,
      }),
    );
  });

  it('protects anonymous live tracked insertion from document-api direct delete', () => {
    ({ editor } = initTestEditor({
      mode: 'text',
      content: '<p></p>',
      useImmediateSetTimeout: false,
    }));
    setDocumentWithTrackedInsertion(editor, { author: { name: '', email: '' }, id: FOREIGN_INSERT_ID });

    const receipt = editor.doc.delete({ ref: getFirstMatchRef(editor, INSERTED_TAIL) }, { changeMode: 'direct' });

    expect(receipt.success).toBe(true);
    expect(editor.state.doc.textContent).toContain(INSERTED_TEXT);
    expect(textForMarkId(editor, TrackInsertMarkName, FOREIGN_INSERT_ID)).toBe(INSERTED_TEXT);

    const childDeletion = markEntries(editor, TrackDeleteMarkName).find(({ text }) => text === INSERTED_TAIL);
    expect(childDeletion?.mark.attrs).toEqual(
      expect.objectContaining({
        author: '',
        authorEmail: '',
        overlapParentId: FOREIGN_INSERT_ID,
      }),
    );
  });

  it('protects tracked insertion created by document-api insert from document-api direct delete', () => {
    ({ editor } = initTestEditor({
      mode: 'text',
      content: '<p></p>',
      user: { id: 'cli', name: 'CLI' },
      useImmediateSetTimeout: false,
    }));

    expect(editor.doc.trackChanges.list().total).toBe(0);
    expect(editor.doc.comments.list().total).toBe(0);

    const insertReceipt = editor.doc.insert({ value: 'live-review-comment' }, { changeMode: 'tracked' });
    expect(insertReceipt.success).toBe(true);

    const insertMark = markEntries(editor, TrackInsertMarkName).find(({ text }) => text === 'live-review-comment');
    expect(insertMark?.mark.attrs).toEqual(
      expect.objectContaining({
        author: 'CLI',
        authorId: 'cli',
        authorEmail: '',
      }),
    );

    const deleteReceipt = editor.doc.delete({ ref: getFirstMatchRef(editor, 'review') }, { changeMode: 'direct' });

    expect(deleteReceipt.success).toBe(true);
    expect(editor.state.doc.textContent).toContain('live-review-comment');

    expect(textForMarkId(editor, TrackInsertMarkName, insertMark?.mark.attrs.id)).toBe('live-review-comment');

    const childDeletion = markEntries(editor, TrackDeleteMarkName).find(({ text }) => text === 'review');
    expect(childDeletion?.mark.attrs).toEqual(
      expect.objectContaining({
        author: 'CLI',
        authorId: 'cli',
        authorEmail: '',
        overlapParentId: insertMark?.mark.attrs.id,
      }),
    );

    const trackedChanges = editor.doc.trackChanges.list();
    expect(trackedChanges.total).toBe(2);
    expect(trackedChanges.items.map((item) => item.raw?.type ?? item.type).sort()).toEqual(['delete', 'insert']);

    const comments = editor.doc.comments.list();
    expect(comments.total).toBe(2);
    expect(comments.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ trackedChangeType: 'insert', trackedChangeText: 'live-review-comment' }),
        expect.objectContaining({ trackedChangeType: 'delete', deletedText: 'review' }),
      ]),
    );
  });

  it('protects another user tracked insertion from direct replace while local track mode is off', () => {
    ({ editor } = initTestEditor({
      mode: 'text',
      content: '<p></p>',
      user: BOB,
      useImmediateSetTimeout: false,
    }));
    setDocumentWithTrackedInsertion(editor);

    replaceText(editor, INSERTED_TAIL, 'yes');

    expect(editor.state.doc.textContent).toContain(INSERTED_TAIL);
    expect(editor.state.doc.textContent).toContain('yes');

    const childDeletion = markEntries(editor, TrackDeleteMarkName).find(({ text }) => text === INSERTED_TAIL);
    expect(childDeletion?.mark.attrs).toEqual(
      expect.objectContaining({
        authorEmail: BOB.email,
        overlapParentId: FOREIGN_INSERT_ID,
      }),
    );

    const childInsertion = markEntries(editor, TrackInsertMarkName).find(
      ({ text, mark }) => text === 'yes' && mark.attrs?.id !== FOREIGN_INSERT_ID,
    );
    expect(childInsertion?.mark.attrs).toEqual(
      expect.objectContaining({
        authorEmail: BOB.email,
        overlapParentId: FOREIGN_INSERT_ID,
      }),
    );
  });

  it('protects an imported-style separate-run tracked insertion from direct doc.replace', () => {
    ({ editor } = initTestEditor({
      mode: 'text',
      content: '<p></p>',
      user: BOB,
      useImmediateSetTimeout: false,
    }));
    setDocumentWithSeparateRunTrackedInsertion(editor);

    const receipt = editor.doc.replace(
      {
        ref: getFirstMatchRef(editor, 'lazy'),
        text: 'quickly',
      },
      { changeMode: 'direct' },
    );

    expect(receipt.success).toBe(true);
    expect(textForMarkId(editor, TrackInsertMarkName, FOREIGN_INSERT_ID)).toBe('lazy ');

    const childDeletion = markEntries(editor, TrackDeleteMarkName).find(({ text }) => text === 'lazy');
    expect(childDeletion?.mark.attrs).toEqual(
      expect.objectContaining({
        authorEmail: BOB.email,
        overlapParentId: FOREIGN_INSERT_ID,
      }),
    );

    const childInsertion = markEntries(editor, TrackInsertMarkName).find(
      ({ text, mark }) => text === 'quickly' && mark.attrs?.id !== FOREIGN_INSERT_ID,
    );
    expect(childInsertion?.mark.attrs).toEqual(
      expect.objectContaining({
        authorEmail: BOB.email,
        overlapParentId: FOREIGN_INSERT_ID,
      }),
    );
  });

  it('emits review comment state for a protected child deletion instead of only truncating the parent', () => {
    ({ editor } = initTestEditor({
      mode: 'text',
      content: '<p></p>',
      user: BOB,
      useImmediateSetTimeout: false,
    }));
    setDocumentWithTrackedInsertion(editor);

    const emitSpy = vi.spyOn(editor, 'emit');
    deleteText(editor, INSERTED_TAIL);

    const childDeletionEvent = emitSpy.mock.calls.find(
      ([eventName, payload]) =>
        eventName === 'commentsUpdate' &&
        payload?.type === 'trackedChange' &&
        payload?.event === 'add' &&
        payload?.trackedChangeType === TrackDeleteMarkName,
    )?.[1];

    expect(childDeletionEvent).toEqual(
      expect.objectContaining({
        deletedText: expect.stringContaining(INSERTED_TAIL),
        authorEmail: BOB.email,
      }),
    );
    expect(textForMarkId(editor, TrackInsertMarkName, FOREIGN_INSERT_ID)).toBe(INSERTED_TEXT);
  });

  it('still allows direct deletion of untracked plain text while local track mode is off', () => {
    ({ editor } = initTestEditor({
      mode: 'text',
      content: '<p>hello plain text</p>',
      user: BOB,
      useImmediateSetTimeout: false,
    }));

    deleteText(editor, 'plain ');

    expect(editor.state.doc.textContent).toBe('hello text');
    expect(markEntries(editor, TrackInsertMarkName)).toHaveLength(0);
    expect(markEntries(editor, TrackDeleteMarkName)).toHaveLength(0);
  });

  it('collapses the current user own insertion on direct delete without creating a child review item', () => {
    ({ editor } = initTestEditor({
      mode: 'text',
      content: '<p></p>',
      user: BOB,
      useImmediateSetTimeout: false,
    }));
    setDocumentWithTrackedInsertion(editor, { author: BOB, id: 'own-insert' });

    deleteText(editor, INSERTED_TEXT);

    expect(editor.state.doc.textContent).toBe('hello there  after');
    expect(markEntries(editor, TrackInsertMarkName).filter(({ mark }) => mark.attrs?.id === 'own-insert')).toHaveLength(
      0,
    );
    expect(markEntries(editor, TrackDeleteMarkName)).toHaveLength(0);
  });
});
