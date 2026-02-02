/**
 * Logger - Simple structured logging utility
 * 
 * Provides consistent log format with tags and levels.
 * Can be extended to use a proper logging library later.
 * 
 * Format: [LEVEL] [TAG] message { context }
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  [key: string]: unknown;
}

/**
 * Simple logger with consistent formatting.
 * 
 * @example
 * const log = createLogger('SESSION');
 * log.info('Created session', { sessionId: '123', cwd: '/home/user' });
 * // Output: [INFO] [SESSION] Created session { sessionId: '123', cwd: '/home/user' }
 */
export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

/**
 * Format context object for display
 */
function formatContext(context: LogContext | undefined): string {
  if (!context || Object.keys(context).length === 0) {
    return '';
  }
  
  // Compact format for small objects, JSON for larger
  const entries = Object.entries(context);
  if (entries.length <= 3 && entries.every(([, v]) => typeof v !== 'object')) {
    return ' ' + entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
  }
  
  return ' ' + JSON.stringify(context);
}

/**
 * Create a logger with a specific tag
 */
export function createLogger(tag: string): Logger {
  const log = (level: LogLevel, message: string, context?: LogContext) => {
    const levelStr = level.toUpperCase().padEnd(5);
    const contextStr = formatContext(context);
    const output = `[${levelStr}] [${tag}] ${message}${contextStr}`;
    
    switch (level) {
      case 'debug':
        console.debug(output);
        break;
      case 'info':
        console.log(output);
        break;
      case 'warn':
        console.warn(output);
        break;
      case 'error':
        console.error(output);
        break;
    }
  };
  
  return {
    debug: (message, context) => log('debug', message, context),
    info: (message, context) => log('info', message, context),
    warn: (message, context) => log('warn', message, context),
    error: (message, context) => log('error', message, context),
  };
}

// Pre-created loggers for common modules
export const serverLog = createLogger('SERVER');
export const sessionLog = createLogger('SESSION');
export const dispatchLog = createLogger('DISPATCH');
export const scheduleLog = createLogger('SCHEDULER');
export const storageLog = createLogger('STORAGE');
export const wsLog = createLogger('WS');
