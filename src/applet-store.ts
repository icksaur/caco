/**
 * Applet Store
 * 
 * File-based storage for persisted applets.
 * 
 * Storage structure:
 *   ~/.caco/applets/<slug>/
 *     ├── meta.json       # { name, description, created, updated }
 *     ├── content.html    # HTML content
 *     ├── script.js       # JavaScript (optional)
 *     └── style.css       # CSS (optional)
 * 
 * Design decisions:
 * - Separate files for easy agent inspection with standard file tools
 * - Agent can read/edit files directly before calling load_applet
 * - No index.json - we scan directories to list applets
 */

import { mkdir, readFile, writeFile, readdir, rm, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const APPLET_DIR = join(homedir(), '.caco', 'applets');

export interface AppletMeta {
  slug: string;
  name: string;
  description?: string;
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
 * Get the applets directory (global ~/.caco/applets)
 */
function getAppletsDir(): string {
  return APPLET_DIR;
}

/**
 * Get file paths for an applet
 */
export function getAppletPaths(slug: string): AppletFilePaths {
  const root = join(getAppletsDir(), slug);
  return {
    root,
    meta: join(root, 'meta.json'),
    html: join(root, 'content.html'),
    js: join(root, 'script.js'),
    css: join(root, 'style.css')
  };
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
  
  const paths = getAppletPaths(slug);
  
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
  } catch (error) {
    console.log(`[APPLET-STORE] Applet "${slug}" not found`);
    return null;
  }
}

/**
 * List all saved applets
 */
export async function listApplets(): Promise<Array<AppletMeta & { paths: AppletFilePaths }>> {
  const appletsDir = getAppletsDir();
  
  try {
    const entries = await readdir(appletsDir, { withFileTypes: true });
    const applets: Array<AppletMeta & { paths: AppletFilePaths }> = [];
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      
      const paths = getAppletPaths(entry.name);
      
      try {
        const metaContent = await readFile(paths.meta, 'utf-8');
        const meta: AppletMeta = JSON.parse(metaContent);
        applets.push({ ...meta, paths });
      } catch {
        // Skip directories without valid meta.json
      }
    }
    
    // Sort by updated time, newest first
    applets.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    
    return applets;
  } catch {
    // Directory doesn't exist yet
    return [];
  }
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
    const paths = getAppletPaths(slug);
    await stat(paths.meta);
    return true;
  } catch {
    return false;
  }
}
