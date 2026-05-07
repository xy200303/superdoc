import { beforeAll, describe, expect, it } from 'vitest';
import { Doc as YDoc, XmlElement, XmlText } from 'yjs';
import { Editor } from './Editor.js';
import { getStarterExtensions } from '@extensions/index.js';
import { seedEditorStateToYDoc } from '@extensions/collaboration/seed-editor-to-ydoc.js';
import { getTestDataAsFileBuffer } from '@tests/helpers/helpers.js';

type SyncHandler = (synced?: boolean) => void;

function createProviderStub() {
  const listeners = {
    sync: new Set<SyncHandler>(),
    synced: new Set<SyncHandler>(),
  };

  return {
    awareness: {
      getStates() {
        return new Map();
      },
      on() {},
      off() {},
    },
    synced: false,
    isSynced: false,
    on(event: 'sync' | 'synced', handler: SyncHandler) {
      listeners[event].add(handler);
    },
    off(event: 'sync' | 'synced', handler: SyncHandler) {
      listeners[event].delete(handler);
    },
    emit(event: 'sync' | 'synced', value?: boolean) {
      for (const handler of listeners[event]) {
        handler(value);
      }
    },
  };
}

function createTestEditor(options: Partial<ConstructorParameters<typeof Editor>[0]> = {}) {
  return new Editor({
    isHeadless: true,
    deferDocumentLoad: true,
    mode: 'docx',
    extensions: getStarterExtensions(),
    suppressDefaultDocxStyles: true,
    ...options,
  });
}

function collectCrossReferences(editor: Editor) {
  const crossReferences: Array<{ pos: number; attrs: Record<string, unknown>; textContent: string }> = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'crossReference') {
      crossReferences.push({ pos, attrs: node.attrs, textContent: node.textContent });
    }
    return true;
  });
  return crossReferences;
}

function createCrossReferencePmDoc(editor: Editor) {
  const { schema } = editor;
  return schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('Hello I am a list')]),
    schema.node('paragraph', null, [
      schema.text('Hello I am a reference to list item: '),
      schema.nodes.crossReference.create({
        instruction: 'REF _Ref228977094 \\r \\h',
        fieldType: 'REF',
        target: '_Ref228977094',
        display: 'paragraphNumber',
        resolvedText: '\u200e1',
        marksAsAttrs: [{ type: 'textStyle', attrs: {} }],
      }),
    ]),
  ]);
}

function findYXmlElementByNodeName(root: unknown, nodeName: string): XmlElement | null {
  let match: XmlElement | null = null;
  const walk = (node: unknown) => {
    if (match) return;
    if (node instanceof XmlElement && node.nodeName === nodeName) {
      match = node;
      return;
    }
    if (node && typeof (node as { forEach?: unknown }).forEach === 'function') {
      (node as { forEach: (callback: (child: unknown) => void) => void }).forEach((child) => walk(child));
    }
  };
  walk(root);
  return match;
}

function addCachedResultRunToYjsCrossReference(ydoc: YDoc): void {
  const crossReferenceElement = findYXmlElementByNodeName(ydoc.getXmlFragment('supereditor'), 'crossReference');
  if (!crossReferenceElement) {
    throw new Error('Expected seeded Yjs fragment to contain a crossReference element.');
  }

  const run = new XmlElement('run');
  run.setAttribute('runProperties', {
    rFonts: { ascii: 'Aptos', hAnsi: 'Aptos', cs: 'Arial' },
    fontSize: 24,
    fontSizeCs: 24,
  });
  run.setAttribute('runPropertiesInlineKeys', ['fontFamily', 'cs']);

  const text = new XmlText();
  text.insert(0, '\u200e1');
  run.insert(0, [text]);
  crossReferenceElement.insert(0, [run]);
}

