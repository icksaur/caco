/**
 * Session Observed State
 * 
 * Marks a session as observed when the user sees the completion.
 * Called when session.idle is received while viewing that session.
 */

/**
 * Mark a session as observed (user has seen the completed response)
 * Calls server endpoint which updates meta and broadcasts to other clients
 */
export async function markSessionObserved(sessionId: string): Promise<void> {
  try {
    console.log(`[OBSERVED] Marking session as observed: ${sessionId.slice(0, 8)}`);
    const response = await fetch(`/api/sessions/${sessionId}/observe`, {
      method: 'POST'
    });
    
    if (!response.ok) {
      console.error(`[OBSERVED] Failed to mark session observed:`, response.status);
    }
  } catch (error) {
    console.error(`[OBSERVED] Error marking session observed:`, error);
  }
}
