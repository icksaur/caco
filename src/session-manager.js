import { CopilotClient } from '@github/copilot-sdk';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';

/**
 * SessionManager - Singleton that owns all SDK interactions
 * 
 * Enforces one active session per cwd (working directory).
 * Discovers existing sessions from ~/.copilot/session-state/
 */
class SessionManager {
    constructor() {
        // cwd → sessionId (lock)
        this.cwdLocks = new Map();
        
        // sessionId → { cwd, session, client }
        this.activeSessions = new Map();
        
        // sessionId → { cwd, summary } (cached from disk)
        this.sessionCache = new Map();
        
        // Path to session state directory
        this.stateDir = join(homedir(), '.copilot', 'session-state');
        
        this.initialized = false;
    }
    
    /**
     * Initialize: scan disk and build session cache
     */
    async init() {
        if (this.initialized) return;
        
        this._discoverSessions();
        this.initialized = true;
        console.log(`✓ SessionManager initialized (${this.sessionCache.size} sessions discovered)`);
    }
    
    /**
     * Scan ~/.copilot/session-state/ and extract sessionId, cwd, summary
     */
    _discoverSessions() {
        this.sessionCache.clear();
        
        if (!existsSync(this.stateDir)) return;
        
        for (const sessionId of readdirSync(this.stateDir)) {
            const sessionDir = join(this.stateDir, sessionId);
            const record = { cwd: null, summary: null };
            
            // Get cwd from events.jsonl (first line)
            try {
                const eventsPath = join(sessionDir, 'events.jsonl');
                const firstLine = readFileSync(eventsPath, 'utf8').split('\n')[0];
                const event = JSON.parse(firstLine);
                if (event.type === 'session.start') {
                    record.cwd = event.data?.context?.cwd ?? null;
                }
            } catch (e) { /* missing or invalid */ }
            
            // Get summary from workspace.yaml
            try {
                const yamlPath = join(sessionDir, 'workspace.yaml');
                const yaml = parseYaml(readFileSync(yamlPath, 'utf8'));
                record.summary = yaml.summary ?? null;
            } catch (e) { /* missing or invalid */ }
            
            this.sessionCache.set(sessionId, record);
        }
    }
    
    /**
     * Create a new session for the given cwd
     * @throws Error if cwd is already locked
     */
    async create(cwd, config = {}) {
        // Check lock
        if (this.cwdLocks.has(cwd)) {
            const existingSessionId = this.cwdLocks.get(cwd);
            throw new Error(`Directory ${cwd} is locked by session ${existingSessionId}`);
        }
        
        // Create client with cwd
        const client = new CopilotClient({ cwd });
        await client.start();
        
        // Create session
        const session = await client.createSession({
            model: config.model || 'gpt-4.1',
            streaming: config.streaming ?? false,
            systemMessage: config.systemMessage,
            ...config
        });
        
        // Lock and track
        this.cwdLocks.set(cwd, session.sessionId);
        this.activeSessions.set(session.sessionId, { cwd, session, client });
        this.sessionCache.set(session.sessionId, { cwd, summary: null });
        
        console.log(`✓ Created session ${session.sessionId} for ${cwd}`);
        return session.sessionId;
    }
    
    /**
     * Resume an existing session
     * @throws Error if session's cwd is already locked by another session
     * @throws Error if session doesn't exist
     */
    async resume(sessionId) {
        // Get cwd from cache
        const cached = this.sessionCache.get(sessionId);
        if (!cached) {
            throw new Error(`Session ${sessionId} not found`);
        }
        
        const cwd = cached.cwd;
        if (!cwd) {
            throw new Error(`Session ${sessionId} has no cwd recorded`);
        }
        
        // Check lock
        const lockHolder = this.cwdLocks.get(cwd);
        if (lockHolder && lockHolder !== sessionId) {
            throw new Error(`Directory ${cwd} is locked by session ${lockHolder}`);
        }
        
        // Already active?
        if (this.activeSessions.has(sessionId)) {
            console.log(`Session ${sessionId} already active`);
            return sessionId;
        }
        
        // Create client with correct cwd
        const client = new CopilotClient({ cwd });
        await client.start();
        
        // Resume session
        const session = await client.resumeSession(sessionId);
        
        // Lock and track
        this.cwdLocks.set(cwd, sessionId);
        this.activeSessions.set(sessionId, { cwd, session, client });
        
        console.log(`✓ Resumed session ${sessionId} for ${cwd}`);
        return sessionId;
    }
    