describe('Editor collaboration seeding', () => {
  let centeredBuffer: Buffer;

  beforeAll(async () => {
    centeredBuffer = await getTestDataAsFileBuffer('advanced-text.docx');
  });

  it('preserves the first paragraph attrs when seeding a collaborative room', async () => {
    const provider = createProviderStub();
    const ydoc = new YDoc();
    const seededEditor = createTestEditor({
      ydoc,
      collaborationProvider: provider,
    });
    const directEditor = createTestEditor();

    try {
      await seededEditor.open(centeredBuffer, {
        mode: 'docx',
        isNewFile: true,
      });
      await directEditor.open(centeredBuffer, {
        mode: 'docx',
      });

      provider.emit('synced', true);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const seededFirstParagraph = seededEditor.state.doc.firstChild;
      const directFirstParagraph = directEditor.state.doc.firstChild;

      expect(seededFirstParagraph?.textContent).toBe(directFirstParagraph?.textContent);
      expect(seededFirstParagraph?.attrs?.paraId).toBe(directFirstParagraph?.attrs?.paraId);
      expect(seededFirstParagraph?.attrs?.paragraphProperties?.justification).toBe(
        directFirstParagraph?.attrs?.paragraphProperties?.justification,
      );
      expect(seededFirstParagraph?.attrs?.attributes ?? null).toEqual(directFirstParagraph?.attrs?.attributes ?? null);
    } finally {
      if (seededEditor.lifecycleState === 'ready') {
        seededEditor.close();
      }
      if (directEditor.lifecycleState === 'ready') {
        directEditor.close();
      }
      seededEditor.destroy();
      directEditor.destroy();
    }
  });

  it('preserves crossReference nodes when a second collaboration client hydrates from the room', async () => {
    const observerProvider = createProviderStub();
    observerProvider.synced = true;
    observerProvider.isSynced = true;
    const ydoc = new YDoc();
    const seedEditor = createTestEditor();
    const observerEditor = createTestEditor({
      ydoc,
      collaborationProvider: observerProvider,
    });

    try {
      await seedEditor.open(undefined, { mode: 'docx' });
      const crossReferenceDoc = createCrossReferencePmDoc(seedEditor);
      seedEditor.dispatch(seedEditor.state.tr.replaceWith(0, seedEditor.state.doc.content.size, crossReferenceDoc));

      const seededCrossReferences = collectCrossReferences(seedEditor);
      expect(seededCrossReferences).toHaveLength(1);
      expect(seededCrossReferences[0].attrs.resolvedText).toBe('\u200e1');

      seedEditorStateToYDoc(seedEditor, ydoc);
      addCachedResultRunToYjsCrossReference(ydoc);
      expect(ydoc.getXmlFragment('supereditor').toString()).toContain('crossreference');
      expect(ydoc.getXmlFragment('supereditor').toString()).toContain('REF _Ref228977094');

      await observerEditor.open(undefined, {
        mode: 'docx',
        fragment: ydoc.getXmlFragment('supereditor'),
        isNewFile: false,
      });

      observerProvider.emit('synced', true);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const observerCrossReferences = collectCrossReferences(observerEditor);
      expect(observerCrossReferences).toHaveLength(1);
      expect(observerCrossReferences[0].attrs.instruction).toBe('REF _Ref228977094 \\r \\h');
      expect(observerCrossReferences[0].attrs.target).toBe('_Ref228977094');
      expect(observerCrossReferences[0].attrs.resolvedText).toBe('\u200e1');

      const postHydrationSharedXml = ydoc.getXmlFragment('supereditor').toString();
      expect(postHydrationSharedXml).toContain('crossreference');
      expect(postHydrationSharedXml).toContain('REF _Ref228977094');
    } finally {
      if (seedEditor.lifecycleState === 'ready') {
        seedEditor.close();
      }
      if (observerEditor.lifecycleState === 'ready') {
        observerEditor.close();
      }
      seedEditor.destroy();
      observerEditor.destroy();
      ydoc.destroy();
    }
  });
});
