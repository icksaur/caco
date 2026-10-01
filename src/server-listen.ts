/**
 * Binds the HTTP server to the requested port or one of the next few.
 *
 * WHY a fallback: on Windows a port can be reserved at boot (WinNAT / Hyper-V
 * excluded ranges), and binding it fails with EACCES until the next reboot.
 *
 * This policy does NOT decide whether another Caco is running; the server lock
 * (server-lock.ts) does, before initialization. Here a port held by anything is
 * just an unavailable port. Do not add an occupant probe: it misses a Caco on a
 * different port and misreads a busy one.
 */
import type { EventEmitter } from 'events';

/** Ports tried after the requested one. */
export const PORT_FALLBACK_COUNT = 2;
/** Re-binds of the requested port while it is busy: a restarting parent may still be releasing it. */
export const PORT_RETRY_COUNT = 10;
export const PORT_RETRY_DELAY_MS = 500;

export interface PortAttempt {
  port: number;
  code: string;
}

export interface ListenResult {
  port: number;
  /** Earlier candidates that could not be bound, in the order tried. */
  skipped: PortAttempt[];
}

/** Every candidate port failed. */
export class StartupPortError extends Error {
  constructor(readonly attempts: PortAttempt[], readonly host: string) {
    super(`Could not bind any of ${attempts.map(a => `${host}:${a.port}`).join(', ')}`);
    this.name = 'StartupPortError';
  }
}

/** The subset of http.Server this needs, so tests can script outcomes. */
export interface Bindable extends EventEmitter {
  listen(port: number, host: string, callback: () => void): unknown;
}

export interface ListenDeps {
  sleep: (ms: number) => Promise<void>;
}

function bindOnce(server: Bindable, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export async function listenWithFallback(
  server: Bindable,
  options: { host: string; port: number },
  deps: ListenDeps,
): Promise<ListenResult> {
  const skipped: PortAttempt[] = [];

  for (let offset = 0; offset <= PORT_FALLBACK_COUNT; offset++) {
    const port = options.port + offset;
    // Only the requested port is worth waiting on: a restart frees it within
    // moments, while a busy fallback port has no reason to free up.
    const retries = offset === 0 ? PORT_RETRY_COUNT : 0;

    for (let attempt = 0; ; attempt++) {
      try {
        await bindOnce(server, port, options.host);
        return { port, skipped };
      } catch (error) {
        const code = codeOf(error);
        if (code === 'EADDRINUSE' && attempt < retries) {
          await deps.sleep(PORT_RETRY_DELAY_MS);
          continue;
        }
        if (code === 'EACCES' || code === 'EADDRINUSE') {
          skipped.push({ port, code });
          break;
        }
        throw error;
      }
    }
  }

  throw new StartupPortError(skipped, options.host);
}

/** Exit status when no port could be bound, or startup otherwise failed. */
export const EXIT_STARTUP_FAILED = 1;

const REASONS: Record<string, string> = {
  EACCES: 'access denied',
  EADDRINUSE: 'already in use',
};

/** One line per attempted port, plus a Windows hint when access was denied. */
export function formatStartupFailure(error: StartupPortError, platform: NodeJS.Platform): string {
  const lines = ['Caco could not start: no port was available.'];
  for (const a of error.attempts) {
    lines.push(`  ${error.host}:${a.port}  ${REASONS[a.code] ?? a.code} (${a.code})`);
  }
  if (platform === 'win32' && error.attempts.some(a => a.code === 'EACCES')) {
    lines.push(
      'Windows reserves port ranges at boot (WinNAT / Hyper-V); a reboot changes them.',
      'List them with:  netsh interface ipv4 show excludedportrange protocol=tcp',
      'Then set CACO_PORT to a port outside every listed range.',
    );
  } else {
    lines.push('Set CACO_PORT to use a different port.');
  }
  return lines.join('\n');
}
