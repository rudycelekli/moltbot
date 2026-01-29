/**
 * MoltAgent Control Plane
 *
 * WebSocket server that running MoltAgent instances connect back to.
 * This is the "hub" that LobeHub talks to for managing the fleet.
 *
 * Architecture:
 *   LobeHub UI <--REST--> Control Plane <--WebSocket--> MoltAgent VPS instances
 *
 * The control plane:
 * - Accepts authenticated WebSocket connections from agents
 * - Tracks agent state (online, offline, busy, idle)
 * - Relays commands from LobeHub to agents
 * - Collects action logs and status reports
 * - Manages the approval queue
 */
import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";

import type { AgentMessage, ControlMessage } from "./bridge.js";
import type { FleetManager, AgentRecord } from "./fleet.js";
import type { ApprovalManager } from "./approvals.js";

export interface ControlPlaneConfig {
  /** Path prefix for the WebSocket upgrade (e.g. "/moltagent/ws") */
  wsPath: string;
  /** Token that agents must present to connect */
  authToken: string;
}

export interface ConnectedAgent {
  agentId: string;
  ws: WebSocket;
  connectedAt: Date;
  lastHeartbeat: Date;
  remoteAddress: string;
}

export class ControlPlaneServer {
  private wss: WebSocketServer | null = null;
  private agents = new Map<string, ConnectedAgent>();

  constructor(
    private config: ControlPlaneConfig,
    private fleet: FleetManager,
    private approvals: ApprovalManager,
  ) {}

  /**
   * Attach to an existing HTTP server (the moltbot gateway).
   * Handles WebSocket upgrade requests at the configured path.
   */
  attach(httpServer: Server): void {
    this.wss = new WebSocketServer({ noServer: true });

    httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (!url.pathname.startsWith(this.config.wsPath)) return;

      // Auth check
      const token =
        url.searchParams.get("token") ??
        req.headers.authorization?.replace("Bearer ", "");

      if (token !== this.config.authToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const agentId = url.searchParams.get("agentId");
      if (!agentId) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.handleConnection(ws, agentId, req);
      });
    });
  }

  /**
   * Start a standalone WebSocket server (for development without gateway).
   */
  startStandalone(port: number): void {
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const agentId = url.searchParams.get("agentId") ?? "";
      const token = url.searchParams.get("token") ?? "";

      if (token !== this.config.authToken || !agentId) {
        ws.close(4001, "Unauthorized");
        return;
      }

      this.handleConnection(ws, agentId, req);
    });
    console.log(`[control-plane] WebSocket server listening on port ${port}`);
  }

  private handleConnection(
    ws: WebSocket,
    agentId: string,
    req: IncomingMessage,
  ): void {
    const remoteAddress =
      req.socket.remoteAddress ?? "unknown";

    const conn: ConnectedAgent = {
      agentId,
      ws,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      remoteAddress,
    };

    // Replace existing connection if agent reconnects
    const existing = this.agents.get(agentId);
    if (existing) {
      existing.ws.close(4000, "Replaced by new connection");
    }

    this.agents.set(agentId, conn);
    this.fleet.updateAgentConnection(agentId, "online", remoteAddress);
    console.log(
      `[control-plane] Agent connected: ${agentId} from ${remoteAddress}`,
    );

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as AgentMessage;
        this.handleAgentMessage(agentId, msg);
      } catch {
        // ignore malformed
      }
    });

    ws.on("close", () => {
      if (this.agents.get(agentId)?.ws === ws) {
        this.agents.delete(agentId);
        this.fleet.updateAgentConnection(agentId, "offline");
        console.log(`[control-plane] Agent disconnected: ${agentId}`);
      }
    });

    ws.on("error", (err) => {
      console.error(`[control-plane] Agent ${agentId} error: ${err.message}`);
    });
  }

  private handleAgentMessage(agentId: string, msg: AgentMessage): void {
    switch (msg.type) {
      case "heartbeat": {
        const conn = this.agents.get(agentId);
        if (conn) conn.lastHeartbeat = new Date();
        this.fleet.updateHeartbeat(agentId, msg.uptimeSec);
        break;
      }
      case "status":
        this.fleet.updateAgentStatus(agentId, msg.status);
        break;
      case "action":
        this.fleet.recordAction(agentId, msg.action);
        break;
      case "approval_request":
        this.approvals.addRequest(agentId, msg.request);
        break;
      case "error":
        this.fleet.recordError(agentId, msg.error);
        break;
    }
  }

  // -- Commands to agents (called by dashboard API) --

  sendToAgent(agentId: string, msg: ControlMessage): boolean {
    const conn = this.agents.get(agentId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;
    conn.ws.send(JSON.stringify(msg));
    return true;
  }

  sendApprovalResponse(
    agentId: string,
    requestId: string,
    approved: boolean,
    reason?: string,
  ): boolean {
    return this.sendToAgent(agentId, {
      type: "approval_response",
      requestId,
      approved,
      reason,
    });
  }

  isAgentOnline(agentId: string): boolean {
    const conn = this.agents.get(agentId);
    return conn?.ws.readyState === WebSocket.OPEN;
  }

  getConnectedAgents(): ConnectedAgent[] {
    return [...this.agents.values()];
  }

  getConnectedAgentIds(): string[] {
    return [...this.agents.keys()];
  }

  close(): void {
    for (const conn of this.agents.values()) {
      conn.ws.close(1001, "Control plane shutting down");
    }
    this.agents.clear();
    this.wss?.close();
  }
}