    /**
     * Stop an active session (releases lock)
     */
    async stop(sessionId) {
        const active = this.activeSessions.get(sessionId);
        if (!active) {
            console.log(`Session ${sessionId} not active, nothing to stop`);
            return;
        }
        
        const { cwd, session, client } = active;
        
        try {
            await session.destroy();
        } catch (e) {
            console.warn(`Warning: session.destroy() failed: ${e.message}`);
        }
        
        try {
            await client.stop();
        } catch (e) {
            console.warn(`Warning: client.stop() failed: ${e.message}`);
        }
        
        // Unlock and untrack
        this.cwdLocks.delete(cwd);
        this.activeSessions.delete(sessionId);
        
        console.log(`✓ Stopped session ${sessionId}`);
    }
    
    /**
     * Send a message to an active session
     * @throws Error if session is not active
     */
    async send(sessionId, message, options = {}) {
        const active = this.activeSessions.get(sessionId);
        if (!active) {
            throw new Error(`Session ${sessionId} is not active`);
        }
        
        const { session } = active;
        const response = await session.sendAndWait({
            prompt: message,
            ...options
        });
        
        return response;
    }
    
    /**
     * Get message history for a session
     */
    async getHistory(sessionId) {
        const active = this.activeSessions.get(sessionId);
        if (!active) {
            throw new Error(`Session ${sessionId} is not active`);
        }
        
        const { session } = active;
        const messages = await session.getMessages();
        return messages;
    }
    
    /**
     * Delete a session from disk
     */
    async delete(sessionId) {
        // Stop if active
        if (this.activeSessions.has(sessionId)) {
            await this.stop(sessionId);
        }
        
        // Get any client to delete (cwd doesn't matter for delete)
        const cached = this.sessionCache.get(sessionId);
        const cwd = cached?.cwd || process.cwd();
        
        const client = new CopilotClient({ cwd });
        await client.start();
        
        try {
            await client.deleteSession(sessionId);
            console.log(`✓ Deleted session ${sessionId}`);
        } finally {
            await client.stop();
        }
        
        this.sessionCache.delete(sessionId);
    }
    
    /**
     * List all sessions (from cache)
     * @returns Array of { sessionId, cwd, summary }
     */
    list() {
        const result = [];
        for (const [sessionId, { cwd, summary }] of this.sessionCache) {
            result.push({ sessionId, cwd, summary });
        }
        return result;
    }
    
    /**
     * List sessions for a specific cwd
     */
    listByCwd(cwd) {
        return this.list().filter(s => s.cwd === cwd);
    }
    
    /**
     * Get the most recent session for a cwd
     * (Based on directory modification time)
     */
    getMostRecentForCwd(cwd) {
        const sessions = this.listByCwd(cwd);
        if (sessions.length === 0) return null;
        
        // Sort by modified time (newest first)
        const sorted = sessions
            .map(s => {
                const yamlPath = join(this.stateDir, s.sessionId, 'workspace.yaml');
                try {
                    const yaml = parseYaml(readFileSync(yamlPath, 'utf8'));
                    return { ...s, updatedAt: new Date(yaml.updated_at || 0) };
                } catch (e) {
                    return { ...s, updatedAt: new Date(0) };
                }
            })
            .sort((a, b) => b.updatedAt - a.updatedAt);
        
        return sorted[0]?.sessionId || null;
    }
    
    /**
     * Get active sessionId for a cwd (or null)
     */
    getActive(cwd) {
        return this.cwdLocks.get(cwd) || null;
    }
    
    /**
     * Get cwd for a session
     */
    getSessionCwd(sessionId) {
        return this.sessionCache.get(sessionId)?.cwd || null;
    }
    
    /**
     * Check if a session is active
     */
    isActive(sessionId) {
        return this.activeSessions.has(sessionId);
    }
}

// Singleton instance
const sessionManager = new SessionManager();
export default sessionManager;
