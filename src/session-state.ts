/**
 * Session State Manager
 * 
 * Single source of truth for the current session state.
 * Consolidates activeSessionId, preferences, and session lifecycle.
 */

import sessionManager from './session-manager.js';
import { loadPreferences, savePreferences, getDefaultPreferences, DEFAULT_MODEL } from './preferences.js';
import type { UserPreferences, SystemMessage, SessionConfig } from './types.js';

export interface SessionStateConfig {
  systemMessage: SystemMessage;
  tools: unknown[];
  excludedTools: string[];
}

/**
 * Manages the active session state for the server.
 * Provides a unified interface for session lifecycle operations.
 */
class SessionState {
  private _activeSessionId: string | null = null;
  private _pendingResumeId: string | null = null;  // Session to resume on first message
  private _preferences: UserPreferences = getDefaultPreferences();
  private _config: SessionStateConfig | null = null;
  private _initialized = false;

  /**
   * Get the current active session ID
   */
  get activeSessionId(): string | null {
    return this._activeSessionId;
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
   * Initialize session state - must be called before other operations
   */
  async init(config: SessionStateConfig): Promise<void> {
    if (this._initialized) return;
    
    this._config = config;
    await sessionManager.init();
    this._preferences = await loadPreferences();
    
    const sessionConfig = {
      tools: config.tools,
      excludedTools: config.excludedTools
    };
    
    // Check for session to resume - but DON'T resume yet
    // We only create/resume SDK session on first message (in ensureSession)
    // This allows user to select model before first message
    if (this._preferences.lastSessionId) {
      // Check if this session exists and has messages
      if (sessionManager.hasMessages(this._preferences.lastSessionId)) {
        this._pendingResumeId = this._preferences.lastSessionId;
        console.log(`✓ Will resume session ${this._pendingResumeId} on first message`);
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
      this._pendingResumeId = recentSessionId;
      this._preferences.lastSessionId = recentSessionId;
      await savePreferences(this._preferences);
      console.log(`✓ Will resume session ${this._pendingResumeId} on first message`);
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
   */
  async ensureSession(model?: string, newChat?: boolean, cwd?: string): Promise<string> {
    if (!this._config) {
      throw new Error('SessionState not initialized');
    }
    
    // Explicit new chat request - clear active session
    if (newChat) {
      console.log(`[SESSION] New chat requested - clearing active session`);
      this._activeSessionId = null;
    }
    
    // If we have an active session, return it
    if (this._activeSessionId && sessionManager.isActive(this._activeSessionId)) {
      console.log(`[MODEL] Reusing existing session ${this._activeSessionId} - requested model '${model || '(undefined)'}' is IGNORED`);
      return this._activeSessionId;
    }
    
    // Use provided cwd, or last preference, or process.cwd()
    const sessionCwd = cwd || this._preferences.lastCwd || process.cwd();
    const sessionConfig = {
      tools: this._config.tools,
      excludedTools: this._config.excludedTools
    };
    
    // If there's a pending resume, resume that session (model is already baked in)
    if (this._pendingResumeId) {
      try {
        this._activeSessionId = await sessionManager.resume(this._pendingResumeId, sessionConfig);
        this._preferences.lastSessionId = this._activeSessionId;
        await savePreferences(this._preferences);
        console.log(`✓ Resumed pending session ${this._activeSessionId}`);
        this._pendingResumeId = null; // Clear pending
        return this._activeSessionId;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`Could not resume pending session: ${message}`);
        this._pendingResumeId = null; // Clear and fall through to create
      }
    }
    
    // Create new session with specified model
    const finalModel = model || DEFAULT_MODEL;
    console.log(`[MODEL] Creating SDK session with model: ${finalModel} (from param: ${model || '(undefined)'})`);
    console.log(`[CWD] Creating session with cwd: ${sessionCwd}`);
    
    this._activeSessionId = await sessionManager.create(sessionCwd, {
      model: finalModel,
      streaming: true,
      systemMessage: this._config.systemMessage,
      tools: this._config.tools,
      excludedTools: this._config.excludedTools
    });
    
    this._preferences.lastSessionId = this._activeSessionId;
    this._preferences.lastCwd = sessionCwd; // Save cwd for next time
    await savePreferences(this._preferences);
    console.log(`✓ Created session ${this._activeSessionId} with model ${finalModel}`);
    
    return this._activeSessionId;
  }

  /**
   * Switch to a different session
   */
  async switchSession(sessionId: string): Promise<string> {
    if (!this._config) {
      throw new Error('SessionState not initialized');
    }
    
    // Stop current session
    if (this._activeSessionId) {
      await sessionManager.stop(this._activeSessionId);
    }
    
    // Clear any pending resume - we're switching explicitly
    this._pendingResumeId = null;
    
    // Resume new session
    this._activeSessionId = await sessionManager.resume(sessionId, {
      tools: this._config.tools,
      excludedTools: this._config.excludedTools
    });
    
    this._preferences.lastSessionId = this._activeSessionId;
    await savePreferences(this._preferences);
    
    return this._activeSessionId;
  }

  /**
   * Prepare for a new chat (stop current, set cwd, clear session)
   */
  async prepareNewChat(cwd: string): Promise<void> {
    if (this._activeSessionId) {
      await sessionManager.stop(this._activeSessionId);
      this._activeSessionId = null;
    }
    
    // Clear any pending resume - user wants a fresh chat
    this._pendingResumeId = null;
    
    this._preferences.lastSessionId = null;
    this._preferences.lastCwd = cwd;
    await savePreferences(this._preferences);
    
    console.log(`✓ New chat prepared for ${cwd} - session will create on first message`);
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const wasActive = sessionId === this._activeSessionId;
    
    await sessionManager.delete(sessionId);
    
    if (wasActive) {
      this._activeSessionId = null;
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
   */
  async hasMessages(): Promise<boolean> {
    if (!this._activeSessionId || !sessionManager.isActive(this._activeSessionId)) {
      return false;
    }
    
    try {
      const history = await sessionManager.getHistory(this._activeSessionId);
      return history.some(e => e.type === 'user.message');
    } catch {
      return false;
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    if (this._activeSessionId) {
      await sessionManager.stop(this._activeSessionId);
    }
  }
}

// Singleton instance
export const sessionState = new SessionState();
