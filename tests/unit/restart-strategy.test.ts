import { describe, it, expect } from 'vitest';
import { shouldSpawnReplacement } from '../../src/restart-manager.js';

/**
 * Regression oracle for the failure observed 2026-08-03 (three occurrences).
 *
 * Under systemd the server ran as Type=forking with KillMode=control-group. The
 * restart tool spawned a replacement into the SAME cgroup, then the parent
 * exited. systemd saw its main process go, ran ExecStop, and cleaned the cgroup —
 * killing the half-booted replacement (which needs 7-11s and had not yet bound
 * the port). ExecStop succeeded, so Result=success and Restart=on-failure never
 * fired: the machine was left with no server at all.
 *
 * Self-spawning cannot be made safe there, so the decision is what these cases
 * pin: under a service manager, exit and let it start the replacement.
 */
describe('shouldSpawnReplacement', () => {
  it('spawns a replacement when running standalone', () => {
    expect(shouldSpawnReplacement({})).toBe(true);
    expect(shouldSpawnReplacement({ PATH: '/usr/bin' })).toBe(true);
  });

  it('does NOT spawn when systemd is managing the process', () => {
    // INVOCATION_ID is set by systemd for every process of a unit, and is the
    // documented way to detect it.
    expect(shouldSpawnReplacement({ INVOCATION_ID: 'b5eba9cd5f6a47ce8f087f9fa37c956b' })).toBe(false);
  });

  it('ignores an empty INVOCATION_ID rather than treating it as managed', () => {
    // An exported-but-empty variable must not silently disable respawn, which
    // would leave a standalone server dead after a restart.
    expect(shouldSpawnReplacement({ INVOCATION_ID: '' })).toBe(true);
  });

  it('does not rely on JOURNAL_STREAM alone', () => {
    // Journald capture can be inherited by a process no service manager will
    // restart, so it is not sufficient evidence of supervision.
    expect(shouldSpawnReplacement({ JOURNAL_STREAM: '10:1435080' })).toBe(true);
  });
});
