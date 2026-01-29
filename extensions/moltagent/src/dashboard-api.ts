/**
 * Dashboard REST API
 *
 * Full REST API that the LobeHub dashboard UI calls to manage the fleet.
 * Covers: fleet overview, agent CRUD, action streams, approvals,
 * live commands, and manifest generation.
 *
 * All endpoints are under /moltagent/dashboard/* and require auth.
 */
import type { MoltAgentManifest } from "./schema.js";
import { moltAgentManifestSchema } from "./schema.js";
import { generateCloudInit } from "./cloud-init.js";
import type { MoltAgentProvisioner } from "./provisioner.js";
import type { FleetManager } from "./fleet.js";
import type { ApprovalManager } from "./approvals.js";
import type { ControlPlaneServer } from "./control-plane.js";

export interface DashboardDeps {
  fleet: FleetManager;
  provisioner: MoltAgentProvisioner;
  approvals: ApprovalManager;
  controlPlane: ControlPlaneServer;
  authToken: string;
}

interface Req {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
  query?: Record<string, string>;
}

interface Res {
  status: number;
  body: unknown;
}

function parseQuery(path: string): { clean: string; query: Record<string, string> } {
  const [clean, qs] = path.split("?", 2);
  const query: Record<string, string> = {};
  if (qs) {
    for (const pair of qs.split("&")) {
      const [k, v] = pair.split("=", 2);
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
    }
  }
  return { clean: clean ?? path, query };
}

