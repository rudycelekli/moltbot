/**
 * Docker Local Provider
 *
 * Runs MoltAgent containers locally using Docker.
 * Used for development and testing without needing a cloud account.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { MoltAgentManifest } from "../schema.js";
import type { DestroyResult, ProvisionResult, VpsInstance, VpsProvider } from "../provisioner.js";

const exec = promisify(execFile);

const MOLTAGENT_IMAGE = "moltbot/moltagent:latest";

export function createDockerLocalProvider(): VpsProvider {
  async function docker(
    args: string[],
  ): Promise<{ stdout: string; error: string | null }> {
    try {
      const { stdout } = await exec("docker", args);
      return { stdout: stdout.trim(), error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { stdout: "", error: msg };
    }
  }

  function containerName(manifest: MoltAgentManifest): string {
    return `moltagent-${manifest.identity.id.slice(0, 12)}`;
  }

  return {
    name: "docker-local",

    async create(opts): Promise<ProvisionResult> {
      const { manifest } = opts;
      const name = containerName(manifest);

      // Encode manifest as base64 env var for the container
      const manifestB64 = Buffer.from(
        JSON.stringify(manifest),
      ).toString("base64");

      const { stdout: containerId, error } = await docker([
        "run",
        "-d",
        "--name",
        name,
        "-e",
        `MOLTAGENT_MANIFEST_B64=${manifestB64}`,
        "-e",
        `MOLTAGENT_ID=${manifest.identity.id}`,
        "-p",
        "0:18789", // random host port -> gateway port
        "--label",
        "moltagent=true",
        "--label",
        `agent-id=${manifest.identity.id}`,
        MOLTAGENT_IMAGE,
      ]);

      if (error) {
        return { success: false, error };
      }

      // Get the assigned host port
      const { stdout: portMapping } = await docker([
        "port",
        name,
        "18789",
      ]);
      const hostPort = portMapping.split(":").pop() ?? "0";

      const instance: VpsInstance = {
        id: containerId.slice(0, 12),
        provider: "docker-local",
        status: "running",
        ipv4: "127.0.0.1",
        ipv6: "::1",
        serverType: "docker-local",
        region: "local",
        createdAt: new Date().toISOString(),
        agentId: manifest.identity.id,
        providerMeta: {
          containerName: name,
          hostPort,
          fullContainerId: containerId,
        },
      };

      return { success: true, instance };
    },

    async destroy(instanceId): Promise<DestroyResult> {
      const { error: stopErr } = await docker(["stop", instanceId]);
      if (stopErr) return { success: false, error: stopErr };

      const { error: rmErr } = await docker(["rm", instanceId]);
      if (rmErr) return { success: false, error: rmErr };

      return { success: true };
    },

    async status(instanceId): Promise<VpsInstance | null> {
      const { stdout, error } = await docker([
        "inspect",
        "--format",
        '{{.State.Status}}|{{.Name}}|{{.Config.Labels}}|{{.Created}}',
        instanceId,
      ]);
      if (error) return null;

      const [status, , , created] = stdout.split("|");
      return {
        id: instanceId,
        provider: "docker-local",
        status: status === "running" ? "running" : "stopped",
        ipv4: "127.0.0.1",
        ipv6: "::1",
        serverType: "docker-local",
        region: "local",
        createdAt: created ?? new Date().toISOString(),
        agentId: "", // would need to parse labels
        providerMeta: { dockerStatus: status },
      };
    },

    async list(): Promise<VpsInstance[]> {
      const { stdout, error } = await docker([
        "ps",
        "-a",
        "--filter",
        "label=moltagent=true",
        "--format",
        "{{.ID}}|{{.Status}}|{{.Names}}|{{.CreatedAt}}",
      ]);
      if (error || !stdout) return [];

      return stdout.split("\n").filter(Boolean).map((line) => {
        const [id, status, name, createdAt] = line.split("|");
        return {
          id: id ?? "",
          provider: "docker-local",
          status: status?.startsWith("Up") ? "running" as const : "stopped" as const,
          ipv4: "127.0.0.1",
          ipv6: "::1",
          serverType: "docker-local",
          region: "local",
          createdAt: createdAt ?? "",
          agentId: "",
          providerMeta: { containerName: name },
        };
      });
    },
  };
}
