import type { SessionData } from './types.js';

export interface FolderGroup {
  name: string;
  sessions: SessionData[];
  collapsed: boolean;
  hasBusy: boolean;
  hasUnobserved: boolean;
}

export interface SessionListModel {
  root: SessionData[];
  folders: FolderGroup[];
}

function mruComparator(orderMap: Map<string, number>) {
  const NOT_IN_SNAPSHOT = -1;
  return (a: SessionData, b: SessionData): number => {
    if (a.isUnobserved !== b.isUnobserved) return a.isUnobserved ? -1 : 1;
    const aIdx = orderMap.get(a.sessionId) ?? NOT_IN_SNAPSHOT;
    const bIdx = orderMap.get(b.sessionId) ?? NOT_IN_SNAPSHOT;
    if (aIdx === NOT_IN_SNAPSHOT && bIdx === NOT_IN_SNAPSHOT) return 0;
    if (aIdx === NOT_IN_SNAPSHOT) return -1;
    if (bIdx === NOT_IN_SNAPSHOT) return 1;
    return aIdx - bIdx;
  };
}

export function buildSessionListModel(
  sessions: SessionData[],
  sessionOrder: string[],
  collapsedFolders: Set<string>
): SessionListModel {
  const rootSessions: SessionData[] = [];
  const folderMap = new Map<string, SessionData[]>();

  for (const s of sessions) {
    const folder = s.folder;
    if (folder) {
      let list = folderMap.get(folder);
      if (!list) { list = []; folderMap.set(folder, list); }
      list.push(s);
    } else {
      rootSessions.push(s);
    }
  }

  const orderMap = new Map(sessionOrder.map((id, i) => [id, i]));
  const cmp = mruComparator(orderMap);

  rootSessions.sort(cmp);

  const folders: FolderGroup[] = [];
  const sortedNames = [...folderMap.keys()].sort((a, b) => a.localeCompare(b));

  for (const name of sortedNames) {
    const folderSessions = folderMap.get(name)!;
    folderSessions.sort(cmp);
    folders.push({
      name,
      sessions: folderSessions,
      collapsed: collapsedFolders.has(name),
      hasBusy: folderSessions.some(s => s.isBusy),
      hasUnobserved: folderSessions.some(s => s.isUnobserved),
    });
  }

  return { root: rootSessions, folders };
}
