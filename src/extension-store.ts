/**
 * Extension Store
 *
 * File-based discovery for extensions in two directories:
 *   .caco/extensions/<slug>/   (server-local, higher priority)
 *   ~/.caco/extensions/<slug>/ (user-global, lower priority)
 *
 * Each extension has a manifest.json:
 *   { name, description?, provides: ("css"|"client"|"server")[] }
 *
 * Server-local overrides user-global on slug collision.
 */

import { readFile, readdir, stat } from 'fs/promises';
import { watch, type FSWatcher } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface ExtensionManifest {
  name: string;
  description?: string;
  provides: ('css' | 'client' | 'server')[];
}

export interface ExtensionInfo {
  slug: string;
  name: string;
  description?: string;
  provides: ('css' | 'client' | 'server')[];
  dir: string;
}

const USER_EXT_DIR = join(homedir(), '.caco', 'extensions');

function getServerExtDir(): string {
  return join(process.cwd(), '.caco', 'extensions');
}

async function scanDir(dir: string): Promise<ExtensionInfo[]> {
  const results: ExtensionInfo[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return results;
  }

  for (const slug of entries) {
    const extDir = join(dir, slug);
    try {
      const s = await stat(extDir);
      if (!s.isDirectory()) continue;

      const raw = await readFile(join(extDir, 'manifest.json'), 'utf-8');
      const manifest: ExtensionManifest = JSON.parse(raw);
      if (!manifest.name || !Array.isArray(manifest.provides)) {
        console.warn(`[EXT] Skipping ${slug}: invalid manifest`);
        continue;
      }
      results.push({
        slug,
        name: manifest.name,
        description: manifest.description,
        provides: manifest.provides,
        dir: extDir,
      });
    } catch {
      continue;
    }
  }
  return results;
}

export async function listExtensions(): Promise<ExtensionInfo[]> {
  const [userExts, projectExts] = await Promise.all([
    scanDir(USER_EXT_DIR),
    scanDir(getServerExtDir()),
  ]);

  const bySlug = new Map<string, ExtensionInfo>();
  for (const ext of userExts) bySlug.set(ext.slug, ext);
  for (const ext of projectExts) bySlug.set(ext.slug, ext);

  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function getExtension(slug: string): Promise<ExtensionInfo | null> {
  const all = await listExtensions();
  return all.find(e => e.slug === slug) ?? null;
}

type ChangeType = 'css' | 'client' | 'server';
type ChangeHandler = (slug: string, type: ChangeType) => void;

export interface ExtensionWatch {
  close(): void;
}

export function watchExtensions(onChange: ChangeHandler): ExtensionWatch {
  const watchers: FSWatcher[] = [];

  for (const dir of [USER_EXT_DIR, getServerExtDir()]) {
    try {
      const watcher = watch(dir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const parts = filename.split(/[/\\]/);
        if (parts.length < 2) return;
        const slug = parts[0];
        const file = parts[parts.length - 1];
        let type: ChangeType | null = null;
        if (file === 'style.css') type = 'css';
        else if (file === 'client.ts') type = 'client';
        else if (file === 'server.ts') type = 'server';
        if (type) onChange(slug, type);
      });
      watchers.push(watcher);
    } catch {
      // dir doesn't exist, skip
    }
  }

  return {
    close() {
      for (const watcher of watchers) {
        try { watcher.close(); } catch { /* already closed */ }
      }
      watchers.length = 0;
    },
  };
}
