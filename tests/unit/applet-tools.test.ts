import { describe, it, expect } from 'vitest';
import { formatAppletUsage } from '../../src/applet-tools.js';
import type { AppletMeta } from '../../src/applet-store.js';

type TestInput = Omit<AppletMeta, 'createdAt' | 'updatedAt'>;

function testFormat(applet: TestInput): string {
  return formatAppletUsage({ ...applet, paths: {}, createdAt: '', updatedAt: '' });
}

describe('formatAppletUsage', () => {
  it('formats applet with required params', () => {
    const applet = {
      slug: 'text-editor',
      name: 'Text Editor',
      description: 'Edit text files',
      params: {
        path: { required: true, description: 'Absolute path to file' }
      }
    };

    const result = testFormat(applet);

    expect(result).toContain('## text-editor');
    expect(result).toContain('Edit text files');
    expect(result).toContain('/?applet=text-editor&path=<path>');
    expect(result).toContain('Required: path - Absolute path to file');
  });

  it('uses agentUsage.purpose over description', () => {
    const applet = {
      slug: 'git-status',
      name: 'Git Status',
      description: 'View git status',
      agentUsage: { purpose: 'Show git repository status with staging controls' },
      params: { path: { required: true, description: 'Repo path' } }
    };

    const result = testFormat(applet);

    expect(result).toContain('Show git repository status with staging controls');
    expect(result).not.toContain('View git status');
  });

  it('handles optional params', () => {
    const applet = {
      slug: 'git-diff',
      name: 'Git Diff',
      description: 'View diffs',
      params: {
        path: { required: true, description: 'Repo path' },
        staged: { required: false, description: 'Show staged diff' }
      }
    };

    const result = testFormat(applet);

    expect(result).toContain('Required: path - Repo path');
    expect(result).toContain('Optional: staged - Show staged diff');
  });

  it('handles applet with no params', () => {
    const applet = {
      slug: 'calculator',
      name: 'Calculator',
      description: 'Perform calculations'
    };

    const result = testFormat(applet);

    expect(result).toContain('## calculator');
    expect(result).toContain('/?applet=calculator');
    expect(result).not.toContain('Required:');
    expect(result).not.toContain('Optional:');
  });

  it('falls back to name when no description or purpose', () => {
    const applet = {
      slug: 'my-applet',
      name: 'My Applet'
    };

    const result = testFormat(applet);

    expect(result).toContain('My Applet');
  });

  it('includes stateSchema get and set keys', () => {
    const applet = {
      slug: 'text-editor',
      name: 'Text Editor',
      description: 'Edit files',
      params: { path: { required: true, description: 'File path' } },
      stateSchema: {
        get: { path: 'string', loaded: 'boolean', size: 'number' },
        set: { content: 'string - replaces content' }
      }
    };

    const result = testFormat(applet);

    expect(result).toContain('State (get_applet_state): path, loaded, size');
    expect(result).toContain('State (set_applet_state): content');
  });

  it('handles stateSchema with only get', () => {
    const applet = {
      slug: 'image-viewer',
      name: 'Image Viewer',
      description: 'View images',
      stateSchema: {
        get: { imagePath: 'string', loaded: 'boolean' },
        set: null
      }
    };

    const result = testFormat(applet);

    expect(result).toContain('State (get_applet_state): imagePath, loaded');
    expect(result).not.toContain('set_applet_state');
  });
});

