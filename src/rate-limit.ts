export interface TokenBucketLimiterOptions {
  ratePerMinute: number;
  burst: number;
  maxKeys?: number;
  idleTtlMs?: number;
}

export interface TokenBucketResult {
  allowed: boolean;
  retryAfterSeconds: number;
  remainingTokens: number;
}

interface TokenBucketState {
  tokens: number;
  lastRefillMs: number;
  lastSeenMs: number;
}

export class TokenBucketLimiter {
  private readonly ratePerMinute: number;
  private readonly burst: number;
  private readonly maxKeys: number;
  private readonly idleTtlMs: number;
  private readonly states = new Map<string, TokenBucketState>();

  constructor(options: TokenBucketLimiterOptions) {
    this.ratePerMinute = Math.max(0, options.ratePerMinute);
    this.burst = Math.max(0, options.burst);
    this.maxKeys = Math.max(1, options.maxKeys ?? 10_000);
    this.idleTtlMs = Math.max(1_000, options.idleTtlMs ?? 15 * 60_000);
  }

  consume(key: string, tokens = 1, nowMs = Date.now()): TokenBucketResult {
    if (this.burst === 0) {
      return {
        allowed: false,
        retryAfterSeconds: 60,
        remainingTokens: 0,
      };
    }

    const safeTokens = Math.max(1, tokens);
    const state = this.getOrCreateState(key, nowMs);
    this.refill(state, nowMs);

    if (state.tokens >= safeTokens) {
      state.tokens -= safeTokens;
      state.lastSeenMs = nowMs;
      return {
        allowed: true,
        retryAfterSeconds: 0,
        remainingTokens: Math.floor(state.tokens),
      };
    }

    if (this.ratePerMinute <= 0) {
      return {
        allowed: false,
        retryAfterSeconds: 60,
        remainingTokens: Math.floor(state.tokens),
      };
    }

    const tokensNeeded = safeTokens - state.tokens;
    const retryAfterMs = Math.ceil((tokensNeeded * 60_000) / this.ratePerMinute);

    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      remainingTokens: Math.floor(Math.max(0, state.tokens)),
    };
  }

  private getOrCreateState(key: string, nowMs: number): TokenBucketState {
    this.pruneIfNeeded(nowMs);

    const existing = this.states.get(key);
    if (existing) {
      return existing;
    }

    const created: TokenBucketState = {
      tokens: this.burst,
      lastRefillMs: nowMs,
      lastSeenMs: nowMs,
    };

    this.states.set(key, created);
    return created;
  }

  private refill(state: TokenBucketState, nowMs: number): void {
    if (nowMs <= state.lastRefillMs || this.ratePerMinute <= 0) {
      state.lastRefillMs = nowMs;
      return;
    }

    const elapsedMs = nowMs - state.lastRefillMs;
    const refillTokens = (elapsedMs * this.ratePerMinute) / 60_000;
    state.tokens = Math.min(this.burst, state.tokens + refillTokens);
    state.lastRefillMs = nowMs;
  }

  private pruneIfNeeded(nowMs: number): void {
    if (this.states.size < this.maxKeys) {
      return;
    }

    for (const [key, state] of this.states) {
      if (nowMs - state.lastSeenMs > this.idleTtlMs) {
        this.states.delete(key);
      }

      if (this.states.size < this.maxKeys) {
        return;
      }
    }

    // Hard cap fallback: remove oldest keys if all entries are active.
    const oldestEntries = [...this.states.entries()].sort((left, right) => left[1].lastSeenMs - right[1].lastSeenMs);
    const excess = Math.max(0, this.states.size - this.maxKeys + 1);
    for (let index = 0; index < excess; index += 1) {
      this.states.delete(oldestEntries[index][0]);
    }
  }
}
