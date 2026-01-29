/**
 * MoltAgent Management API
 *
 * Gateway routes exposed by the MoltAgent extension for:
 * 1. Provisioning side: create/destroy/list agents (called by LobeHub)
 * 2. Running agent side: status, logs, config updates (called by control plane)
 *
 * All routes are prefixed with /moltagent/ and require bearer auth.
 */
import type { MoltAgentManifest } from "./schema.js";
import { moltAgentManifestSchema } from "./schema.js";
import { generateCloudInit } from "./cloud-init.js";
import type { MoltAgentProvisioner } from "./provisioner.js";

// -- Route Handlers --

export interface ApiDeps {
  provisioner: MoltAgentProvisioner;
  getManifest: () => MoltAgentManifest | null;
  getBridgeStatus: () => { connected: boolean; lastHeartbeat: string | null };
  authToken: string;
}

export interface ApiRequest {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

function unauthorized(): ApiResponse {
  return { status: 401, body: { error: "Unauthorized" } };
}

function checkAuth(req: ApiRequest, token: string): boolean {
  const auth = req.headers.authorization ?? req.headers.Authorization ?? "";
  return auth === `Bearer ${token}`;
}

/**
 * Creates the route handler for the moltagent API.
 * Register with: api.registerGatewayRoute("/moltagent", handler)
 */
export function createApiHandler(deps: ApiDeps) {
  return async (req: ApiRequest): Promise<ApiResponse> => {
    if (!checkAuth(req, deps.authToken)) return unauthorized();

    const { method, path, body } = req;

    // -- Provisioning routes (called from LobeHub control plane) --

    // POST /moltagent/agents - Provision a new MoltAgent
    if (method === "POST" && path === "/agents") {
      const parsed = moltAgentManifestSchema.safeParse(body);
      if (!parsed.success) {
        return {
          status: 400,
          body: { error: "Invalid manifest", details: parsed.error.issues },
        };
      }
      const manifest = parsed.data;
      const cloudInit = generateCloudInit(manifest);
      const result = await deps.provisioner.provision(manifest, cloudInit);

      if (!result.success) {
        return { status: 500, body: { error: result.error } };
      }
      return { status: 201, body: { instance: result.instance } };
    }

    // DELETE /moltagent/agents/:id - Destroy a MoltAgent
    if (method === "DELETE" && path.startsWith("/agents/")) {
      const agentId = path.replace("/agents/", "");
      const result = await deps.provisioner.destroy(agentId);
      if (!result.success) {
        return { status: 500, body: { error: result.error } };
      }
      return { status: 200, body: { ok: true } };
    }

    // GET /moltagent/agents - List all MoltAgent instances
    if (method === "GET" && path === "/agents") {
      const instances = deps.provisioner.listInstances();
      return { status: 200, body: { instances } };
    }

    // GET /moltagent/agents/:id - Get status of a specific agent
    if (method === "GET" && path.startsWith("/agents/")) {
      const agentId = path.replace("/agents/", "");
      const instance = await deps.provisioner.getStatus(agentId);
      if (!instance) {
        return { status: 404, body: { error: "Agent not found" } };
      }
      return { status: 200, body: { instance } };
    }

    // -- Running agent routes (called on the agent's own VPS) --

    // GET /moltagent/status - Self-status of this running agent
    if (method === "GET" && path === "/status") {
      const manifest = deps.getManifest();
      const bridge = deps.getBridgeStatus();
      return {
        status: 200,
        body: {
          agentId: manifest?.identity.id ?? null,
          agentName: manifest?.identity.name ?? null,
          bridgeConnected: bridge.connected,
          lastHeartbeat: bridge.lastHeartbeat,
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage(),
        },
      };
    }

    // GET /moltagent/manifest - Get current manifest (redacted secrets)
    if (method === "GET" && path === "/manifest") {
      const manifest = deps.getManifest();
      if (!manifest) {
        return { status: 404, body: { error: "No manifest loaded" } };
      }
      // Redact sensitive fields
      const redacted = {
        ...manifest,
        controlPlane: {
          ...manifest.controlPlane,
          token: "***",
        },
        channels: {
          channels: manifest.channels.channels.map((ch) => ({
            ...ch,
            credentials: Object.fromEntries(
              Object.keys(ch.credentials).map((k) => [k, "***"]),
            ),
          })),
        },
      };
      return { status: 200, body: { manifest: redacted } };
    }

    // GET /moltagent/health - Simple health check
    if (method === "GET" && path === "/health") {
      return { status: 200, body: { ok: true, timestamp: new Date().toISOString() } };
    }

    return { status: 404, body: { error: `Unknown route: ${method} /moltagent${path}` } };
  };
}
