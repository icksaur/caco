/**
 * Shared editable-file helper for the files applet. Exposes the single subtle
 * bit MarkdownViewer and SourceViewer must agree on: the PUT-to-disk URL
 * builder. Kept standalone so the encoding (and the absolute-vs-relative
 * leading-slash handling) lives in exactly one place. Loads alphabetically
 * before the viewers (applet sibling *.js are prepended before script.js).
 */
(function() {
  window.__filesApplet = window.__filesApplet || {};

  /**
   * PUT raw text to /api/files/<path>. The server route treats the captured
   * path as relative unless it begins with '/'; Express collapses the empty
   * segment, so an absolute path must keep BOTH slashes (/api/files//home/...).
   * Without this an absolute path would land at programCwd-relative and
   * writeFile would mkdir a nested ghost tree. Throws Error(message) on a
   * non-ok response; resolves the Response on success.
   */
  window.__filesApplet.writeFileText = async function(absPath, text) {
    var encodedAbs = absPath.split('/').map(encodeURIComponent).join('/');
    var url = '/api/files' + (absPath.charAt(0) === '/' ? '/' : '') + encodedAbs;
    var res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
    });
    if (!res.ok) {
      var msg;
      try {
        var body = await res.json();
        msg = (body && body.error) || ('HTTP ' + res.status);
      } catch (_e) {
        msg = 'HTTP ' + res.status;
      }
      throw new Error(msg);
    }
    return res;
  };
})();
