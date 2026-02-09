/**
 * Applet Store
 * 
 * File-based storage for persisted applets.
 * 
 * Two applet directories:
 *   ~/.caco/applets/<slug>/        # User applets (read/write, takes priority)
 *   <project>/applets/<slug>/      # Bundled applets (read-only fallback)
 * 
 * File structure per applet:
 *     ├── meta.json       # { name, description, created, updated }
 *     ├── content.html    # HTML content
 *     ├── script.js       # JavaScript (optional)
 *     └── style.css       # CSS (optional)
 * 
 * Design decisions:
 * - Separate files for easy agent inspection with standard file tools
 * - Agent can read/edit files directly before calling load_applet
 * - No index.json - we scan directories to list applets
 * - User dir wins on slug collision (user can override bundled applets)
 * - Writes always go to user dir (~/.caco/applets)
 * - Deletes only affect user dir (can't delete bundled applets)
 */

import { mkdir, readFile, writeFile, readdir, rm, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

/** User applets — read/write */
const USER_APPLET_DIR = join(homedir(), '.caco', 'applets');

/** Bundled applets — read-only fallback */
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLED_APPLET_DIR = join(PROJECT_ROOT, 'applets');

export interface AppletMeta {
  slug: string;
  name: string;
  description?: string;
  params?: Record<string, { required?: boolean; description?: string }>;
  agentUsage?: {
    purpose?: string;
    example?: string;
  };
  stateSchema?: {
    get?: Record<string, string>;
    set?: Record<string, string> | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface StoredApplet {
  meta: AppletMeta;
  html: string;
  js?: string;
  css?: string;
}

export interface AppletFilePaths {
  root: string;
  meta: string;
  html: string;
  js: string;
  css: string;
}

/**
 * Get the user applets directory (~/.caco/applets) — write target
 */
function getUserAppletsDir(): string {
  return USER_APPLET_DIR;
}

/**
 * Build file paths for an applet in a given base directory
 */
function buildPaths(baseDir: string, slug: string): AppletFilePaths {
  const root = join(baseDir, slug);
  return {
    root,
    meta: join(root, 'meta.json'),
    html: join(root, 'content.html'),
    js: join(root, 'script.js'),
    css: join(root, 'style.css')
  };
}

/**
 * Get file paths for an applet (user dir — for writes)
 */
export function getAppletPaths(slug: string): AppletFilePaths {
  return buildPaths(getUserAppletsDir(), slug);
}

/**
 * Resolve where an applet lives: user dir first, then bundled.
 * Returns null if not found in either location.
 */
async function resolveAppletDir(slug: string): Promise<AppletFilePaths | null> {
  const userPaths = buildPaths(USER_APPLET_DIR, slug);
  try {
    await stat(userPaths.meta);
    return userPaths;
  } catch { /* not in user dir */ }

  const bundledPaths = buildPaths(BUNDLED_APPLET_DIR, slug);
  try {
    await stat(bundledPaths.meta);
    return bundledPaths;
  } catch { /* not in bundled dir either */ }

  return null;
}

/**
 * Validate slug (URL-safe identifier)
 */
function validateSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(slug)) {
    throw new Error(`Invalid slug "${slug}". Use lowercase letters, numbers, and hyphens. Must start and end with alphanumeric.`);
  }
  if (slug.length > 64) {
    throw new Error(`Slug "${slug}" too long. Maximum 64 characters.`);
  }
}

/**
 * Save an applet to disk
 */
export async function saveApplet(
  slug: string,
  name: string,
  html: string,
  js?: string,
  css?: string,
  description?: string
): Promise<AppletFilePaths> {
  validateSlug(slug);
  
  const paths = getAppletPaths(slug);
  
  // Check if exists (for created vs updated timestamp)
  let existingMeta: AppletMeta | null = null;
  try {
    const metaContent = await readFile(paths.meta, 'utf-8');
    existingMeta = JSON.parse(metaContent);
  } catch {
    // New applet
  }
  
  // Create directory
  await mkdir(paths.root, { recursive: true });
  
  // Write meta
  const now = new Date().toISOString();
  const meta: AppletMeta = {
    slug,
    name,
    description,
    createdAt: existingMeta?.createdAt || now,
    updatedAt: now
  };
  await writeFile(paths.meta, JSON.stringify(meta, null, 2));
  
  // Write content files
  await writeFile(paths.html, html);
  
  if (js) {
    await writeFile(paths.js, js);
  }
  
  if (css) {
    await writeFile(paths.css, css);
  }
  
  console.log(`[APPLET-STORE] Saved applet "${slug}" to ${paths.root}`);
  
  return paths;
}

/**
 * Load an applet from disk
 */
export async function loadApplet(
  slug: string
): Promise<StoredApplet | null> {
  validateSlug(slug);
  
  const paths = await resolveAppletDir(slug);
  if (!paths) {
    console.log(`[APPLET-STORE] Applet "${slug}" not found`);
    return null;
  }
  
  try {
    // Read meta (required)
    const metaContent = await readFile(paths.meta, 'utf-8');
    const meta: AppletMeta = JSON.parse(metaContent);
    
    // Read HTML (required)
    const html = await readFile(paths.html, 'utf-8');
    
    // Read optional files
    let js: string | undefined;
    let css: string | undefined;
    
    try {
      js = await readFile(paths.js, 'utf-8');
    } catch {
      // No JS file
    }
    
    try {
      css = await readFile(paths.css, 'utf-8');
    } catch {
      // No CSS file
    }
    
    console.log(`[APPLET-STORE] Loaded applet "${slug}" from ${paths.root}`);
    
    return { meta, html, js, css };
  } catch (_error) {
    console.log(`[APPLET-STORE] Applet "${slug}" not found`);
    return null;
  }
}

/**
 * List all saved applets from both user and bundled directories.
 * User dir wins on slug collision.
 */
export async function listApplets(): Promise<Array<AppletMeta & { paths: AppletFilePaths }>> {
  const applets = new Map<string, AppletMeta & { paths: AppletFilePaths }>();

  // Scan bundled first, then user — user overwrites on collision
  for (const dir of [BUNDLED_APPLET_DIR, USER_APPLET_DIR]) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

        const paths = buildPaths(dir, entry.name);
        try {
          const metaContent = await readFile(paths.meta, 'utf-8');
          const meta: AppletMeta = JSON.parse(metaContent);
          applets.set(entry.name, { ...meta, paths });
        } catch {
          // Skip directories without valid meta.json
        }
      }
    } catch {
      // Directory doesn't exist — skip
    }
  }
    
  const result = [...applets.values()];
  result.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return result;
}

/**
 * Delete an applet
 */
export async function deleteApplet(
  slug: string
): Promise<boolean> {
  validateSlug(slug);
  
  const paths = getAppletPaths(slug);
  
  try {
    await rm(paths.root, { recursive: true });
    console.log(`[APPLET-STORE] Deleted applet "${slug}"`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if an applet exists
 */
export async function appletExists(
  slug: string
): Promise<boolean> {
  try {
    validateSlug(slug);
    return (await resolveAppletDir(slug)) !== null;
  } catch {
    return false;
  }
}

/**
 * Get applet slugs for system prompt injection
 * @deprecated Use buildSystemMessage() from prompts.ts instead
 */
export async function getAppletSlugsForPrompt(): Promise<string> {
  try {
    const applets = await listApplets();
    if (applets.length === 0) {
      return '';
    }
    const slugs = applets.map(a => a.slug).join(', ');
    return `Available applets: ${slugs}. Use list_applets tool for URL params and details.`;
  } catch {
    return '';
  }
}
