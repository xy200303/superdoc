// @ts-check
/**
 * Identity helpers for the review graph.
 *
 * Same-user behavior requires high-confidence identity. A trusted author email
 * match on both the current editor user and the change author's stored email
 * is the only signal that returns `same-user`. Every other combination —
 * missing email on either side, only display-name match, imported author
 * strings without a trusted email, or mismatched email — returns a
 * different-user classification.
 */

/**
 * Trim and lowercase an email value. Anything not a string normalizes to ''.
 * @param {unknown} value
 * @returns {string}
 */
export const normalizeEmail = (value) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.toLowerCase();
};

/**
 * @typedef {Object} UserIdentity
 * @property {string} email     normalized email, '' when unknown.
 * @property {string} name      display name (may be empty).
 * @property {boolean} hasEmail true when normalized email is non-empty.
 * @property {string} [importedAuthor] imported author provenance, when present.
 */

/**
 * Read the current user identity from the editor options.
 * Tolerates a missing editor / options / user so callers can pass a partial
 * editor (or a snapshot for tests).
 *
 * @param {{ options?: { user?: { name?: unknown, email?: unknown } } } | null | undefined} editor
 * @returns {UserIdentity}
 */
export const getCurrentUserIdentity = (editor) => {
  const user = editor?.options?.user ?? null;
  const email = normalizeEmail(user?.email);
  const name = typeof user?.name === 'string' ? user.name : '';
  return { email, name, hasEmail: email.length > 0 };
};

/**
 * Pull the author identity off a mark's attrs (or a graph-shaped change/segment).
 * Accepts the raw mark, its attrs, or a graph object with `author`/`authorEmail`.
 *
 * @param {*} changeOrAttrs
 * @returns {UserIdentity}
 */
export const getChangeAuthorIdentity = (changeOrAttrs) => {
  if (!changeOrAttrs) return { email: '', name: '', hasEmail: false };

  // Accept either { attrs: {...} }, { mark: { attrs } }, or a flat attrs map.
  const attrs = changeOrAttrs.attrs ?? changeOrAttrs.mark?.attrs ?? changeOrAttrs;

  const email = normalizeEmail(attrs?.authorEmail);
  const name = typeof attrs?.author === 'string' ? attrs.author : '';
  const importedAuthor = typeof attrs?.importedAuthor === 'string' ? attrs.importedAuthor : '';
  return { email, name, hasEmail: email.length > 0, importedAuthor };
};

/**
 * @typedef {(
 *   | 'same-user'
 *   | 'different-user'
 *   | 'unknown-current-user'
 *   | 'unknown-change-author'
 *   | 'conflicting'
 * )} OwnershipClassification
 */

/**
 * Classify ownership between the current editor user and a change author.
 *
 * Rules (per plan):
 * - normalized authorEmail match is high-confidence => `same-user`.
 * - display name alone is never same-user.
 * - missing current user email is `unknown-current-user`.
 * - missing change author email is `unknown-change-author`.
 * - both emails present but different => `different-user`.
 * - conflicting signals (e.g. emails match but names differ in a way that
 *   indicates an impersonation) are reported as `conflicting`. Caller treats
 *   it as different-user; the distinct code lets diagnostics report it.
 *
 * Only `same-user` may trigger same-user refinement. Every other code MUST
 * use different-user overlap behavior.
 *
 * @param {{ currentUser?: UserIdentity, change?: UserIdentity }} input
 * @returns {OwnershipClassification}
 */
export const classifyOwnership = ({ currentUser, change }) => {
  const cur = currentUser ?? { email: '', name: '', hasEmail: false };
  const auth = change ?? { email: '', name: '', hasEmail: false };

  if (!cur.hasEmail) return 'unknown-current-user';
  if (!auth.hasEmail) return 'unknown-change-author';

  if (cur.email === auth.email) {
    // Same email but obviously different display name pattern is still
    // 'same-user' — display name is not a security signal. Only flag
    // `conflicting` if the change carries an explicit `importedAuthor`
    // mismatch with a different display, which is an import-provenance
    // signal that should NOT be treated as ordinary same-user refinement.
    if (
      typeof change?.importedAuthor === 'string' &&
      change.importedAuthor.trim() &&
      cur.name &&
      change.importedAuthor.trim().toLowerCase() !== cur.name.trim().toLowerCase() &&
      change.name &&
      change.name !== cur.name
    ) {
      return 'conflicting';
    }
    return 'same-user';
  }

  return 'different-user';
};

/**
 * Convenience: returns true only when the classification is high-confidence
 * same-user. Use this as the gate before applying same-user refinement.
 *
 * @param {OwnershipClassification} classification
 * @returns {boolean}
 */
export const isSameUserHighConfidence = (classification) => classification === 'same-user';
