/**
 * Shell API Route
 * 
 * POST /api/shell - Execute shell commands
 * 
 * Uses execFile with args array for clean argument passing.
 * Output sanitized (ANSI stripped, line endings normalized).
 * 
 * See doc/shell-api.md for full specification.
 */

import { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { stripVTControlCharacters } from 'util';
import { stat } from 'fs/promises';
import { isAbsolute } from 'path';
import { apiError, sendError } from '../api-error.js';
import { EXEC_TIMEOUT_MS, EXEC_MAX_BUFFER_BYTES } from '../config.js';

const router = Router();

const execFileAsync = promisify(execFile);

/**
 * Request body for shell command
 */
interface ShellRequest {
  command: string;
  args?: string[];
  cwd?: string;
}

/**
 * Response from shell command
 */
interface ShellResponse {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Sanitize command output:
 * - Strip ANSI/VT escape codes
 * - Normalize line endings (CRLF → LF)
 * - Remove carriage returns (progress bars, spinners)
 */
function sanitizeOutput(text: string): string {
  // Strip VT control characters (ANSI escape codes)
  let result = stripVTControlCharacters(text);
  // Normalize CRLF to LF, remove bare CR
  result = result.replace(/\r\n/g, '\n').replace(/\r/g, '');
  return result;
}

/**
 * Validate working directory:
 * - Must be absolute path
 * - Must exist
 * - Must be a directory
 */
async function validateCwd(cwd: string): Promise<{ valid: true } | { valid: false; error: string }> {
  // isAbsolute handles both Unix (/home/...) and Windows (C:\...)
  if (!isAbsolute(cwd)) {
    return { valid: false, error: 'Working directory must be absolute path' };
  }
  
  try {
    const stats = await stat(cwd);
    if (!stats.isDirectory()) {
      return { valid: false, error: 'Working directory is not a directory' };
    }
    return { valid: true };
  } catch (error) {
    return { valid: false, error: 'Working directory does not exist' };
  }
}

/**
 * POST /api/shell
 * 
 * Execute an allowlisted command with args.
 * 
 * Request:
 *   { command: "git", args: ["status", "--porcelain=v2"], cwd?: "/path" }
 * 
 * Response:
 *   { stdout: "...", stderr: "...", code: 0 }
 */
router.post('/shell', async (req: Request, res: Response): Promise<void> => {
  const { command, args = [], cwd } = req.body as ShellRequest;
  
  // Validate required fields
  if (!command || typeof command !== 'string') {
    apiError.badRequest(res, 'command is required');
    return;
  }
  
  // Validate args is array of strings
  if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) {
    apiError.badRequest(res, 'args must be an array of strings');
    return;
  }
  
  // Determine working directory
  const workingDir = cwd || process.cwd();
  
  // Validate working directory
  const cwdValidation = await validateCwd(workingDir);
  if (!cwdValidation.valid) {
    apiError.badRequest(res, cwdValidation.error);
    return;
  }
  
  try {
    // Execute command with args (no shell, prevents injection)
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: workingDir,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER_BYTES,
      encoding: 'utf8',
      windowsHide: true,
    });
    
    // Success - exit code 0
    const response: ShellResponse = {
      stdout: sanitizeOutput(stdout),
      stderr: sanitizeOutput(stderr),
      code: 0,
    };
    
    res.json(response);
    
  } catch (error: unknown) {
    // Handle different error types
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
      killed?: boolean;
      signal?: string;
    };
    
    // Timeout (killed by signal)
    if (err.killed && err.signal === 'SIGTERM') {
      sendError(res, 408, 'Command timed out', 'TIMEOUT');
      return;
    }
    
    // Command not found
    if (err.code === 'ENOENT') {
      apiError.internal(res, `Command not found: ${command}`);
      return;
    }
    
    // Non-zero exit code (normal command failure)
    if (typeof err.code === 'number') {
      const response: ShellResponse = {
        stdout: sanitizeOutput(err.stdout || ''),
        stderr: sanitizeOutput(err.stderr || ''),
        code: err.code,
      };
      res.json(response);
      return;
    }
    
    // Unknown error
    console.error('[SHELL] Execution error:', err);
    apiError.internal(res, err.message || 'Command execution failed');
  }
});

export default router;
