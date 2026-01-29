/**
 * MoltAgent Bridge
 *
 * Persistent WebSocket connection between a running MoltAgent instance
 * and the LobeHub control plane. Handles:
 *
 * - Heartbeat (agent -> control plane)
 * - Status reports (agent -> control plane)
 * - Action log streaming (agent -> control plane)
 * - Commands from control plane (update config, restart, shutdown)
 * - Approval requests/responses (agent <-> control plane <-> human)
 *
 * The bridge auto-reconnects on disconnect with exponential backoff.
 */
import { WebSocket } from "ws";

import type { ControlPlane, MoltAgentManifest } from "./schema.js";

// -- Message Types --

/** Messages the agent sends to the control plane */
export type AgentMessage =
  | { type: "heartbeat"; agentId: string; timestamp: string; uptimeSec: number }
  | { type: "status"; agentId: string; status: AgentStatusReport }
  | { type: "action"; agentId: string; action: ActionLogEntry }
  | { type: "approval_request"; agentId: string; request: ApprovalRequest }
  | { type: "error"; agentId: string; error: string };

/** Messages the control plane sends to the agent */
export type ControlMessage =
  | { type: "update_config"; config: Partial<MoltAgentManifest> }
  | { type: "update_goals"; goals: MoltAgentManifest["goals"]["goals"] }
  | { type: "inject_knowledge"; documents: Array<{ title: string; content: string }> }
  | { type: "send_message"; content: string; channel?: string }
  | { type: "approval_response"; requestId: string; approved: boolean; reason?: string }
  | { type: "restart" }
  | { type: "shutdown" }
  | { type: "ping" };

export interface AgentStatusReport {
  state: "starting" | "running" | "busy" | "idle" | "error" | "shutting_down";
  activeTask?: string;
  channelsConnected: string[];
  uptimeSec: number;
  memoryUsageMb: number;
  cpuPercent: number;
  actionsToday: number;
  spendToday: number;
  goalProgress: Array<{ goalTitle: string; progress: number }>;
}

export interface ActionLogEntry {
  id: string;
  timestamp: string;
  category: "browse" | "execute" | "message" | "api_call" | "spend" | "file" | "other";
  summary: string;
  details?: Record<string, unknown>;
  durationMs?: number;
}

export interface ApprovalRequest {
  id: string;
  category: "spend" | "action" | "access";
  description: string;
  amount?: number;
  currency?: string;
  expiresAt: string;
}

// -- Bridge Implementation --

export interface BridgeCallbacks {
  onCommand(msg: ControlMessage): void;
  onConnected(): void;
  onDisconnected(reason: string): void;
}

export class MoltAgentBridge {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private maxReconnectDelay = 60_000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private startTime = Date.now();
  private closed = false;

  constructor(
    private agentId: string,
    private controlPlane: ControlPlane,
    private callbacks: BridgeCallbacks,
  ) {}

  connect(): void {
    if (this.closed) return;

    const url = `${this.controlPlane.url}?agentId=${this.agentId}`;
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.controlPlane.token}`,
      },
    });

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.startHeartbeat();
      this.callbacks.onConnected();
    });

    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ControlMessage;
        this.callbacks.onCommand(msg);
      } catch {
        // ignore malformed messages
      }
    });

    this.ws.on("close", (code, reason) => {
      this.stopHeartbeat();
      this.callbacks.onDisconnected(`code=${code} reason=${reason}`);
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      this.callbacks.onDisconnected(`error: ${err.message}`);
      // close handler will trigger reconnect
    });
  }

  send(msg: AgentMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  sendHeartbeat(): void {
    this.send({
      type: "heartbeat",
      agentId: this.agentId,
      timestamp: new Date().toISOString(),
      uptimeSec: Math.floor((Date.now() - this.startTime) / 1000),
    });
  }

  sendStatus(status: AgentStatusReport): void {
    this.send({ type: "status", agentId: this.agentId, status });
  }

  sendAction(action: ActionLogEntry): void {
    this.send({ type: "action", agentId: this.agentId, action });
  }

  async requestApproval(request: ApprovalRequest): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve(false); // deny on timeout
      }, 5 * 60 * 1000); // 5-minute approval window

      const handler = (msg: ControlMessage) => {
        if (
          msg.type === "approval_response" &&
          msg.requestId === request.id
        ) {
          cleanup();
          resolve(msg.approved);
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        // Remove the temporary handler by wrapping in the onCommand callback
        this.pendingApprovals.delete(request.id);
      };

      this.pendingApprovals.set(request.id, handler);
      this.send({
        type: "approval_request",
        agentId: this.agentId,
        request,
      });
    });
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
  }

  // -- Internal --

  private pendingApprovals = new Map<string, (msg: ControlMessage) => void>();

  /** Called from the onCommand callback to route approval responses */
  handleMessage(msg: ControlMessage): void {
    if (msg.type === "approval_response") {
      const handler = this.pendingApprovals.get(msg.requestId);
      handler?.(msg);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(
      () => this.sendHeartbeat(),
      this.controlPlane.heartbeatIntervalSec * 1000,
    );
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.reconnectAttempt++;
    // Exponential backoff: 1s, 2s, 4s, 8s, ... up to maxReconnectDelay
    const delay = Math.min(
      1000 * 2 ** (this.reconnectAttempt - 1),
      this.maxReconnectDelay,
    );
    setTimeout(() => this.connect(), delay);
  }
}
