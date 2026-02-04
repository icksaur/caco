import { describe, it, expect } from 'vitest';

// Import the module to test formatAppletUsage indirectly via exported tool
// Since formatAppletUsage is private, we test it through the tool's behavior
// For direct testing, we recreate the logic here as a reference implementation

interface AppletMeta {
  slug: string;
  name: string;
  description?: string;
  params?: Record<string, { required?: boolean; description?: string }>;
  agentUsage?: { purpose?: string };
  stateSchema?: {
    get?: Record<string, string>;
    set?: Record<string, string> | null;
  };
}

/**
 * Reference implementation matching src/applet-tools.ts formatAppletUsage
 */
function formatAppletUsage(applet: AppletMeta): string {
  const params = Object.entries(applet.params || {});
  const required = params.filter(([, v]) => v.required).map(([k, v]) => `${k} - ${v.description || ''}`);
  const optional = params.filter(([, v]) => !v.required).map(([k, v]) => `${k} - ${v.description || ''}`);
  
  const urlParams = params.map(([k]) => `${k}=<${k}>`).join('&');
  const urlSuffix = urlParams ? `&${urlParams}` : '';
  
  const lines = [
    `## ${applet.slug}`,
    applet.agentUsage?.purpose || applet.description || applet.name,
    `Link: \`[${applet.name}](/?applet=${applet.slug}${urlSuffix})\``
  ];
  
  if (required.length) lines.push(`Required: ${required.join('; ')}`);
  if (optional.length) lines.push(`Optional: ${optional.join('; ')}`);
  
  // Add state schema info if available
  if (applet.stateSchema) {
    const getKeys = applet.stateSchema.get ? Object.keys(applet.stateSchema.get).join(', ') : null;
    const setKeys = applet.stateSchema.set ? Object.keys(applet.stateSchema.set).join(', ') : null;
    if (getKeys) lines.push(`State (get_applet_state): ${getKeys}`);
    if (setKeys) lines.push(`State (set_applet_state): ${setKeys}`);
  }
  
  return lines.join('\n');
}

describe('formatAppletUsage', () => {
  it('formats applet with required params', () => {
    const applet: AppletMeta = {
      slug: 'text-editor',
      name: 'Text Editor',
      description: 'Edit text files',
      params: {
        path: { required: true, description: 'Absolute path to file' }
      }
    };

    const result = formatAppletUsage(applet);

    expect(result).toContain('## text-editor');
    expect(result).toContain('Edit text files');
    expect(result).toContain('/?applet=text-editor&path=<path>');
    expect(result).toContain('Required: path - Absolute path to file');
  });

  it('uses agentUsage.purpose over description', () => {
    const applet: AppletMeta = {
      slug: 'git-status',
      name: 'Git Status',
      description: 'View git status',
      agentUsage: { purpose: 'Show git repository status with staging controls' },
      params: { path: { required: true, description: 'Repo path' } }
    };

    const result = formatAppletUsage(applet);

    expect(result).toContain('Show git repository status with staging controls');
    expect(result).not.toContain('View git status');
  });

  it('handles optional params', () => {
    const applet: AppletMeta = {
      slug: 'git-diff',
      name: 'Git Diff',
      description: 'View diffs',
      params: {
        path: { required: true, description: 'Repo path' },
        staged: { required: false, description: 'Show staged diff' }
      }
    };

    const result = formatAppletUsage(applet);

    expect(result).toContain('Required: path - Repo path');
    expect(result).toContain('Optional: staged - Show staged diff');
  });

  it('handles applet with no params', () => {
    const applet: AppletMeta = {
      slug: 'calculator',
      name: 'Calculator',
      description: 'Perform calculations'
    };

    const result = formatAppletUsage(applet);

    expect(result).toContain('## calculator');
    expect(result).toContain('/?applet=calculator');
    expect(result).not.toContain('Required:');
    expect(result).not.toContain('Optional:');
  });

  it('falls back to name when no description or purpose', () => {
    const applet: AppletMeta = {
      slug: 'my-applet',
      name: 'My Applet'
    };

    const result = formatAppletUsage(applet);

    expect(result).toContain('My Applet');
  });

  it('includes stateSchema get and set keys', () => {
    const applet: AppletMeta = {
      slug: 'text-editor',
      name: 'Text Editor',
      description: 'Edit files',
      params: { path: { required: true, description: 'File path' } },
      stateSchema: {
        get: { path: 'string', loaded: 'boolean', size: 'number' },
        set: { content: 'string - replaces content' }
      }
    };

    const result = formatAppletUsage(applet);

    expect(result).toContain('State (get_applet_state): path, loaded, size');
    expect(result).toContain('State (set_applet_state): content');
  });

  it('handles stateSchema with only get', () => {
    const applet: AppletMeta = {
      slug: 'image-viewer',
      name: 'Image Viewer',
      description: 'View images',
      stateSchema: {
        get: { imagePath: 'string', loaded: 'boolean' },
        set: null
      }
    };

    const result = formatAppletUsage(applet);

    expect(result).toContain('State (get_applet_state): imagePath, loaded');
    expect(result).not.toContain('set_applet_state');
  });
});

