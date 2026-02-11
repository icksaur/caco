/**
 * Session State Manager
 * 
 * Single source of truth for the current session state.
 * Consolidates activeSessionId, preferences, and session lifecycle.
 */

import sessionManager from './session-manager.js';
import { loadPreferences, savePreferences, getDefaultPreferences, DEFAULT_MODEL } from './preferences.js';
import type { UserPreferences, SessionStateConfig, ResumeResult } from './types.js';

/**
 * Manages the active session state for the server.
 * Provides a unified interface for session lifecycle operations.
 * 
 * Multi-client support: Uses Map-based storage with DEFAULT_CLIENT fallback.
 * Existing code using the getters works unchanged (uses default client).
 * New code can pass clientId to scoped methods for isolation.
 */
class SessionState {
  /** Default client ID for backward compatibility */
  private static readonly DEFAULT_CLIENT = 'default';
  
  /** Per-client active session IDs */
  private _clientSessions = new Map<string, string | null>();
  
  /** Per-client pending resume IDs */
  private _clientPendingResume = new Map<string, string | null>();
  
  private _preferences: UserPreferences = getDefaultPreferences();
  private _config: SessionStateConfig | null = null;
  private _initialized = false;

  // ─────────────────────────────────────────────────────────────
  // Legacy getters (use default client for backward compatibility)
  // ─────────────────────────────────────────────────────────────

  /**
   * Get the current active session ID (default client)
   * @deprecated Use getActiveSessionId(clientId) for multi-client support
   */
  get activeSessionId(): string | null {
    return this._clientSessions.get(SessionState.DEFAULT_CLIENT) ?? null;
  }

  /**
   * Get session ID for history - active or pending resume (default client)
   * @deprecated Use getSessionIdForHistory(clientId) for multi-client support
   */
  get sessionIdForHistory(): string | null {
    return this.getSessionIdForHistory();
  }

  // ─────────────────────────────────────────────────────────────
  // Multi-client accessors
  // ─────────────────────────────────────────────────────────────

  /**
   * Get active session ID for a specific client
   */
  getActiveSessionId(clientId?: string): string | null {
    return this._clientSessions.get(clientId || SessionState.DEFAULT_CLIENT) ?? null;
  }

  /**
   * Set active session ID for a specific client
   */
  private setActiveSessionId(sessionId: string | null, clientId?: string): void {
    this._clientSessions.set(clientId || SessionState.DEFAULT_CLIENT, sessionId);
  }

  /**
   * Get pending resume ID for a specific client
   */
  private getPendingResumeId(clientId?: string): string | null {
    return this._clientPendingResume.get(clientId || SessionState.DEFAULT_CLIENT) ?? null;
  }

  /**
   * Set pending resume ID for a specific client
   */
  private setPendingResumeId(sessionId: string | null, clientId?: string): void {
    this._clientPendingResume.set(clientId || SessionState.DEFAULT_CLIENT, sessionId);
  }

  /**
   * Get session ID for history (active or pending) for a specific client
   */
  getSessionIdForHistory(clientId?: string): string | null {
    const cid = clientId || SessionState.DEFAULT_CLIENT;
    return this._clientSessions.get(cid) ?? this._clientPendingResume.get(cid) ?? null;
  }

  /**
   * Get the current preferences
   */
  get preferences(): UserPreferences {
    return this._preferences;
  }

  /**
   * Check if session state is initialized
   */
  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * Get session config for resuming sessions (toolFactory, excludedTools)
   * Used by stream route to ensure resumed sessions have tools
   */
  getSessionConfig() {
    if (!this._config) {
      throw new Error('SessionState not initialized');
    }
    return {
      toolFactory: this._config.toolFactory,
      excludedTools: this._config.excludedTools
    };
  }

