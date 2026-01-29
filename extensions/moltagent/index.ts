/**
 * MoltAgent Extension
 *
 * Enables MoltBot to run as an autonomous agent on a dedicated VPS,
 * managed from a LobeHub control plane. Core features:
 *
 * 1. Agent Manifest - schema for defining deployable agents
 * 2. VPS Provisioning - spin up/down Hetzner or Docker instances
 * 3. Bridge - WebSocket connection back to LobeHub for monitoring/control
 * 4. Management API - REST endpoints for provisioning and status
 *
 * Two operating modes:
 * - ORCHESTRATOR mode: runs on a central server, provisions and manages agents
 * - AGENT mode: runs on a VPS, connects bridge to control plane, executes tasks
 *
 * Mode is determined by the presence of MOLTAGENT_MANIFEST env var.
 */
import { readFileSync } from "node:fs";

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

const plugin = {
  id: "moltagent",
  name: "MoltAgent",
  description:
    "Provision and manage autonomous MoltBot agents on dedicated VPS instances",
  kind: "infra",
  configSchema: emptyPluginConfigSchema(),

  register(api: MoltbotPluginApi) {
    // Determine operating mode
    const manifestPath = process.env.MOLTAGENT_MANIFEST;
    const isAgentMode = !!manifestPath;

    let manifest: MoltAgentManifest | null = null;
    let bridge: MoltAgentBridge | null = null;
    let bridgeConnected = false;
    let lastHeartbeat: string | null = null;

    // -- AGENT MODE: Running on a VPS with a manifest --
    if (isAgentMode) {
      try {
        const raw = readFileSync(manifestPath, "utf-8");
        const parsed = moltAgentManifestSchema.parse(JSON.parse(raw));
        manifest = parsed;

        // Start bridge connection to control plane
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

    // -- ORCHESTRATOR MODE: Register provisioning providers --
    const pluginConfig = api.runtime?.config?.plugins?.moltagent ?? {};
    const hetznerToken =
      (pluginConfig as Record<string, string>).hetznerApiToken ??
      process.env.HETZNER_API_TOKEN;

    if (hetznerToken) {
      registerProvider(
        createHetznerProvider({
          apiToken: hetznerToken,
          defaultServerType:
            (pluginConfig as Record<string, string>).defaultServerType ?? "cpx21",
          defaultRegion:
            (pluginConfig as Record<string, string>).defaultRegion ?? "nbg1",
          defaultImage: "ubuntu-24.04",
        }),
      );
    }

    // Always register docker-local for development
    registerProvider(createDockerLocalProvider());

    const defaultProvider = hetznerToken ? "hetzner" : "docker-local";
    const provisioner = new MoltAgentProvisioner(defaultProvider);

    // -- Register gateway API routes --
    const authToken =
      (pluginConfig as Record<string, string>).controlPlaneToken ??
      process.env.MOLTAGENT_API_TOKEN ??
      "";

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
        return handler({
          method: r.method,
          path: r.path.replace(/^\/moltagent/, "") || "/",
          body: r.body,
          headers: r.headers,
        });
      });
    }

    // -- Register CLI commands --
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
          .action(async (manifestPath: string, opts: { provider?: string }) => {
            try {
              const raw = readFileSync(manifestPath, "utf-8");
              const m = moltAgentManifestSchema.parse(JSON.parse(raw));
              if (opts.provider) m.resources.provider = opts.provider;

              const { generateCloudInit } = await import("./src/cloud-init.js");
              const cloudInit = generateCloudInit(m);
              const result = await provisioner.provision(m, cloudInit);

              if (result.success) {
                console.log(`Agent provisioned: ${result.instance?.id}`);
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
          .description("List all running MoltAgent instances")
          .action(() => {
            const instances = provisioner.listInstances();
            if (instances.length === 0) {
              console.log("No MoltAgent instances running.");
              return;
            }
            for (const inst of instances) {
              console.log(
                `  ${inst.agentId.slice(0, 8)}  ${inst.status.padEnd(10)}  ${inst.ipv4.padEnd(16)}  ${inst.provider}  ${inst.region}`,
              );
            }
          });

        cmd
          .command("destroy")
          .description("Destroy a MoltAgent instance")
          .argument("<agent-id>", "Agent ID to destroy")
          .action(async (agentId: string) => {
            const result = await provisioner.destroy(agentId);
            if (result.success) {
              console.log(`Agent ${agentId} destroyed.`);
            } else {
              console.error(`Destroy failed: ${result.error}`);
              process.exitCode = 1;
            }
          });

        cmd
          .command("status")
          .description("Show status of this MoltAgent (agent mode)")
          .action(() => {
            if (!manifest) {
              console.log("Not running in agent mode (no manifest loaded).");
              return;
            }
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
          });

        cmd
          .command("validate")
          .description("Validate a manifest file without provisioning")
          .argument("<manifest-path>", "Path to the agent manifest JSON")
          .action((manifestPath: string) => {
            try {
              const raw = readFileSync(manifestPath, "utf-8");
              const result = moltAgentManifestSchema.safeParse(JSON.parse(raw));
              if (result.success) {
                console.log("Manifest is valid.");
                console.log(`  Agent: ${result.data.identity.name}`);
                console.log(`  Skills: ${result.data.agentConfig.skills.join(", ") || "none"}`);
                console.log(`  Channels: ${result.data.channels.channels.length}`);
                console.log(`  Capabilities: ${Object.entries(result.data.capabilities).filter(([k, v]) => typeof v === "boolean" && v).map(([k]) => k).join(", ") || "none"}`);
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
      },
      { commands: ["moltagent"] },
    );
  },
};

// -- Control command handler --

function handleControlCommand(
  msg: ControlMessage,
  _api: MoltbotPluginApi,
): void {
  switch (msg.type) {
    case "ping":
      // heartbeat already handled by bridge
      break;
    case "restart":
      console.log("[moltagent] Restart requested by control plane");
      // Graceful restart: let the systemd service manager handle it
      process.exit(0);
      break;
    case "shutdown":
      console.log("[moltagent] Shutdown requested by control plane");
      process.exit(0);
      break;
    case "send_message":
      console.log(`[moltagent] Message from control plane: ${msg.content}`);
      // TODO: route to agent's message handler
      break;
    case "update_goals":
      console.log(`[moltagent] Goals updated: ${msg.goals.length} goals`);
      // TODO: update runtime goals
      break;
    case "inject_knowledge":
      console.log(
        `[moltagent] Knowledge injected: ${msg.documents.length} documents`,
      );
      // TODO: index into RAG
      break;
    default:
      break;
  }
}

export default plugin;
