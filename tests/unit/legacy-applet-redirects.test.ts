import { describe, it, expect } from 'vitest';
import { legacyAppletRedirectTarget } from '../../src/legacy-applet-redirects.js';

function p(s: string) { return new URLSearchParams(s); }

describe('legacyAppletRedirectTarget', () => {
  it('markdown-viewer + path → files + openPath, drops path', () => {
    const out = legacyAppletRedirectTarget('markdown-viewer', p('path=/x.md'));
    expect(out).not.toBeNull();
    expect(out!.get('applet')).toBe('files');
    expect(out!.get('openPath')).toBe('/x.md');
    expect(out!.has('path')).toBe(false);
  });

  it('image-viewer + path → files + openPath', () => {
    const out = legacyAppletRedirectTarget('image-viewer', p('path=/img.png'));
    expect(out).not.toBeNull();
    expect(out!.get('applet')).toBe('files');
    expect(out!.get('openPath')).toBe('/img.png');
    expect(out!.has('path')).toBe(false);
  });

  it('html-viewer + path → files + openPath', () => {
    const out = legacyAppletRedirectTarget('html-viewer', p('path=/page.html'));
    expect(out).not.toBeNull();
    expect(out!.get('applet')).toBe('files');
    expect(out!.get('openPath')).toBe('/page.html');
  });

  it('markdown-viewer with no path → null', () => {
    expect(legacyAppletRedirectTarget('markdown-viewer', p(''))).toBeNull();
  });

  it('file-finder + root → files + openFinder + openFinderRoot, drops root', () => {
    const out = legacyAppletRedirectTarget('file-finder', p('root=/abs/dir'));
    expect(out).not.toBeNull();
    expect(out!.get('applet')).toBe('files');
    expect(out!.get('openFinder')).toBe('1');
    expect(out!.get('openFinderRoot')).toBe('/abs/dir');
    expect(out!.has('root')).toBe(false);
  });

  it('file-finder with no root → files only (no openFinder)', () => {
    const out = legacyAppletRedirectTarget('file-finder', p(''));
    expect(out).not.toBeNull();
    expect(out!.get('applet')).toBe('files');
    expect(out!.has('openFinder')).toBe(false);
    expect(out!.has('openFinderRoot')).toBe(false);
  });

  it('git-diff + file → files + openPath + diffMode=unstaged, drops file', () => {
    const out = legacyAppletRedirectTarget('git-diff', p('file=/abs/x'));
    expect(out).not.toBeNull();
    expect(out!.get('applet')).toBe('files');
    expect(out!.get('openPath')).toBe('/abs/x');
    expect(out!.get('diffMode')).toBe('unstaged');
    expect(out!.has('file')).toBe(false);
  });

  it('git-diff + file + staged=1 → files + openPath + diffMode=staged, drops file+staged', () => {
    const out = legacyAppletRedirectTarget('git-diff', p('file=/abs/x&staged=1'));
    expect(out).not.toBeNull();
    expect(out!.get('diffMode')).toBe('staged');
    expect(out!.has('staged')).toBe(false);
    expect(out!.has('file')).toBe(false);
  });

  it('git-diff + ref (no file) → git-status, drops ref', () => {
    const out = legacyAppletRedirectTarget('git-diff', p('ref=HEAD~1'));
    expect(out).not.toBeNull();
    expect(out!.get('applet')).toBe('git-status');
    expect(out!.has('ref')).toBe(false);
  });

  it('git-diff + ref + path → git-status, preserves path', () => {
    const out = legacyAppletRedirectTarget('git-diff', p('ref=HEAD~1&path=/repo'));
    expect(out).not.toBeNull();
    expect(out!.get('applet')).toBe('git-status');
    expect(out!.get('path')).toBe('/repo');
    expect(out!.has('ref')).toBe(false);
  });

  it('git-diff with neither file nor ref → null', () => {
    expect(legacyAppletRedirectTarget('git-diff', p(''))).toBeNull();
  });

  it('unknown params are preserved', () => {
    const out = legacyAppletRedirectTarget('markdown-viewer', p('path=/x.md&line=42&foo=bar'));
    expect(out).not.toBeNull();
    expect(out!.get('line')).toBe('42');
    expect(out!.get('foo')).toBe('bar');
  });

  it('non-legacy slug → null', () => {
    expect(legacyAppletRedirectTarget('calculator', p('x=1'))).toBeNull();
  });

  it('applet=files slug → null (no redirect loop)', () => {
    expect(legacyAppletRedirectTarget('files', p('openPath=/x.md'))).toBeNull();
  });
});