  /**
   * Initialize session state - must be called before other operations
   */
  async init(config: SessionStateConfig): Promise<void> {
    if (this._initialized) return;
    
    this._config = config;
    await sessionManager.init();
    this._preferences = await loadPreferences();
    
    // Check for session to resume - but DON'T resume yet
    // We only create/resume SDK session on first message (in ensureSession)
    // This allows user to select model before first message
    if (this._preferences.lastSessionId) {
      // Check if this session exists and has messages
      if (sessionManager.hasMessages(this._preferences.lastSessionId)) {
        this.setPendingResumeId(this._preferences.lastSessionId);
        console.log(`✓ Will resume session ${this.getPendingResumeId()} on first message`);
        this._initialized = true;
        return;
      }
    }
    
    // If lastSessionId was explicitly null, wait for first message with model
    if (this._preferences.lastSessionId === null) {
      console.log('✓ No existing session - will create on first message');
      this._initialized = true;
      return;
    }
    
    // Try most recent session for cwd - but only note it, don't resume yet
    const cwd = process.cwd();
    const recentSessionId = sessionManager.getMostRecentForCwd(cwd);
    
    if (recentSessionId && sessionManager.hasMessages(recentSessionId)) {
      this.setPendingResumeId(recentSessionId);
      this._preferences.lastSessionId = recentSessionId;
      await savePreferences(this._preferences);
      console.log(`✓ Will resume session ${this.getPendingResumeId()} on first message`);
      this._initialized = true;
      return;
    }
    
    console.log('✓ No existing session - will create on first message');
    this._initialized = true;
  }

  /**
   * Ensure a session exists, creating one if needed.
   * Used for lazy session creation on first message.
   * 
   * If there's a pending resume (from init), resume that session.
   * Otherwise, create a new session with the specified model.
   * 
   * @param model - Model to use for the session
   * @param newChat - Explicitly indicates this is a new chat (clears active session)
   * @param cwd - Working directory for the session
   * @param clientId - Client identifier for multi-client support
   */
  async ensureSession(model?: string, newChat?: boolean, cwd?: string, clientId?: string): Promise<string> {
    if (!this._config) {
      throw new Error('SessionState not initialized');
    }
    
    const activeId = this.getActiveSessionId(clientId);
    
    // Explicit new chat request - just clear the active session reference
    // Don't stop the old session - it may still be running
    if (newChat && activeId) {
      console.log(`[SESSION] New chat requested - clearing active session reference (${activeId} continues running)`);
      this.setActiveSessionId(null, clientId);
    }
    
    // Also clear pending resume when new chat is requested
    if (newChat) {
      this.setPendingResumeId(null, clientId);
    }
    
    // If we have an active session, return it
    const currentActiveId = this.getActiveSessionId(clientId);
    if (currentActiveId && sessionManager.isActive(currentActiveId)) {
      console.log(`[MODEL] Reusing existing session ${currentActiveId} - requested model '${model || '(undefined)'}' is IGNORED`);
      return currentActiveId;
    }
    
    // Use provided cwd, or last preference, or process.cwd()
    const sessionCwd = cwd || this._preferences.lastCwd || process.cwd();
    const sessionConfig = {
      toolFactory: this._config.toolFactory,
      excludedTools: this._config.excludedTools
    };
    
    // If there's a pending resume, resume that session (model is already baked in)
    const pendingId = this.getPendingResumeId(clientId);
    if (pendingId) {
      try {
        const result = await sessionManager.resume(pendingId, sessionConfig);
        this.setActiveSessionId(result.sessionId, clientId);
        this._preferences.lastSessionId = result.sessionId;
        await savePreferences(this._preferences);
        console.log(`✓ Resumed pending session ${result.sessionId}`);
        this.setPendingResumeId(null, clientId); // Clear pending
        return result.sessionId;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`Could not resume pending session: ${message}`);
        this.setPendingResumeId(null, clientId); // Clear and fall through to create
      }
    }
    
    // Create new session with specified model
    const finalModel = model || DEFAULT_MODEL;
    console.log(`[MODEL] Creating SDK session with model: ${finalModel} (from param: ${model || '(undefined)'})`);
    console.log(`[CWD] Creating session with cwd: ${sessionCwd}`);
    
    const newSessionId = await sessionManager.create(sessionCwd, {
      model: finalModel,
      systemMessage: this._config.systemMessage,
      toolFactory: this._config.toolFactory,
      excludedTools: this._config.excludedTools
    });
    
