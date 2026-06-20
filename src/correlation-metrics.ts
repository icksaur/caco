/**
 * Correlation Metrics - Track metrics for agent call flows
 * 
 * Stores chain, timestamps, and checks against rules using rules-engine.
 */

import { type RateConfig } from './rate-aggregator.js';
import { RunawayRulesEngine } from './rules-engine.js';
import {
  AGENT_MAX_DEPTH,
  AGENT_MAX_AGE_SECONDS,
  AGENT_RATE_LIMIT_CALLS,
  AGENT_RATE_LIMIT_WINDOW_SECONDS
} from './config.js';

export interface CorrelationRules {
  maxDepth: number;
  maxAgeSeconds: number;
  rateLimit: RateConfig;
}

export const DEFAULT_RULES: CorrelationRules = {
  maxDepth: AGENT_MAX_DEPTH,
  maxAgeSeconds: AGENT_MAX_AGE_SECONDS,
  rateLimit: {
    maxCalls: AGENT_RATE_LIMIT_CALLS,
    windowSeconds: AGENT_RATE_LIMIT_WINDOW_SECONDS
  }
};

interface CallRecord {
  sessionId: string;
  timestamp: number;
}

export class CorrelationMetrics {
  private records: CallRecord[] = [];
  private startTime: number;
  private rulesEngine: RunawayRulesEngine;

  constructor(
    public readonly correlationId: string,
    private rules: CorrelationRules = DEFAULT_RULES
  ) {
    this.startTime = Date.now();

    this.rulesEngine = new RunawayRulesEngine({
      maxDepth: rules.maxDepth,
      maxDuration: rules.maxAgeSeconds,
      maxCallsPerWindow: rules.rateLimit.maxCalls,
      rateWindow: rules.rateLimit.windowSeconds
    });
  }

  isAllowed(toSessionId: string): { allowed: true } | { allowed: false; reason: string } {
    const now = Date.now();
    return this.rulesEngine.checkCall(
      {
        chain: this.records.map(r => r.sessionId),
        startTime: this.startTime,
        callTimestamps: this.records.map(r => r.timestamp)
      },
      toSessionId,
      now
    );
  }

  recordCall(toSessionId: string): void {
    this.records.push({ sessionId: toSessionId, timestamp: Date.now() });
  }

  getMetrics() {
    const now = Date.now();
    const windowStart = now - this.rules.rateLimit.windowSeconds * 1000;
    return {
      correlationId: this.correlationId,
      chainLength: this.records.length,
      ageSeconds: Math.floor((now - this.startTime) / 1000),
      callCount: this.records.filter(r => r.timestamp >= windowStart).length,
      chain: this.records.map(r => r.sessionId)
    };
  }

  isExpired(): boolean {
    const ageSeconds = (Date.now() - this.startTime) / 1000;
    return ageSeconds > this.rules.maxAgeSeconds;
  }
}