export function createDashboardApi(deps: DashboardDeps) {
  const { fleet, provisioner, approvals, controlPlane, authToken } = deps;

  function checkAuth(req: Req): boolean {
    const auth = req.headers.authorization ?? req.headers.Authorization ?? "";
    return auth === `Bearer ${authToken}`;
  }

  return async (req: Req): Promise<Res> => {
    if (!checkAuth(req)) {
      return { status: 401, body: { error: "Unauthorized" } };
    }

    const { clean: path, query } = parseQuery(
      req.path.replace(/^\/moltagent\/dashboard/, "") || "/",
    );
    const method = req.method.toUpperCase();

    // ─── Fleet Overview ─────────────────────────────────────────

    // GET /overview - Fleet summary
    if (method === "GET" && path === "/overview") {
      const summary = fleet.getFleetSummary();
      const approvalSummary = approvals.getSummary();
      const onlineAgentIds = controlPlane.getConnectedAgentIds();
      return {
        status: 200,
        body: {
          fleet: summary,
          approvals: approvalSummary,
          onlineAgentIds,
        },
      };
    }

    // ─── Agent CRUD ─────────────────────────────────────────────

    // GET /agents - List all agents with status
    if (method === "GET" && path === "/agents") {
      const agents = fleet.getAllAgents().map((record) => ({
        id: record.manifest.identity.id,
        name: record.manifest.identity.name,
        description: record.manifest.identity.description,
        tags: record.manifest.identity.tags,
        connection: record.connection,
        lastHeartbeat: record.lastHeartbeat,
        uptimeSec: record.uptimeSec,
        totalActions: record.totalActions,
        totalSpend: record.totalSpend,
        deployedAt: record.deployedAt,
        state: record.lastStatus?.state ?? "unknown",
        activeTask: record.lastStatus?.activeTask,
        capabilities: {
          webBrowsing: record.manifest.capabilities.webBrowsing,
          codeExecution: record.manifest.capabilities.codeExecution,
          terminalAccess: record.manifest.capabilities.terminalAccess,
        },
        channelCount: record.manifest.channels.channels.length,
        goalCount: record.manifest.goals.goals.length,
      }));
      return { status: 200, body: { agents } };
    }

    // GET /agents/:id - Full agent detail
    if (method === "GET" && path.match(/^\/agents\/[^/]+$/)) {
      const agentId = path.replace("/agents/", "");
      const record = fleet.getAgent(agentId);
      if (!record) return { status: 404, body: { error: "Agent not found" } };

      // Redact secrets
      const manifest = {
        ...record.manifest,
        controlPlane: { ...record.manifest.controlPlane, token: "***" },
        channels: {
          channels: record.manifest.channels.channels.map((ch) => ({
            ...ch,
            credentials: Object.fromEntries(
              Object.keys(ch.credentials).map((k) => [k, "***"]),
            ),
          })),
        },
      };

      return {
        status: 200,
        body: {
          ...record,
          manifest,
          online: controlPlane.isAgentOnline(agentId),
          pendingApprovals: approvals.getPending(agentId).length,
        },
      };
    }

    // POST /agents - Deploy a new agent
    if (method === "POST" && path === "/agents") {
      const parsed = moltAgentManifestSchema.safeParse(req.body);
      if (!parsed.success) {
        return {
          status: 400,
          body: { error: "Invalid manifest", details: parsed.error.issues },
        };
      }

      const manifest = parsed.data;
      const cloudInit = generateCloudInit(manifest);
      const result = await provisioner.provision(manifest, cloudInit);

      if (!result.success) {
        return { status: 500, body: { error: result.error } };
      }

      fleet.registerAgent(manifest, result.instance ?? null);

      return {
        status: 201,
        body: {
          agentId: manifest.identity.id,
          instance: result.instance,
        },
      };
    }

    // DELETE /agents/:id - Destroy an agent
    if (method === "DELETE" && path.match(/^\/agents\/[^/]+$/)) {
      const agentId = path.replace("/agents/", "");

      // Tell agent to shut down gracefully
      controlPlane.sendToAgent(agentId, { type: "shutdown" });

      // Destroy VPS
      const result = await provisioner.destroy(agentId);
      fleet.removeAgent(agentId);

      return {
        status: 200,
        body: { ok: true, destroyResult: result },
      };
    }

    // ─── Agent Actions & Logs ───────────────────────────────────

    // GET /agents/:id/actions - Action log for an agent
    if (method === "GET" && path.match(/^\/agents\/[^/]+\/actions$/)) {
      const agentId = path.replace("/agents/", "").replace("/actions", "");
      const limit = Number(query.limit) || 50;
      const offset = Number(query.offset) || 0;
      const actions = fleet.getAgentActions(agentId, limit, offset);
      return { status: 200, body: { actions, limit, offset } };
    }

    // ─── Agent Commands ─────────────────────────────────────────

    // POST /agents/:id/message - Send a message/instruction to the agent
    if (method === "POST" && path.match(/^\/agents\/[^/]+\/message$/)) {
      const agentId = path.replace("/agents/", "").replace("/message", "");
      const { content, channel } = req.body as {
        content?: string;
        channel?: string;
      };
      if (!content) {
        return { status: 400, body: { error: "content is required" } };
      }
      const sent = controlPlane.sendToAgent(agentId, {
        type: "send_message",
        content,
        channel,
      });
      return {
        status: sent ? 200 : 503,
        body: { sent, agentOnline: controlPlane.isAgentOnline(agentId) },
      };
    }

    // POST /agents/:id/goals - Update agent goals/OKRs
    if (method === "POST" && path.match(/^\/agents\/[^/]+\/goals$/)) {
      const agentId = path.replace("/agents/", "").replace("/goals", "");
      const { goals } = req.body as { goals?: unknown[] };
      if (!Array.isArray(goals)) {
        return { status: 400, body: { error: "goals array required" } };
      }
      const sent = controlPlane.sendToAgent(agentId, {
        type: "update_goals",
        goals: goals as MoltAgentManifest["goals"]["goals"],
      });
      return { status: sent ? 200 : 503, body: { sent } };
    }

    // POST /agents/:id/knowledge - Inject knowledge into agent
    if (method === "POST" && path.match(/^\/agents\/[^/]+\/knowledge$/)) {
      const agentId = path.replace("/agents/", "").replace("/knowledge", "");
      const { documents } = req.body as {
        documents?: Array<{ title: string; content: string }>;
      };
      if (!Array.isArray(documents)) {
        return { status: 400, body: { error: "documents array required" } };
      }
      const sent = controlPlane.sendToAgent(agentId, {
        type: "inject_knowledge",
        documents,
      });
      return { status: sent ? 200 : 503, body: { sent } };
    }

    // POST /agents/:id/restart - Restart agent
    if (method === "POST" && path.match(/^\/agents\/[^/]+\/restart$/)) {
      const agentId = path.replace("/agents/", "").replace("/restart", "");
      const sent = controlPlane.sendToAgent(agentId, { type: "restart" });
      return { status: sent ? 200 : 503, body: { sent } };
    }

    // ─── Approvals ──────────────────────────────────────────────

    // GET /approvals - List pending approvals
    if (method === "GET" && path === "/approvals") {
      const agentId = query.agentId;
      const pending = approvals.getPending(agentId);
      return { status: 200, body: { approvals: pending } };
    }

    // GET /approvals/history - Approval history
    if (method === "GET" && path === "/approvals/history") {
      const limit = Number(query.limit) || 50;
      const offset = Number(query.offset) || 0;
      const history = approvals.getHistory(limit, offset);
      return { status: 200, body: { history, limit, offset } };
    }

    // POST /approvals/:id/respond - Approve or deny
    if (method === "POST" && path.match(/^\/approvals\/[^/]+\/respond$/)) {
      const requestId = path.replace("/approvals/", "").replace("/respond", "");
      const { approved, reason, respondedBy } = req.body as {
        approved?: boolean;
        reason?: string;
        respondedBy?: string;
      };

      if (typeof approved !== "boolean") {
        return { status: 400, body: { error: "approved (boolean) is required" } };
      }

      const approval = approvals.resolve(
        requestId,
        approved,
        respondedBy ?? "dashboard",
        reason,
      );
      if (!approval) {
        return { status: 404, body: { error: "Approval not found or already resolved" } };
      }

      // Relay response to agent
      controlPlane.sendApprovalResponse(
        approval.agentId,
        requestId,
        approved,
        reason,
      );

      return { status: 200, body: { approval } };
    }

    // ─── 404 ────────────────────────────────────────────────────

    return {
      status: 404,
      body: { error: `Unknown route: ${method} ${path}` },
    };
  };
}
