/**
 * Resume Context Builder
 * 
 * Pure function to build the context message prepended to user messages
 * when resuming a session. Extracted for testability.
 */

export interface ResumeContextInput {
  cwd: string;
  envHint?: string;
}

/**
 * Build context message to prepend on first send after resume.
 * Informs agent that shell state is reset and may need re-initialization.
 */
export function buildResumeContext(input: ResumeContextInput): string {
  const { cwd, envHint } = input;
  
  let context = `[SESSION RESUMED]
This is a resumed session. Your shell state has been reset.
Re-run any environment setup commands before proceeding.

Session directory: ${cwd}`;

  if (envHint) {
    context += `\nEnvironment hint: ${envHint}`;
  }
  
  context += '\n---\n\n';
  return context;
}
