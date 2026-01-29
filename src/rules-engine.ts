/**
 * Rules Engine - Evaluates runaway guard rules for agent call flows
 * 
 * Rules:
 * - Age: Max flow duration
 * - Rate: Max calls per time window
 * - Depth: Max collapsed stack depth
 */

import { getEffectiveDepth } from './chain-stack.js';

/**
 * Configuration for runaway limits
 */
export interface RunawayLimits {
  maxDepth: number;           // Max collapsed stack depth
  maxDuration: number;        // Max flow age in seconds
  maxCallsPerWindow: number;  // Max calls in time window
  rateWindow: number;         // Time window for rate limiting in seconds
}

/**
 * Default limits
 */
export const DEFAULT_LIMITS: RunawayLimits = {
  maxDepth: 5,
  maxDuration: 5 * 60,        // 5 minutes
  maxCallsPerWindow: 20,
  rateWindow: 60,             // 1 minute
};

/**
 * Flow metrics for rule evaluation
 */
export interface FlowMetrics {
  chain: string[];            // Raw call chain
  startTime: number;          // Unix timestamp (ms) of first call
  callTimestamps: number[];   // Unix timestamps (ms) of all calls
}

/**
 * Result type for rule evaluation
 */
export type RuleResult = 
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Rules engine for evaluating agent call flows
 */
export class RunawayRulesEngine {
  constructor(private limits: RunawayLimits = DEFAULT_LIMITS) {}

  /**
   * Check if a new call is allowed based on all rules
   * 
   * @param metrics - Current flow metrics
   * @param newSessionId - Session being called
   * @param timestamp - Current timestamp (ms)
   * @returns Result with allowed flag and optional reason
   */
  checkCall(
    metrics: FlowMetrics,
    newSessionId: string,
    timestamp: number
  ): RuleResult {
    // Rule 1: Depth check
    const newChain = [...metrics.chain, newSessionId];
    const depth = getEffectiveDepth(newChain);
    if (depth > this.limits.maxDepth) {
      return {
        allowed: false,
        reason: `Effective call depth ${depth} exceeds limit (max ${this.limits.maxDepth})`
      };
    }

    // Rule 2: Age check
    const age = (timestamp - metrics.startTime) / 1000; // Convert to seconds
    if (age > this.limits.maxDuration) {
      return {
        allowed: false,
        reason: `Flow timeout: ${Math.round(age)}s exceeds limit (max ${this.limits.maxDuration}s)`
      };
    }

    // Rule 3: Rate check
    const windowStart = timestamp - (this.limits.rateWindow * 1000);
    const callsInWindow = metrics.callTimestamps.filter(t => t >= windowStart).length + 1; // +1 for new call
    if (callsInWindow > this.limits.maxCallsPerWindow) {
      return {
        allowed: false,
        reason: `Call rate limit exceeded: ${callsInWindow} calls in ${this.limits.rateWindow}s (max ${this.limits.maxCallsPerWindow})`
      };
    }

    return { allowed: true };
  }

  /**
   * Get current limits
   */
  getLimits(): RunawayLimits {
    return { ...this.limits };
  }

  /**
   * Update limits
   */
  setLimits(limits: Partial<RunawayLimits>): void {
    this.limits = { ...this.limits, ...limits };
  }
}
