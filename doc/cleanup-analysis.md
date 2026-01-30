# Cleanup Analysis

## Current State

### Storage Locations

**~/.caco/** (Caco-managed)
```
~/.caco/
├── sessions/           # 7 session dirs, 22 files, ~148KB
│   └── <sessionId>/
│       └── outputs/    # Display tool outputs
├── applets/            # 6 applets, ~132KB
├── schedule/           # Not yet created
├── tmp/                # Not yet created (tmpfile endpoint)
└── usage.json          # 4KB - token usage tracking
```

**~/.copilot/** (SDK-managed)
```
~/.copilot/
├── session-state/      # 107 sessions, ~2.8MB
│   └── <sessionId>/
│       └── workspace.yaml
└── web-preferences.json
```

### Cleanup Issues Found

#### 1. **Orphaned SDK Sessions** ❌
- SDK has 107 sessions in `~/.copilot/session-state/`
- Caco has only 7 sessions with output directories
- **Gap: 100 SDK sessions with no Caco metadata**
- These persist indefinitely (SDK doesn't auto-cleanup)

#### 2. **Display Tool Outputs** ⚠️
- Stored in `~/.caco/sessions/<sessionId>/outputs/`
- Currently 22 output files (~148KB)
- **Cleanup function exists but not called**: `pruneOutputs(maxAgeDays)` in storage.ts
- In-memory cache auto-expires after 30 minutes
- Disk files never cleaned up

#### 3. **Temporary Files** ⚠️
- Target: `~/.caco/tmp/` (currently doesn't exist)
- Created by POST /api/tmpfile endpoint
- Used by `saveTempFile()` applet API
- **No cleanup implemented**

#### 4. **Schedule Data** ✅
- Target: `~/.caco/schedule/<slug>/`
- Has explicit DELETE endpoint
- Currently no schedules created
- Manual cleanup via API works

#### 5. **Applets** ✅
- 6 applets in `~/.caco/applets/` (~132KB)
- Has `deleteApplet()` function
- No auto-cleanup (intentional - user-managed)

## SDK Behavior

Per [session-management.md](session-management.md#local-session-cache):
- **No automatic cleanup**: Old sessions stay until explicitly deleted
- Sessions persist indefinitely
- CLI manages persistence, but doesn't delete
- Must call `deleteSession()` explicitly or `rm -rf ~/.copilot/session-state/{sessionId}`

## Cleanup Gaps

### High Priority

1. **Orphaned SDK Sessions**
   - 100+ SDK sessions with no associated Caco data
   - Consuming 2.8MB (not huge, but growing)
   - User has no visibility into these from UI
   - Recommendation: Add cleanup job to prune SDK sessions older than N days

2. **Display Outputs Not Pruned**
   - Function exists: `pruneOutputs(maxAgeDays)` (storage.ts:272)
   - Never called
   - Files accumulate forever
   - Recommendation: Run on server startup or periodic interval

3. **Temp Files Never Cleaned**
   - `/api/tmpfile` creates files in `~/.caco/tmp/`
   - No expiration or cleanup
   - Recommendation: Add cleanup on server start (delete all) or TTL-based

### Medium Priority

4. **Session Output Dirs Created Without Outputs**
   - 7 session dirs in `.caco/sessions/`
   - Some may be empty if no display tools used
   - Minor disk usage
   - Recommendation: Clean up empty output dirs when pruning

5. **Correlation Metrics Memory Cleanup**
   - Has expiry check: `correlations.isExpired()` in session-manager.ts:572
   - Cleaned on access, not proactively
   - Memory leak risk if correlations never checked again
   - Recommendation: Periodic sweep or limits

### Low Priority

6. **In-Memory Cache Growth**
   - `outputCache` Map in storage.ts
   - Auto-expires entries after 30min via setTimeout
   - Works well for normal use
   - Risk: High output volume could grow map before TTL
   - Recommendation: Add size limit or more aggressive cleanup

## Recommendations

### Immediate Actions

1. **Add cleanup job on server startup**
   ```typescript
   // server.ts
   import { pruneOutputs } from './storage.js';
   
   // On startup
   const pruned = pruneOutputs(30); // 30 days
   console.log(`[CLEANUP] Pruned ${pruned} old outputs`);
   ```

2. **Add tmp directory cleanup**
   ```typescript
   // Clean ~/.caco/tmp on startup (all temp files)
   const tmpDir = join(homedir(), '.caco', 'tmp');
   if (existsSync(tmpDir)) {
     rmSync(tmpDir, { recursive: true, force: true });
     console.log('[CLEANUP] Cleared tmp directory');
   }
   ```

3. **Add SDK session pruning**
   ```typescript
   // Prune SDK sessions older than 90 days
   async function pruneSdkSessions(maxAgeDays: number) {
     const sessionStateDir = join(homedir(), '.copilot', 'session-state');
     // Check workspace.yaml mtime, delete old sessions
   }
   ```

### Optional Enhancements

4. **Periodic cleanup**
   - Run pruneOutputs() daily or weekly
   - Use setInterval or cron-style scheduler
   
5. **User-initiated cleanup**
   - Add "Clear old data" button in UI
   - Show disk usage stats
   
6. **Cleanup on session delete**
   - When deleting session via UI, also:
     - Delete SDK session via `client.deleteSession()`
     - Delete output directory `~/.caco/sessions/<id>/`
     - Currently only deletes SDK session

## Implementation Status

- ✅ `pruneOutputs()` function exists (not called)
- ✅ `deleteSchedule()` works
- ✅ `deleteApplet()` works
- ❌ Startup cleanup not implemented
- ❌ Tmp directory cleanup not implemented
- ❌ SDK session pruning not implemented
- ❌ Empty output dir cleanup not implemented
- ❌ Periodic cleanup job not implemented

## Disk Usage Summary

Current usage is minimal (~3MB total):
- SDK sessions: 2.8MB (107 sessions)
- Caco outputs: 148KB (22 files)
- Caco applets: 132KB (6 applets)
- Usage tracking: 4KB

Growth rate depends on:
- Session creation frequency
- Display tool usage (terminal/file outputs)
- Applet creation
- Temp file usage

Without cleanup, this will grow linearly with usage.
