import { describe, it, expect } from 'vitest';
import { formatSnapshot, type AxNode } from '../../src/browser-snapshot.js';

describe('formatSnapshot', () => {
  it('returns placeholder for null root', () => {
    const r = formatSnapshot(null);
    expect(r.outline).toBe('(no accessibility tree)');
    expect(r.nodeCount).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it('numbers interactive elements with stable ids', () => {
    const tree: AxNode = {
      role: 'WebArea',
      children: [
        { role: 'heading', name: 'Welcome', level: 1 },
        { role: 'button', name: 'Sign in' },
        { role: 'textbox', name: 'Email' },
      ],
    };
    const r = formatSnapshot(tree);
    expect(r.nodeCount).toBe(3);
    expect(r.outline).toContain('[1] heading "Welcome"');
    expect(r.outline).toContain('[2] button "Sign in"');
    expect(r.outline).toContain('[3] textbox "Email"');
  });

  it('drops presentational/skip roles', () => {
    const tree: AxNode = {
      role: 'WebArea',
      children: [
        { role: 'generic', children: [
          { role: 'StaticText', name: 'hello' },
          { role: 'button', name: 'Click' },
        ] },
      ],
    };
    const r = formatSnapshot(tree);
    expect(r.nodeCount).toBe(1);
    expect(r.outline).toContain('button "Click"');
    expect(r.outline).not.toContain('StaticText');
  });

  it('renders state flags', () => {
    const tree: AxNode = {
      role: 'WebArea',
      children: [
        { role: 'checkbox', name: 'Subscribe', checked: true },
        { role: 'button', name: 'Submit', disabled: true },
      ],
    };
    const r = formatSnapshot(tree);
    expect(r.outline).toContain('(checked)');
    expect(r.outline).toContain('(disabled)');
  });

  it('truncates at maxNodes and sets truncated flag', () => {
    const children: AxNode[] = Array.from({ length: 50 }, (_, i) => ({ role: 'button', name: `b${i}` }));
    const tree: AxNode = { role: 'WebArea', children };
    const r = formatSnapshot(tree, { maxNodes: 10 });
    expect(r.nodeCount).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it('caps maxNodes at 1000', () => {
    const children: AxNode[] = Array.from({ length: 1500 }, (_, i) => ({ role: 'button', name: `b${i}` }));
    const tree: AxNode = { role: 'WebArea', children };
    const r = formatSnapshot(tree, { maxNodes: 5000 });
    expect(r.nodeCount).toBe(1000);
    expect(r.truncated).toBe(true);
  });

  it('returns sensible message when no interactive nodes', () => {
    const tree: AxNode = { role: 'WebArea', children: [{ role: 'StaticText', name: 'just text' }] };
    const r = formatSnapshot(tree);
    expect(r.outline).toBe('(no interactive elements found)');
  });

  it('indents children under structural roles', () => {
    const tree: AxNode = {
      role: 'WebArea',
      children: [
        { role: 'navigation', name: 'Main', children: [
          { role: 'link', name: 'Home' },
          { role: 'link', name: 'Help' },
        ] },
      ],
    };
    const r = formatSnapshot(tree);
    const lines = r.outline.split('\n');
    expect(lines[0]).toMatch(/^\[1\] navigation/);
    expect(lines[1]).toMatch(/^ {2}\[2\] link "Home"/);
    expect(lines[2]).toMatch(/^ {2}\[3\] link "Help"/);
  });
});
