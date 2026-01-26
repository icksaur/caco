/**
 * Send Message Module
 * 
 * Handles sending messages (with optional images) to the server.
 * Separates the "send" concern from the "stream response" concern.
 */

export interface SendMessageRequest {
  prompt: string;
  model: string;
  imageData?: string;
  cwd?: string;
}

export interface SendMessageResponse {
  streamId: string;
}

/**
 * Send a message to the server via POST
 * Returns a streamId that can be used to connect to SSE for the response
 */
export async function sendMessage(request: SendMessageRequest): Promise<SendMessageResponse> {
  const response = await fetch('/api/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  
  return response.json();
}
