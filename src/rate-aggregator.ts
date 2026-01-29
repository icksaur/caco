/**
 * Rate Aggregator - Sliding window rate limiting
 * 
 * Tracks calls within a time window and checks against limit.
 */

export interface RateConfig {
  maxCalls: number;     // Max calls allowed
  windowSeconds: number; // Time window in seconds
}

/**
 * Aggregates call timestamps and checks rate limits
 */
export class RateAggregator {
  private timestamps: number[] = [];
  
  constructor(private config: RateConfig) {}
  
  /**
   * Record a call at given timestamp
   * 
   * @param timestamp - Unix timestamp in ms
   */
  recordCall(timestamp: number): void {
    this.timestamps.push(timestamp);
    this.cleanup(timestamp);
  }
  
  /**
   * Check if a new call would exceed rate limit
   * 
   * @param timestamp - Unix timestamp in ms
   * @returns true if call is allowed
   */
  isAllowed(timestamp: number): boolean {
    this.cleanup(timestamp);
    return this.timestamps.length < this.config.maxCalls;
  }
  
  /**
   * Get current call count in window
   * 
   * @param timestamp - Unix timestamp in ms
   * @returns Number of calls in current window
   */
  getCallCount(timestamp: number): number {
    this.cleanup(timestamp);
    return this.timestamps.length;
  }
  
  /**
   * Remove calls outside the time window
   */
  private cleanup(currentTime: number): void {
    const windowStart = currentTime - (this.config.windowSeconds * 1000);
    this.timestamps = this.timestamps.filter(t => t >= windowStart);
  }
  
  /**
   * Reset all recorded calls
   */
  reset(): void {
    this.timestamps = [];
  }
}
