/**
 * Runner-side spending tracking and turn admission guardrails.
 *
 * Tracks accumulated known spending accurately, deduplicates step usage events
 * to prevent double-counting across retries or event settles, and enforces
 * strict guardrails on budget exhaustion and unpriced token usage.
 */
import type { FinishStatus } from "./protocol"
import { tokenCounts } from "./transcript"

export type BudgetHaltReason = "budget_exceeded" | "unpriced_usage_halt"

export interface BudgetHalt {
  reason: BudgetHaltReason
  message: string
}

export interface StepUsagePart {
  id?: string
  cost?: number | null
  tokens?: unknown
}

export function isValidPartId(id: unknown): id is string {
  return typeof id === "string" && id.trim().length > 0
}

export interface FallbackUsage {
  costUsd?: number | null
  tokensIn?: number
  tokensOut?: number
}

export class SpendingTracker {
  readonly limitUsd: number | null
  private totalCost = 0
  private seenParts = new Set<string>()
  private halt: BudgetHalt | null = null
  private inFlight = 0
  private liveUsageRecorded = false

  constructor(limitUsd?: number | null) {
    this.limitUsd = typeof limitUsd === "number" && Number.isFinite(limitUsd) ? limitUsd : null
  }

  get spentUsd(): number {
    return this.totalCost
  }

  get haltReason(): BudgetHaltReason | null {
    return this.halt ? this.halt.reason : null
  }

  get haltInfo(): BudgetHalt | null {
    return this.halt
  }

  get inFlightCount(): number {
    return this.inFlight
  }

  startTurn(): void {
    this.inFlight += 1
  }

  finishTurn(): void {
    if (this.inFlight > 0) this.inFlight -= 1
  }

  canAdmitTurn(): { ok: true } | { ok: false; halt: BudgetHalt } {
    if (this.halt) return { ok: false, halt: this.halt }
    if (this.limitUsd !== null) {
      if (this.limitUsd <= 0) {
        this.halt = {
          reason: "budget_exceeded",
          message: `Spend limit of $${this.limitUsd.toFixed(2)} reached (spent $${this.totalCost.toFixed(2)}).`,
        }
        return { ok: false, halt: this.halt }
      }
      if (this.totalCost >= this.limitUsd) {
        this.halt = {
          reason: "budget_exceeded",
          message: `Spend limit of $${this.limitUsd.toFixed(2)} reached (spent $${this.totalCost.toFixed(2)}).`,
        }
        return { ok: false, halt: this.halt }
      }
    }
    return { ok: true }
  }

  get hasLiveUsage(): boolean {
    return this.liveUsageRecorded
  }

  recordStepUsage(part: StepUsagePart): BudgetHalt | null {
    if (this.halt) return this.halt

    if (isValidPartId(part.id)) {
      if (this.seenParts.has(part.id)) return this.halt
      this.seenParts.add(part.id)
    }

    const tokens = tokenCounts(part.tokens)
    const hasTokens = tokens.in > 0 || tokens.out > 0
    const hasKnownCost = typeof part.cost === "number" && Number.isFinite(part.cost)

    // Validate ID boundary: malformed or absent IDs with positive usage under budget
    // cannot be safely deduplicated, so apply strict unpriced usage guardrail.
    if (!isValidPartId(part.id) && (hasTokens || hasKnownCost)) {
      if (this.limitUsd !== null) {
        this.halt = {
          reason: "unpriced_usage_halt",
          message: `Malformed or missing step usage part ID under configured spend limit of $${this.limitUsd.toFixed(2)}.`,
        }
        return this.halt
      }
      return null
    }

    if (hasKnownCost) {
      const added = Math.max(0, part.cost as number)
      this.totalCost = Math.round((this.totalCost + added) * 1e6) / 1e6
      this.liveUsageRecorded = true
    } else if (hasTokens) {
      this.liveUsageRecorded = true
    }

    if (this.limitUsd !== null && !this.halt) {
      // If a budget is configured and token usage occurred without known USD cost,
      // stop according to the strict guardrail policy.
      if (!hasKnownCost && hasTokens) {
        this.halt = {
          reason: "unpriced_usage_halt",
          message: `Unpriced token usage observed (${tokens.in} in, ${tokens.out} out) under configured spend limit of $${this.limitUsd.toFixed(2)}.`,
        }
        return this.halt
      }

      // Check if accumulated known spending reached or exceeded the configured limit.
      if (this.totalCost >= this.limitUsd) {
        this.halt = {
          reason: "budget_exceeded",
          message: `Spend limit of $${this.limitUsd.toFixed(2)} reached (spent $${this.totalCost.toFixed(2)}).`,
        }
        return this.halt
      }
    }

    return this.halt
  }

  recordFallbackUsage(usage: FallbackUsage): BudgetHalt | null {
    if (this.liveUsageRecorded) return this.halt
    if (this.halt) return this.halt

    const hasKnownCost = typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd)
    if (hasKnownCost) {
      const added = Math.max(0, usage.costUsd as number)
      this.totalCost = Math.round((this.totalCost + added) * 1e6) / 1e6
    }

    if (this.limitUsd !== null) {
      const tokensIn =
        typeof usage.tokensIn === "number" && Number.isFinite(usage.tokensIn) ? Math.max(0, usage.tokensIn) : 0
      const tokensOut =
        typeof usage.tokensOut === "number" && Number.isFinite(usage.tokensOut) ? Math.max(0, usage.tokensOut) : 0
      const hasTokens = tokensIn > 0 || tokensOut > 0

      // If a budget is configured and token usage occurred without known USD cost,
      // stop according to the strict guardrail policy.
      if (!hasKnownCost && hasTokens) {
        this.halt = {
          reason: "unpriced_usage_halt",
          message: `Unpriced token usage observed (${tokensIn} in, ${tokensOut} out) under configured spend limit of $${this.limitUsd.toFixed(2)}.`,
        }
        return this.halt
      }

      // Check if accumulated known spending reached or exceeded the configured limit.
      if (this.totalCost >= this.limitUsd) {
        this.halt = {
          reason: "budget_exceeded",
          message: `Spend limit of $${this.limitUsd.toFixed(2)} reached (spent $${this.totalCost.toFixed(2)}).`,
        }
        return this.halt
      }
    }

    return this.halt
  }
}
