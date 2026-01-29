/**
 * Correlation Metrics - Track metrics for agent call flows
 * 
 * Stores chain, timestamps, and checks against rules using rules-engine.
 */

import { RateAggregator, type RateConfig } from './rate-aggregator.js';
import { RunawayRulesEngine, type RunawayLimits } from './rules-engine.js';

export interface CorrelationRules {
  maxDepth: number;
  maxAgeSeconds: number;
  rateLimit: RateConfig;
}

export const DEFAULT_RULES: CorrelationRules = {
  maxDepth: 2,
  maxAgeSeconds: 60 * 60, // 1 hour
  rateLimit: {
    maxCalls: 10,
    windowSeconds: 60
  }
};

/**
 * Metrics for a single correlation flow
 */
export class CorrelationMetrics {
  private chain: string[] = [];
  private startTime: number;
  private rateAggregator: RateAggregator;
  private rulesEngine: RunawayRulesEngine;
  
  constructor(
    public readonly correlationId: string,
    private rules: CorrelationRules = DEFAULT_RULES
  ) {
    this.startTime = Date.now();
    this.rateAggregator = new RateAggregator(rules.rateLimit);
    
    // Convert our rules to RunawayLimits format
    this.rulesEngine = new RunawayRulesEngine({
      maxDepth: rules.maxDepth,
      maxDuration: rules.maxAgeSeconds,
      maxCallsPerWindow: rules.rateLimit.maxCalls,
      rateWindow: rules.rateLimit.windowSeconds
    });
  }
  
  /**
   * Check if a new call is allowed
   * 
   * @param toSessionId - Session being called
   * @returns { allowed: true } or { allowed: false, reason: string }
   */
  isAllowed(toSessionId: string): { allowed: true } | { allowed: false; reason: string } {
    const now = Date.now();
    
    // Check rate limit first (fast path)
    if (!this.rateAggregator.isAllowed(now)) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${this.rules.rateLimit.maxCalls} calls per ${this.rules.rateLimit.windowSeconds}s`
      };
    }
    
    // Check rules engine (depth, age)
    const allTimestamps = [...this.chain.map(() => now)]; // Simplified for engine
    const result = this.rulesEngine.checkCall(
      {
        chain: this.chain,
        startTime: this.startTime,
        callTimestamps: allTimestamps
      },
      toSessionId,
      now
    );
    
    return result;
  }
  
  /**
   * Record a successful call
   * 
   * @param toSessionId - Session that was called
   */
  recordCall(toSessionId: string): void {
    const now = Date.now();
    this.chain.push(toSessionId);
    this.rateAggregator.recordCall(now);
  }
  
  /**
   * Get current metrics
   */
  getMetrics() {
    const now = Date.now();
    return {
      correlationId: this.correlationId,
      chainLength: this.chain.length,
      ageSeconds: Math.floor((now - this.startTime) / 1000),
      callCount: this.rateAggregator.getCallCount(now),
      chain: [...this.chain]
    };
  }
  
  /**
   * Check if flow has expired
   */
  isExpired(): boolean {
    const ageSeconds = (Date.now() - this.startTime) / 1000;
    return ageSeconds > this.rules.maxAgeSeconds;
  }
}