    this.setActiveSessionId(newSessionId, clientId);
    this._preferences.lastSessionId = newSessionId;
    this._preferences.lastCwd = sessionCwd; // Save cwd for next time
    await savePreferences(this._preferences);
    console.log(`✓ Created session ${newSessionId} with model ${finalModel}`);
    
    return newSessionId;
  }

  /**
   * Switch to a different session
   * @param sessionId - Session to switch to
   * @param clientId - Client identifier for multi-client support
   * @returns ResumeResult with sessionId and optional fallback CWD used
   */
  async switchSession(sessionId: string, clientId?: string): Promise<ResumeResult> {
    if (!this._config) {
      throw new Error('SessionState not initialized');
    }
    
    // Don't stop current session - it may still be running
    // Just switch which session the client is viewing
    
    // Clear any pending resume - we're switching explicitly
    this.setPendingResumeId(null, clientId);
    
    // Resume new session (loads SDK client if needed, doesn't stop others)
    const result = await sessionManager.resume(sessionId, {
      toolFactory: this._config.toolFactory,
      excludedTools: this._config.excludedTools
    });
    
    this.setActiveSessionId(result.sessionId, clientId);
    this._preferences.lastSessionId = result.sessionId;
    await savePreferences(this._preferences);
    
    return result;
  }

  /**
   * Prepare for a new chat (clear session reference, set cwd)
   * Does NOT stop the current session - it may still be running
   * @param cwd - Working directory for the new chat
   * @param clientId - Client identifier for multi-client support
   */
  async prepareNewChat(cwd: string, clientId?: string): Promise<void> {
    const activeId = this.getActiveSessionId(clientId);
    if (activeId) {
      console.log(`[SESSION] Preparing new chat - clearing reference to ${activeId} (session continues running)`);
      this.setActiveSessionId(null, clientId);
    }
    
    // Clear any pending resume - user wants a fresh chat
    this.setPendingResumeId(null, clientId);
    
    this._preferences.lastSessionId = null;
    this._preferences.lastCwd = cwd;
    await savePreferences(this._preferences);
    
    console.log(`✓ New chat prepared for ${cwd} - session will create on first message`);
  }

  /**
   * Delete a session
   * @param sessionId - Session to delete
   * @param clientId - Client identifier for multi-client support
   */
  async deleteSession(sessionId: string, clientId?: string): Promise<boolean> {
    const wasActive = sessionId === this.getActiveSessionId(clientId);
    
    await sessionManager.delete(sessionId);
    
    if (wasActive) {
      this.setActiveSessionId(null, clientId);
    }
    
    return wasActive;
  }

  /**
   * Update preferences
   */
  async updatePreferences(updates: Partial<UserPreferences>): Promise<UserPreferences> {
    if (updates.lastModel) this._preferences.lastModel = updates.lastModel;
    if (updates.lastCwd) this._preferences.lastCwd = updates.lastCwd;
    if (updates.lastSessionId !== undefined) this._preferences.lastSessionId = updates.lastSessionId;
    
    await savePreferences(this._preferences);
    return this._preferences;
  }

  /**
   * Check if session has messages
   * @param clientId - Client identifier for multi-client support
   */
  async hasMessages(clientId?: string): Promise<boolean> {
    const activeId = this.getActiveSessionId(clientId);
    if (!activeId || !sessionManager.isActive(activeId)) {
      return false;
    }
    
    try {
      const history = await sessionManager.getHistory(activeId);
      return history.some(e => e.type === 'user.message');
    } catch {
      return false;
    }
  }

  /**
   * Graceful shutdown - stops all client sessions
   */
  async shutdown(): Promise<void> {
    // Stop all active sessions across all clients
    for (const [clientId, sessionId] of this._clientSessions) {
      if (sessionId) {
        console.log(`[SHUTDOWN] Stopping session ${sessionId} for client ${clientId}`);
        await sessionManager.stop(sessionId);
      }
    }
    this._clientSessions.clear();
    this._clientPendingResume.clear();
  }
}

export const sessionState = new SessionState();
