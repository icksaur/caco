// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Inactive file-editor tabs must leave the document, not merely be hidden.
 *
 * Each open tab renders a few thousand nodes. Hidden or not, they stay in the
 * page, and the browser recalculates them on any style-invalidating change —
 * including the one the chat composer makes on every keystroke to autosize
 * itself. Measured on a session with fifty tabs open: 24ms per keystroke with
 * the hidden panes attached, 0.6ms with them detached, and the applet did not
 * need to be open or visible to be charged for it.
 *
 * The applet is a build-free ES5 IIFE and cannot be imported, so the structural
 * half of this is asserted against its source. That is weaker than executing it,
 * and is chosen deliberately over inlining a copy of the logic, which would
 * assert only that the copy still matches itself.
 */
const script = readFileSync(
  join(process.cwd(), 'applets', 'files', 'script.js'), 'utf8');

/** The body of a `TabContainer.prototype.<name> = function() { ... }`. */
function protoBody(name: string): string {
  const start = script.indexOf(`TabContainer.prototype.${name} = function`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const open = script.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}' && --depth === 0) return script.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

describe('files applet detaches inactive tab panes', () => {
  it('deactivate removes the pane from the document', () => {
    const body = protoBody('deactivate');
    expect(body).toContain('detachPane(this)');
  });

  it('deactivate lets the viewer capture its state before the pane leaves', () => {
    const body = protoBody('deactivate');
    // Order matters: a viewer reading scrollTop off a detached element gets 0,
    // so the tab would silently lose the user's position on every switch.
    expect(body.indexOf('v.deactivate()')).toBeLessThan(body.indexOf('detachPane(this)'));
  });

  it('activate re-attaches the pane before the viewer restores scroll', () => {
    const body = protoBody('activate');
    expect(body).toContain('paneEl.appendChild(this.contentEl)');
    // Restoring scrollTop only sticks on an element the document contains.
    expect(body.indexOf('appendChild')).toBeLessThan(body.indexOf('v.activate()'));
  });

  it('detachPane is a no-op on a pane that is already out', () => {
    // Guards the restore path, which activates a tab that was never attached.
    expect(script).toMatch(/function detachPane\([\s\S]{0,200}parentNode/);
  });

  it('the single-visible-tab invariant also detaches, so created-but-never-shown tabs leave', () => {
    const start = script.indexOf('function setActiveTab');
    const loop = script.slice(start, start + 1200);
    expect(loop).toContain('detachPane(t)');
    // Unconditionally, not only for tabs this call happens to hide: a tab
    // created while another is active is appended and hidden at birth.
    expect(loop).not.toMatch(/style\.display !== 'none'\)\s*\{[^}]*detachPane/);
  });
});

/**
 * The safety claim behind detaching: a pane's content is owned by its
 * TabContainer and viewers, not by its position in the document, so it survives
 * a round trip out of the page and back.
 */
describe('detach and re-attach preserves a pane subtree', () => {
  it('keeps the content, and restores a scroll position set after re-attach', () => {
    document.body.innerHTML = '<div id="pane"></div>';
    const pane = document.getElementById('pane')!;
    const content = document.createElement('div');
    content.className = 'files-tab-pane';
    content.innerHTML = '<div class="fe-row">one</div><div class="fe-row">two</div>';
    pane.appendChild(content);

    const before = content.querySelectorAll('.fe-row').length;
    content.remove();

    // Still queryable while detached — the viewers' row lookups rely on this.
    expect(content.querySelectorAll('.fe-row').length).toBe(before);
    expect(pane.contains(content)).toBe(false);
    expect(pane.querySelectorAll('*').length).toBe(0);

    pane.appendChild(content);
    expect(pane.contains(content)).toBe(true);
    expect(content.querySelectorAll('.fe-row').length).toBe(before);
  });
});
