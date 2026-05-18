import { useState } from 'react';
import { useSuperDocHost } from 'superdoc/ui/react';
import { MOCK_DRAFTS, computeCitationTargets } from './mockDraft';
import { useCitations } from './useCitations';

type PMNode = {
  type?: { name?: string };
  attrs?: Record<string, unknown>;
  isTextblock?: boolean;
  textContent?: string;
};

type EditorHandle = {
  doc?: {
    insert?: (input: { value: string; type?: string }) => unknown;
  };
  state?: {
    doc?: PMNode & { descendants: (fn: (node: PMNode) => boolean | void) => void };
  };
};

/**
 * Find the blockId of the last text block that contains `text`. We use
 * this instead of trusting the `editor.doc.insert` receipt because in
 * the browser build it doesn't always carry `target.blockId` — different
 * surface from the SDK / CLI path.
 */
function findBlockIdContaining(editor: EditorHandle, text: string): string | null {
  const doc = editor.state?.doc;
  if (!doc) return null;
  let last: string | null = null;
  doc.descendants((node) => {
    if (!node.isTextblock) return;
    const content = node.textContent ?? '';
    if (content.includes(text)) {
      const id = node.attrs?.sdBlockId;
      if (typeof id === 'string') last = id;
    }
  });
  return last;
}

/**
 * Mocked "AI draft with sources" entry point.
 *
 * Clicks rotate through `MOCK_DRAFTS`, insert the paragraph at the
 * end of the document via `editor.doc.insert`, then call
 * `metadata.attach` once per citation in the draft. The button is a
 * stand-in for a chat/prompt-driven RAG flow; a real integration
 * replaces this with whatever surface drives generation in the
 * customer's product.
 */
export function GenerateDraftButton() {
  const host = useSuperDocHost();
  const { attach } = useCitations();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);

  const generate = () => {
    setError(null);
    const editor = (host as unknown as { activeEditor?: EditorHandle }).activeEditor;
    const insert = editor?.doc?.insert;
    if (!insert) {
      setError('editor.doc.insert is not available on this build.');
      return;
    }

    setBusy(true);
    const draft = MOCK_DRAFTS[index % MOCK_DRAFTS.length]!;
    try {
      insert({ value: draft.text });
      // Walk the doc to find the block that now contains the inserted
      // text. The insert receipt does not reliably carry blockId in the
      // browser build; the doc walk is more robust.
      const blockId = findBlockIdContaining(editor!, draft.text.slice(0, 40));
      if (!blockId) {
        setError('Could not locate the inserted paragraph in the document.');
        return;
      }
      const targets = computeCitationTargets(draft, blockId);
      for (const { target, payload } of targets) {
        const r = attach(target, payload, payload.citationId);
        if ('error' in r) {
          setError(`metadata.attach failed for ${payload.citationId}: ${r.error}`);
          return;
        }
      }
      setIndex((i) => i + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="generate-draft">
      <button className="primary generate-draft-btn" onClick={generate} disabled={busy || !host}>
        {busy ? 'Inserting\u2026' : 'Insert sample cited draft'}
      </button>
      <p className="generate-draft-help">
        Mocked stand-in for a chat/prompt workflow. Inserts sample text with citations already
        attached, the way a real legal-AI product would emit source-grounded output.
      </p>
      {error && <div className="composer-error">{error}</div>}
    </div>
  );
}
