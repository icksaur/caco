/**
 * Session State Manager
 * 
 * Single source of truth for the current session state.
 * Consolidates activeSessionId, preferences, and session lifecycle.
 */

import sessionManager from './session-manager.js';
import { loadPreferences, savePreferences, getDefaultPreferences } from './preferences.js';
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
    
    // Try to resume last session
    if (this._preferences.lastSessionId) {
      try {
        this._activeSessionId = await sessionManager.resume(
          this._preferences.lastSessionId,
          sessionConfig
        );
        console.log(`✓ Resumed last session ${this._activeSessionId}`);
        this._initialized = true;
        return;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`Could not resume last session: ${message}`);
      }
    }
    
    // If lastSessionId was explicitly null, wait for first message
    if (this._preferences.lastSessionId === null) {
      console.log('✓ No existing session - will create on first message');
      this._initialized = true;
      return;
    }
    
    // Try most recent session for cwd
    const cwd = process.cwd();
    const recentSessionId = sessionManager.getMostRecentForCwd(cwd);
    
    if (recentSessionId) {
      try {
        this._activeSessionId = await sessionManager.resume(recentSessionId, sessionConfig);
        this._preferences.lastSessionId = this._activeSessionId;
        await savePreferences(this._preferences);
        console.log(`✓ Resumed session ${this._activeSessionId}`);
        this._initialized = true;
        return;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`Could not resume session ${recentSessionId}: ${message}`);
      }
    }
    
    console.log('✓ No existing session - will create on first message');
    this._initialized = true;
  }

  /**
   * Ensure a session exists, creating one if needed.
   * Used for lazy session creation on first message.
   */
  async ensureSession(model?: string): Promise<string> {
    if (!this._config) {
      throw new Error('SessionState not initialized');
    }
    
    if (this._activeSessionId && sessionManager.isActive(this._activeSessionId)) {
      return this._activeSessionId;
    }
    
    const cwd = this._preferences.lastCwd || process.cwd();
    
    this._activeSessionId = await sessionManager.create(cwd, {
      model: model || 'claude-sonnet-4',
      streaming: true,
      systemMessage: this._config.systemMessage,
      tools: this._config.tools,
      excludedTools: this._config.excludedTools
    });
    
    this._preferences.lastSessionId = this._activeSessionId;
    await savePreferences(this._preferences);
    console.log(`✓ Created session ${this._activeSessionId} with model ${model || 'claude-sonnet-4'}`);
    
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
