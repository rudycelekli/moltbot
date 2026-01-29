/**
 * Approval Manager
 *
 * Handles approval workflows for MoltAgent actions that require
 * human authorization (spend above threshold, sensitive actions, etc.).
 *
 * Flow:
 * 1. Agent sends approval_request via bridge
 * 2. Control plane stores it in the queue
 * 3. LobeHub dashboard shows pending approvals
 * 4. User approves/denies via dashboard
 * 5. Response is relayed back to the agent via bridge
 *
 * Approvals auto-expire after the timeout (default 5 minutes).
 */

export interface PendingApproval {
  /** Unique request ID */
  id: string;
  /** Agent that requested approval */
  agentId: string;
  /** Category: spend, action, or access */
  category: "spend" | "action" | "access";
  /** Human-readable description */
  description: string;
  /** Amount in USD (for spend requests) */
  amount?: number;
  /** Currency (for spend requests) */
  currency?: string;
  /** When the request was created */
  createdAt: string;
  /** When the request expires */
  expiresAt: string;
  /** Current state */
  state: "pending" | "approved" | "denied" | "expired";
  /** Who responded (user ID or "auto") */
  respondedBy?: string;
  /** Response reason */
  reason?: string;
  /** When the response was given */
  respondedAt?: string;
}

export interface ApprovalCallbacks {
  /** Called when a new approval is added (for push notifications) */
  onNewApproval?: (approval: PendingApproval) => void;
  /** Called when an approval is resolved (to relay back to agent) */
  onResolved?: (approval: PendingApproval) => void;
}

export class ApprovalManager {
  private queue = new Map<string, PendingApproval>();
  private history: PendingApproval[] = [];
  private expiryTimer: ReturnType<typeof setInterval>;

  /** Max history entries to keep */
  private maxHistory = 1000;

  constructor(private callbacks: ApprovalCallbacks = {}) {
    // Check for expired approvals every 10 seconds
    this.expiryTimer = setInterval(() => this.expireStale(), 10_000);
  }

  addRequest(
    agentId: string,
    request: {
      id: string;
      category: "spend" | "action" | "access";
      description: string;
      amount?: number;
      currency?: string;
      expiresAt: string;
    },
  ): PendingApproval {
    const approval: PendingApproval = {
      ...request,
      agentId,
      createdAt: new Date().toISOString(),
      state: "pending",
    };
    this.queue.set(request.id, approval);
    this.callbacks.onNewApproval?.(approval);
    return approval;
  }

  resolve(
    requestId: string,
    approved: boolean,
    respondedBy: string,
    reason?: string,
  ): PendingApproval | null {
    const approval = this.queue.get(requestId);
    if (!approval || approval.state !== "pending") return null;

    approval.state = approved ? "approved" : "denied";
    approval.respondedBy = respondedBy;
    approval.reason = reason;
    approval.respondedAt = new Date().toISOString();

    this.queue.delete(requestId);
    this.addToHistory(approval);
    this.callbacks.onResolved?.(approval);

    return approval;
  }

  getApproval(requestId: string): PendingApproval | undefined {
    return this.queue.get(requestId);
  }

  /** Get all pending approvals, optionally filtered by agent */
  getPending(agentId?: string): PendingApproval[] {
    const all = [...this.queue.values()].filter((a) => a.state === "pending");
    return agentId ? all.filter((a) => a.agentId === agentId) : all;
  }

  /** Get approval history (resolved + expired) */
  getHistory(limit = 50, offset = 0): PendingApproval[] {
    return this.history.slice(offset, offset + limit);
  }

  /** Get summary stats */
  getSummary(): {
    pending: number;
    approvedToday: number;
    deniedToday: number;
    expiredToday: number;
    totalSpendApprovedToday: number;
  } {
    const today = new Date().toISOString().slice(0, 10);
    const todayHistory = this.history.filter(
      (a) => a.respondedAt?.startsWith(today) || a.createdAt.startsWith(today),
    );

    return {
      pending: this.queue.size,
      approvedToday: todayHistory.filter((a) => a.state === "approved").length,
      deniedToday: todayHistory.filter((a) => a.state === "denied").length,
      expiredToday: todayHistory.filter((a) => a.state === "expired").length,
      totalSpendApprovedToday: todayHistory
        .filter((a) => a.state === "approved" && a.category === "spend")
        .reduce((sum, a) => sum + (a.amount ?? 0), 0),
    };
  }

  private expireStale(): void {
    const now = Date.now();
    for (const [id, approval] of this.queue) {
      if (approval.state === "pending" && new Date(approval.expiresAt).getTime() < now) {
        approval.state = "expired";
        this.queue.delete(id);
        this.addToHistory(approval);
        this.callbacks.onResolved?.(approval);
      }
    }
  }

  private addToHistory(approval: PendingApproval): void {
    this.history.unshift(approval);
    if (this.history.length > this.maxHistory) {
      this.history.length = this.maxHistory;
    }
  }

  close(): void {
    clearInterval(this.expiryTimer);
  }
}
