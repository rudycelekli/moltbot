/**
 * Fleet Manager
 *
 * Tracks the state of all deployed MoltAgent instances.
 * Persists to a local JSON file so state survives restarts.
 * Stores: agent records, action logs, errors, connection status.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

import type { MoltAgentManifest } from "./schema.js";
import type { VpsInstance } from "./provisioner.js";
import type { ActionLogEntry, AgentStatusReport } from "./bridge.js";

// -- Types --

export interface AgentRecord {
  /** Agent manifest (full) */
  manifest: MoltAgentManifest;
  /** VPS instance info (if provisioned) */
  instance: VpsInstance | null;
  /** Connection status */
  connection: "online" | "offline" | "unknown";
  /** Remote IP when connected */
  remoteAddress: string;
  /** Last known runtime status */
  lastStatus: AgentStatusReport | null;
  /** When the agent was deployed */
  deployedAt: string;
  /** Last heartbeat timestamp */
  lastHeartbeat: string | null;
  /** Uptime in seconds (from last heartbeat) */
  uptimeSec: number;
  /** Recent actions (ring buffer, newest first) */
  recentActions: ActionLogEntry[];
  /** Recent errors */
  recentErrors: Array<{ timestamp: string; message: string }>;
  /** Total actions since deploy */
  totalActions: number;
  /** Total spend since deploy */
  totalSpend: number;
}

export interface FleetSnapshot {
  version: 1;
  updatedAt: string;
  agents: Record<string, AgentRecord>;
}

// -- Fleet Manager --

const MAX_RECENT_ACTIONS = 200;
const MAX_RECENT_ERRORS = 50;

export class FleetManager {
  private agents = new Map<string, AgentRecord>();
  private dirty = false;
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private storagePath: string) {
    this.load();
    // Auto-save every 30 seconds if dirty
    this.saveTimer = setInterval(() => {
      if (this.dirty) this.save();
    }, 30_000);
  }

  // -- Agent Lifecycle --

  registerAgent(manifest: MoltAgentManifest, instance: VpsInstance | null): void {
    const existing = this.agents.get(manifest.identity.id);
    const record: AgentRecord = {
      manifest,
      instance,
      connection: "unknown",
      remoteAddress: "",
      lastStatus: null,
      deployedAt: existing?.deployedAt ?? new Date().toISOString(),
      lastHeartbeat: null,
      uptimeSec: 0,
      recentActions: existing?.recentActions ?? [],
      recentErrors: existing?.recentErrors ?? [],
      totalActions: existing?.totalActions ?? 0,
      totalSpend: existing?.totalSpend ?? 0,
    };
    this.agents.set(manifest.identity.id, record);
    this.markDirty();
  }

  removeAgent(agentId: string): boolean {
    const deleted = this.agents.delete(agentId);
    if (deleted) this.markDirty();
    return deleted;
  }

  getAgent(agentId: string): AgentRecord | undefined {
    return this.agents.get(agentId);
  }

  getAllAgents(): AgentRecord[] {
    return [...this.agents.values()];
  }

  getAgentCount(): number {
    return this.agents.size;
  }

  // -- Connection updates (called by control plane) --

  updateAgentConnection(
    agentId: string,
    connection: "online" | "offline",
    remoteAddress?: string,
  ): void {
    const record = this.agents.get(agentId);
    if (!record) return;
    record.connection = connection;
    if (remoteAddress) record.remoteAddress = remoteAddress;
    this.markDirty();
  }

  updateHeartbeat(agentId: string, uptimeSec: number): void {
    const record = this.agents.get(agentId);
    if (!record) return;
    record.lastHeartbeat = new Date().toISOString();
    record.uptimeSec = uptimeSec;
    this.markDirty();
  }

  updateAgentStatus(agentId: string, status: AgentStatusReport): void {
    const record = this.agents.get(agentId);
    if (!record) return;
    record.lastStatus = status;
    this.markDirty();
  }

  // -- Action logging --

  recordAction(agentId: string, action: ActionLogEntry): void {
    const record = this.agents.get(agentId);
    if (!record) return;
    record.recentActions.unshift(action);
    if (record.recentActions.length > MAX_RECENT_ACTIONS) {
      record.recentActions.length = MAX_RECENT_ACTIONS;
    }
    record.totalActions++;
    // Track spend
    if (action.category === "spend" && action.details?.amount) {
      record.totalSpend += Number(action.details.amount) || 0;
    }
    this.markDirty();
  }

  recordError(agentId: string, message: string): void {
    const record = this.agents.get(agentId);
    if (!record) return;
    record.recentErrors.unshift({
      timestamp: new Date().toISOString(),
      message,
    });
    if (record.recentErrors.length > MAX_RECENT_ERRORS) {
      record.recentErrors.length = MAX_RECENT_ERRORS;
    }
    this.markDirty();
  }

  // -- Queries --

  getOnlineAgents(): AgentRecord[] {
    return this.getAllAgents().filter((a) => a.connection === "online");
  }

  getFleetSummary(): {
    total: number;
    online: number;
    offline: number;
    totalActions: number;
    totalSpend: number;
  } {
    const all = this.getAllAgents();
    return {
      total: all.length,
      online: all.filter((a) => a.connection === "online").length,
      offline: all.filter((a) => a.connection === "offline").length,
      totalActions: all.reduce((sum, a) => sum + a.totalActions, 0),
      totalSpend: all.reduce((sum, a) => sum + a.totalSpend, 0),
    };
  }

  getAgentActions(
    agentId: string,
    limit = 50,
    offset = 0,
  ): ActionLogEntry[] {
    const record = this.agents.get(agentId);
    if (!record) return [];
    return record.recentActions.slice(offset, offset + limit);
  }

  // -- Persistence --

  private load(): void {
    try {
      const raw = readFileSync(this.storagePath, "utf-8");
      const snapshot = JSON.parse(raw) as FleetSnapshot;
      if (snapshot.version === 1) {
        for (const [id, record] of Object.entries(snapshot.agents)) {
          // Mark all agents as offline on startup (they'll reconnect)
          record.connection = "offline";
          this.agents.set(id, record);
        }
      }
    } catch {
      // File doesn't exist or is corrupt, start fresh
    }
  }

  save(): void {
    const snapshot: FleetSnapshot = {
      version: 1,
      updatedAt: new Date().toISOString(),
      agents: Object.fromEntries(this.agents),
    };
    try {
      mkdirSync(dirname(this.storagePath), { recursive: true });
      writeFileSync(this.storagePath, JSON.stringify(snapshot, null, 2));
      this.dirty = false;
    } catch (err) {
      console.error(`[fleet] Failed to save: ${err}`);
    }
  }

  private markDirty(): void {
    this.dirty = true;
  }

  close(): void {
    if (this.saveTimer) clearInterval(this.saveTimer);
    if (this.dirty) this.save();
  }
}
