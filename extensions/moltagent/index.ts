/**
 * MoltAgent Extension
 *
 * Enables MoltBot to run as an autonomous agent on a dedicated VPS,
 * managed from a LobeHub control plane. Core features:
 *
 * 1. Agent Manifest - schema for defining deployable agents
 * 2. VPS Provisioning - spin up/down Hetzner or Docker instances
 * 3. Bridge - WebSocket connection back to LobeHub for monitoring/control
 * 4. Control Plane - WebSocket server that agents connect to
 * 5. Fleet Manager - tracks all deployed agents with persistence
 * 6. Approval System - human-in-the-loop for spend/sensitive actions
 * 7. Dashboard - web UI + REST API for managing the fleet
 * 8. LobeHub Integration - converts LobeHub agents to MoltAgent manifests
 *
 * Three operating modes:
 * - ORCHESTRATOR mode: runs the control plane, provisions and manages agents
 * - AGENT mode: runs on a VPS, connects bridge to control plane
 * - HYBRID mode: both (single-node dev/testing)
 *
 * Mode is determined by environment:
 * - MOLTAGENT_MANIFEST=/path -> AGENT mode
 * - MOLTAGENT_CONTROL_PLANE=1 -> ORCHESTRATOR mode
 * - Both set -> HYBRID mode
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { moltAgentManifestSchema } from "./src/schema.js";
import type { MoltAgentManifest } from "./src/schema.js";
import { MoltAgentProvisioner, registerProvider } from "./src/provisioner.js";
import { createHetznerProvider } from "./src/providers/hetzner.js";
import { createDockerLocalProvider } from "./src/providers/docker-local.js";
import { MoltAgentBridge } from "./src/bridge.js";
import type { ControlMessage } from "./src/bridge.js";
import { createApiHandler } from "./src/api.js";
import { ControlPlaneServer } from "./src/control-plane.js";
import { FleetManager } from "./src/fleet.js";
import { ApprovalManager } from "./src/approvals.js";
import { createDashboardApi } from "./src/dashboard-api.js";

const plugin = {
  id: "moltagent",
  name: "MoltAgent",
  description:
    "Provision and manage autonomous MoltBot agents on dedicated VPS instances",
  kind: "infra",
  configSchema: emptyPluginConfigSchema(),

  register(api: MoltbotPluginApi) {
    const pluginConfig = (api.runtime?.config?.plugins?.moltagent ?? {}) as Record<string, string>;
    const authToken =
      pluginConfig.controlPlaneToken ??
      process.env.MOLTAGENT_API_TOKEN ??
      "";

    // Determine operating mode
    const manifestPath = process.env.MOLTAGENT_MANIFEST;
    const isControlPlane =
      process.env.MOLTAGENT_CONTROL_PLANE === "1" || !!authToken;
    const isAgentMode = !!manifestPath;

    let manifest: MoltAgentManifest | null = null;
    let bridge: MoltAgentBridge | null = null;
    let bridgeConnected = false;
    let lastHeartbeat: string | null = null;

    // ================================================================
    // AGENT MODE: Running on a VPS with a manifest
    // ================================================================
    if (isAgentMode) {
      try {
        const raw = readFileSync(manifestPath, "utf-8");
        const parsed = moltAgentManifestSchema.parse(JSON.parse(raw));
        manifest = parsed;

        bridge = new MoltAgentBridge(
          manifest.identity.id,
          manifest.controlPlane,
          {
            onConnected() {
              bridgeConnected = true;
              lastHeartbeat = new Date().toISOString();
              console.log(
                `[moltagent] Bridge connected to ${manifest!.controlPlane.url}`,
              );
            },
            onDisconnected(reason) {
              bridgeConnected = false;
              console.log(`[moltagent] Bridge disconnected: ${reason}`);
            },
            onCommand(msg: ControlMessage) {
              bridge?.handleMessage(msg);
              handleControlCommand(msg, api);
            },
          },
        );

        bridge.connect();
        console.log(
          `[moltagent] Agent mode: ${manifest.identity.name} (${manifest.identity.id})`,
        );
      } catch (err) {
        console.error(`[moltagent] Failed to load manifest: ${err}`);
      }
    }

    // ================================================================
    // ORCHESTRATOR MODE: Control plane + fleet management
    // ================================================================

    // -- Providers --
    const hetznerToken =
      pluginConfig.hetznerApiToken ?? process.env.HETZNER_API_TOKEN;

    if (hetznerToken) {
      registerProvider(
        createHetznerProvider({
          apiToken: hetznerToken,
          defaultServerType: pluginConfig.defaultServerType ?? "cpx21",
          defaultRegion: pluginConfig.defaultRegion ?? "nbg1",
          defaultImage: "ubuntu-24.04",
        }),
      );
    }
    registerProvider(createDockerLocalProvider());

    const defaultProvider = hetznerToken ? "hetzner" : "docker-local";
    const provisioner = new MoltAgentProvisioner(defaultProvider);

    // -- Fleet Manager --
    const dataDir = process.env.MOLTAGENT_DATA_DIR ??
      join(process.env.HOME ?? "/tmp", ".clawdbot", "moltagent");
    const fleet = new FleetManager(join(dataDir, "fleet.json"));

    // -- Approval Manager --
    let controlPlane: ControlPlaneServer | null = null;
    const approvals = new ApprovalManager({
      onNewApproval(approval) {
        console.log(
          `[moltagent] New approval request: ${approval.id} from ${approval.agentId} - ${approval.description}`,
        );
      },
      onResolved(approval) {
        // Relay approval response back to agent via control plane
        if (controlPlane) {
          controlPlane.sendApprovalResponse(
            approval.agentId,
            approval.id,
            approval.state === "approved",
            approval.reason,
          );
        }
      },
    });

    // -- Control Plane Server --
    if (isControlPlane && authToken) {
      controlPlane = new ControlPlaneServer(
        { wsPath: "/moltagent/ws", authToken },
        fleet,
        approvals,
      );

      // Attach to the gateway HTTP server when it's available
      // The gateway exposes its http.Server via api.runtime
      const httpServer = (api.runtime as unknown as { httpServer?: import("node:http").Server })
        ?.httpServer;
      if (httpServer) {
        controlPlane.attach(httpServer);
        console.log("[moltagent] Control plane attached to gateway");
      } else {
        // Standalone mode: start on a separate port
        const cpPort = Number(process.env.MOLTAGENT_CP_PORT) || 18790;
        controlPlane.startStandalone(cpPort);
      }
    }

    // -- Register gateway API routes (basic agent management) --
    if (authToken) {
      const handler = createApiHandler({
        provisioner,
        getManifest: () => manifest,
        getBridgeStatus: () => ({ connected: bridgeConnected, lastHeartbeat }),
        authToken,
      });

      api.registerGatewayRoute("/moltagent", async (req: unknown) => {
        const r = req as {
          method: string;
          path: string;
          body: unknown;
          headers: Record<string, string>;
        };
        const path = r.path.replace(/^\/moltagent/, "") || "/";

        // Route dashboard requests to the dashboard API
        if (path.startsWith("/dashboard")) {
          if (!controlPlane) {
            return { status: 503, body: { error: "Control plane not active" } };
          }
          const dashboardHandler = createDashboardApi({
            fleet,
            provisioner,
            approvals,
            controlPlane,
            authToken,
          });
          return dashboardHandler({
            method: r.method,
            path: r.path,
            body: r.body,
            headers: r.headers,
          });
        }

        // Serve dashboard UI
        if (path === "/ui" || path === "/ui/") {
          try {
            const html = readFileSync(
              join(import.meta.dirname ?? __dirname, "src", "dashboard", "index.html"),
              "utf-8",
            );
            return {
              status: 200,
              body: html,
              headers: { "Content-Type": "text/html" },
            };
          } catch {
            return { status: 500, body: { error: "Dashboard UI not found" } };
          }
        }

        return handler({
          method: r.method,
          path,
          body: r.body,
          headers: r.headers,
        });
      });
    }

    // ================================================================
    // CLI COMMANDS
    // ================================================================
    api.registerCli(
      ({ program }) => {
        const cmd = program
          .command("moltagent")
          .description("Manage autonomous MoltAgent instances");

        cmd
          .command("provision")
          .description("Provision a new MoltAgent from a manifest file")
          .argument("<manifest-path>", "Path to the agent manifest JSON")
          .option("--provider <provider>", "VPS provider (hetzner, docker-local)")
          .action(async (path: string, opts: { provider?: string }) => {
            try {
              const raw = readFileSync(path, "utf-8");
              const m = moltAgentManifestSchema.parse(JSON.parse(raw));
              if (opts.provider) m.resources.provider = opts.provider;

              const { generateCloudInit } = await import("./src/cloud-init.js");
              const cloudInit = generateCloudInit(m);
              const result = await provisioner.provision(m, cloudInit);

              if (result.success) {
                fleet.registerAgent(m, result.instance ?? null);
                console.log(`Agent provisioned: ${result.instance?.id}`);
                console.log(`  Name: ${m.identity.name}`);
                console.log(`  IP: ${result.instance?.ipv4}`);
                console.log(`  Provider: ${result.instance?.provider}`);
                console.log(`  Status: ${result.instance?.status}`);
              } else {
                console.error(`Provisioning failed: ${result.error}`);
                process.exitCode = 1;
              }
            } catch (err) {
              console.error(`Error: ${err}`);
              process.exitCode = 1;
            }
          });

        cmd
          .command("list")
          .description("List all MoltAgent instances")
          .action(() => {
            const agents = fleet.getAllAgents();
            if (agents.length === 0) {
              console.log("No MoltAgent instances.");
              return;
            }
            console.log(
              `${"ID".padEnd(10)} ${"Name".padEnd(20)} ${"Status".padEnd(10)} ${"Connection".padEnd(12)} ${"Actions".padEnd(10)} Spend`,
            );
            console.log("-".repeat(80));
            for (const agent of agents) {
              const id = agent.manifest.identity.id.slice(0, 8);
              const name = agent.manifest.identity.name.slice(0, 18);
              const status = agent.lastStatus?.state ?? "unknown";
              console.log(
                `${id.padEnd(10)} ${name.padEnd(20)} ${status.padEnd(10)} ${agent.connection.padEnd(12)} ${String(agent.totalActions).padEnd(10)} $${agent.totalSpend.toFixed(2)}`,
              );
            }
          });

        cmd
          .command("destroy")
          .description("Destroy a MoltAgent instance")
          .argument("<agent-id>", "Agent ID to destroy")
          .action(async (agentId: string) => {
            // Send shutdown command if online
            controlPlane?.sendToAgent(agentId, { type: "shutdown" });
            const result = await provisioner.destroy(agentId);
            fleet.removeAgent(agentId);
            if (result.success) {
              console.log(`Agent ${agentId} destroyed.`);
            } else {
              console.error(`Destroy failed: ${result.error}`);
              process.exitCode = 1;
            }
          });

        cmd
          .command("status")
          .description("Show status of this MoltAgent or the fleet")
          .action(() => {
            if (manifest) {
              // Agent mode
              console.log(`Agent: ${manifest.identity.name}`);
              console.log(`ID: ${manifest.identity.id}`);
              console.log(`Bridge: ${bridgeConnected ? "connected" : "disconnected"}`);
              console.log(`Last heartbeat: ${lastHeartbeat ?? "never"}`);
              console.log(`Capabilities:`);
              console.log(`  Web browsing: ${manifest.capabilities.webBrowsing}`);
              console.log(`  Code execution: ${manifest.capabilities.codeExecution}`);
              console.log(`  Terminal: ${manifest.capabilities.terminalAccess}`);
              console.log(`Goals: ${manifest.goals.goals.length}`);
              for (const goal of manifest.goals.goals) {
                console.log(`  [P${goal.priority}] ${goal.title}`);
              }
            } else {
              // Fleet overview
              const summary = fleet.getFleetSummary();
              const approvalSummary = approvals.getSummary();
              console.log("Fleet Overview:");
              console.log(`  Total agents: ${summary.total}`);
              console.log(`  Online: ${summary.online}`);
              console.log(`  Offline: ${summary.offline}`);
              console.log(`  Total actions: ${summary.totalActions}`);
              console.log(`  Total spend: $${summary.totalSpend.toFixed(2)}`);
              console.log(`  Pending approvals: ${approvalSummary.pending}`);
              if (controlPlane) {
                console.log(
                  `  Connected agents: ${controlPlane.getConnectedAgentIds().length}`,
                );
              }
            }
          });

        cmd
          .command("validate")
          .description("Validate a manifest file without provisioning")
          .argument("<manifest-path>", "Path to the agent manifest JSON")
          .action((path: string) => {
            try {
              const raw = readFileSync(path, "utf-8");
              const result = moltAgentManifestSchema.safeParse(JSON.parse(raw));
              if (result.success) {
                console.log("Manifest is valid.");
                console.log(`  Agent: ${result.data.identity.name}`);
                console.log(
                  `  Skills: ${result.data.agentConfig.skills.join(", ") || "none"}`,
                );
                console.log(
                  `  Channels: ${result.data.channels.channels.length}`,
                );
                console.log(
                  `  Capabilities: ${Object.entries(result.data.capabilities)
                    .filter(([, v]) => typeof v === "boolean" && v)
                    .map(([k]) => k)
                    .join(", ") || "none"}`,
                );
                console.log(
                  `  Goals: ${result.data.goals.goals.length}`,
                );
                console.log(
                  `  Max daily spend: $${result.data.financialControls.maxPerDay}`,
                );
              } else {
                console.error("Manifest validation failed:");
                for (const issue of result.error.issues) {
                  console.error(`  ${issue.path.join(".")}: ${issue.message}`);
                }
                process.exitCode = 1;
              }
            } catch (err) {
              console.error(`Error reading manifest: ${err}`);
              process.exitCode = 1;
            }
          });

        cmd
          .command("approve")
          .description("List and respond to pending approval requests")
          .option("--approve <id>", "Approve a request by ID")
          .option("--deny <id>", "Deny a request by ID")
          .action((opts: { approve?: string; deny?: string }) => {
            if (opts.approve) {
              const result = approvals.resolve(opts.approve, true, "cli");
              console.log(result ? `Approved: ${result.description}` : "Request not found");
              return;
            }
            if (opts.deny) {
              const result = approvals.resolve(opts.deny, false, "cli");
              console.log(result ? `Denied: ${result.description}` : "Request not found");
              return;
            }
            // List pending
            const pending = approvals.getPending();
            if (pending.length === 0) {
              console.log("No pending approvals.");
              return;
            }
            for (const a of pending) {
              const amount = a.amount != null ? ` $${a.amount.toFixed(2)}` : "";
              console.log(
                `  ${a.id.slice(0, 8)}  [${a.category}]${amount}  ${a.description}  (from ${a.agentId.slice(0, 8)})`,
              );
            }
          });
      },
      { commands: ["moltagent"] },
    );

    // -- Cleanup on shutdown --
    process.on("SIGTERM", () => {
      bridge?.close();
      controlPlane?.close();
      fleet.close();
      approvals.close();
    });
  },
};

// -- Control command handler --

function handleControlCommand(
  msg: ControlMessage,
  _api: MoltbotPluginApi,
): void {
  switch (msg.type) {
    case "ping":
      break;
    case "restart":
      console.log("[moltagent] Restart requested by control plane");
      process.exit(0);
      break;
    case "shutdown":
      console.log("[moltagent] Shutdown requested by control plane");
      process.exit(0);
      break;
    case "send_message":
      console.log(`[moltagent] Message from control plane: ${msg.content}`);
      // TODO: route to agent's inbound message handler
      break;
    case "update_goals":
      console.log(`[moltagent] Goals updated: ${msg.goals.length} goals`);
      // TODO: persist updated goals and notify agent runtime
      break;
    case "inject_knowledge":
      console.log(
        `[moltagent] Knowledge injected: ${msg.documents.length} documents`,
      );
      // TODO: index into RAG via memory-lancedb
      break;
    default:
      break;
  }
}

export default plugin;
