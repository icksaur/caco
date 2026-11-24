/**
 * Page base path (spec-portal-single-port, Phase A).
 *
 * A hub proxy serves a peer under `/peer/<key>/` and tells it so with the
 * `X-Caco-Base-Path` header. Pages served under a prefix get, first in `<head>`:
 * a `<base href>` (relative URLs resolve under the prefix), `window.CACO_BASE`,
 * and a fetch wrapper that prefixes same-origin root-absolute paths (core code,
 * applets and extensions all call `fetch('/api/...')`).
 *
 * The header is display-only: a spoofed value can only break the spoofer's own
 * page. Without a valid header the page is served exactly as before.
 */

export const BASE_PATH_HEADER = 'X-Caco-Base-Path';
const BASE_RE = /^\/peer\/[A-Za-z0-9_-]{1,200}\/$/;

/** The validated base path from the header value, or `/`. */
export function pageBasePath(header: string | string[] | undefined): string {
  const v = Array.isArray(header) ? header[0] : header;
  return typeof v === 'string' && BASE_RE.test(v) ? v : '/';
}

/**
 * Plain-JS fetch wrapper, run inline before any other script. Idempotent: a path
 * already under the base is left alone. A rewritten `Request` keeps its method,
 * headers, body, credentials and signal (`new Request(url, request)`).
 */
export const FETCH_WRAPPER_JS = `(function(){var B=window.CACO_BASE,f=window.fetch;if(!B||B==='/'||!f||f.__cacoBase)return;
function fix(u){try{var x=new URL(u,location.href);if(x.origin!==location.origin)return null;if(x.pathname.indexOf(B)===0)return null;return B+x.pathname.slice(1)+x.search+x.hash;}catch(e){return null;}}
function abs(s){return typeof s==='string'&&s.charAt(0)==='/'&&s.charAt(1)!=='/';}
var w=function(input,init){
if(typeof input==='string'){if(abs(input)){var a=fix(input);if(a)input=a;}}
else if(input instanceof URL){var b=fix(input.href);if(b)input=b;}
else if(typeof Request!=='undefined'&&input instanceof Request){var c=fix(input.url);if(c)input=new Request(c,input);}
return f.call(this,input,init);};
w.__cacoBase=true;window.fetch=w;})();`;

/** Inject the base tag, `CACO_BASE` and the fetch wrapper first in `<head>`.
 *  Returns the HTML unchanged for base `/`. */
export function injectPageBase(html: string, base: string): string {
  if (base === '/') return html;
  const json = JSON.stringify(base).replace(/</g, '\\u003c');
  const head = `<base href="${base}"><script>window.CACO_BASE=${json};${FETCH_WRAPPER_JS}</script>`;
  return html.replace(/<head>/i, m => m + head);
}
