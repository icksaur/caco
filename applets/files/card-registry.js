/**
 * Files applet — card registry (spec-files-applet-cards).
 *
 * Single source of truth for "which navigable cards does this file type have, and
 * what verb reaches each". Replaces the old two-mechanism buttons (updateToggle +
 * updateModeToggle). A card = { id, verb, viewerType, mode? }; the tab's top-right
 * strip renders a verb button for every reachable card except the active one, and
 * the active card is DERIVED from the real (activeViewerType, activeMode) so it can
 * never diverge (currentCardId in script.js).
 *
 * Pure + side-effect-free. Concatenated into the applet as a browser global
 * (window.__filesCardRegistry) AND CJS-importable by the unit test (UMD tail), so
 * the oracle tests the exact shipped logic, not a copy.
 *
 * Extension predicates MUST stay in sync with script.js isBinaryExtension /
 * buildViewerRegistry and the *-viewer.js descriptors.
 */
(function (root) {
  'use strict';

  var RE_MARKDOWN = /\.(md|markdown|mdx)$/i;
  var RE_IMAGE = /\.(png|jpg|jpeg|gif|webp|svg|ico)$/i;
  var RE_AUDIO = /\.(wav|mp3|ogg|oga|m4a|aac|opus|flac)$/i;
  var RE_HTML = /\.html?$/i;
  var RE_BINARY = /\.(png|jpg|jpeg|gif|webp|svg|ico|pdf|zip|gz|tar|bin|exe|class|jar|wav|mp3|ogg|oga|m4a|aac|opus|flac)$/i;

  function isMarkdown(rel) { return RE_MARKDOWN.test(rel || ''); }
  function isImage(rel) { return RE_IMAGE.test(rel || ''); }
  function isAudio(rel) { return RE_AUDIO.test(rel || ''); }
  function isHtml(rel) { return RE_HTML.test(rel || ''); }
  function isBinary(rel) { return RE_BINARY.test(rel || ''); }

  /** The editable-text viewer for a file: markdown files edit through the markdown
   *  viewer's edit mode, everything else through the source viewer's edit mode. This
   *  collapses "markdown edit" and "source edit" into ONE `edit` card per file. */
  function editViewerType(rel) { return isMarkdown(rel) ? 'markdown' : 'source'; }

  /**
   * The ordered list of navigable cards for a file. Order is the strip render order.
   * `caps` = { canEdit, canDiff, ... } (from the applet shell); `isReadOnly` = the
   * open viewer's read-only flag (external / no-write files).
   */
  function cardsForFile(rel, caps, isReadOnly) {
    caps = caps || {};
    var canEdit = !!caps.canEdit && !isReadOnly;
    // Diff is in-cwd git only; a read-only/external file isn't in the repo, so it
    // drops diff too (spec: external/read-only drops edit AND diff).
    var canDiff = !!caps.canDiff && !isReadOnly;
    var cards = [];

    function pushEditAndDiff() {
      if (canEdit) cards.push({ id: 'edit', verb: 'Edit', viewerType: editViewerType(rel), mode: 'edit' });
      if (canDiff && !isBinary(rel)) cards.push({ id: 'diff', verb: 'Diff', viewerType: 'diff' });
    }

    if (isImage(rel)) {
      cards.push({ id: 'image', verb: 'Image', viewerType: 'image' });
      return cards;
    }
    if (isAudio(rel)) {
      cards.push({ id: 'audio', verb: 'Audio', viewerType: 'audio' });
      return cards;
    }
    if (isMarkdown(rel)) {
      cards.push({ id: 'preview', verb: 'Preview', viewerType: 'markdown', mode: 'view' });
      pushEditAndDiff();
      cards.push({ id: 'source', verb: 'Source', viewerType: 'source', mode: 'view' });
      return cards;
    }
    if (isHtml(rel)) {
      cards.push({ id: 'html', verb: 'HTML', viewerType: 'html' });
      pushEditAndDiff();
      cards.push({ id: 'source', verb: 'Source', viewerType: 'source', mode: 'view' });
      return cards;
    }
    if (!isBinary(rel)) {
      cards.push({ id: 'source', verb: 'Source', viewerType: 'source', mode: 'view' });
      pushEditAndDiff();
      return cards;
    }
    // Binary non-media: no installed viewer handles it.
    return cards;
  }

  /** The default card id — the card matching today's default-viewer selection:
   *  markdown/image/audio/html by extension, else diff when available else source. */
  function defaultCardId(rel, caps, isReadOnly) {
    var cards = cardsForFile(rel, caps, isReadOnly);
    if (!cards.length) return null;
    if (isMarkdown(rel)) return 'preview';
    if (isImage(rel)) return 'image';
    if (isAudio(rel)) return 'audio';
    if (isHtml(rel)) return 'html';
    if (hasCard(cards, 'diff')) return 'diff';
    return 'source';
  }

  function hasCard(cards, id) {
    for (var i = 0; i < cards.length; i++) if (cards[i].id === id) return true;
    return false;
  }

  /** Reverse-map the real (activeViewerType, activeMode) to the card id it realizes.
   *  Used by currentCardId() (derive, never store) and legacy rehydrate. Returns null
   *  when the pair names no card kind. */
  function cardIdForViewerState(viewerType, mode) {
    if (viewerType === 'diff') return 'diff';
    if (viewerType === 'image') return 'image';
    if (viewerType === 'audio') return 'audio';
    if (viewerType === 'html') return 'html';
    if (viewerType === 'source') return mode === 'edit' ? 'edit' : 'source';
    if (viewerType === 'markdown') return mode === 'edit' ? 'edit' : 'preview';
    return null;
  }

  /**
   * Resolve a persisted/legacy selection to a card id valid for this file: prefer an
   * explicit `activeCard`, else map the legacy (viewerType, mode) pair, and fall back
   * to the default card when the result is not in this file's card list.
   */
  function resolvePersistedCardId(rel, caps, isReadOnly, persisted) {
    var cards = cardsForFile(rel, caps, isReadOnly);
    persisted = persisted || {};
    var candidate = persisted.activeCard || cardIdForViewerState(persisted.activeViewerType, persisted.mode);
    if (candidate && hasCard(cards, candidate)) return candidate;
    return defaultCardId(rel, caps, isReadOnly);
  }

  var api = {
    cardsForFile: cardsForFile,
    defaultCardId: defaultCardId,
    cardIdForViewerState: cardIdForViewerState,
    resolvePersistedCardId: resolvePersistedCardId,
    editViewerType: editViewerType,
  };

  root.__filesCardRegistry = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
