/**
 * Hetzner Cloud VPS Provider
 *
 * Provisions dedicated VPS instances on Hetzner Cloud for MoltAgents.
 * Uses the Hetzner Cloud API v1: https://docs.hetzner.cloud/
 *
 * Hetzner is chosen as the default because:
 * - Cheap (cpx21 = 2 vCPU, 4GB RAM, ~€5/mo)
 * - Fast provisioning (~30 seconds)
 * - Clean REST API with cloud-init support
 * - EU + US datacenters
 */
import type { MoltAgentManifest } from "../schema.js";
import type { DestroyResult, ProvisionResult, VpsInstance, VpsProvider } from "../provisioner.js";

const HETZNER_API = "https://api.hetzner.cloud/v1";

interface HetznerConfig {
  apiToken: string;
  defaultServerType: string;
  defaultRegion: string;
  defaultImage: string;
}

export function createHetznerProvider(config: HetznerConfig): VpsProvider {
  const headers = {
    Authorization: `Bearer ${config.apiToken}`,
    "Content-Type": "application/json",
  };

  async function hetznerFetch<T>(
    path: string,
    init?: RequestInit,
  ): Promise<{ data: T | null; error: string | null }> {
    try {
      const res = await fetch(`${HETZNER_API}${path}`, {
        ...init,
        headers: { ...headers, ...init?.headers },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { data: null, error: `Hetzner API ${res.status}: ${body}` };
      }
      const data = (await res.json()) as T;
      return { data, error: null };
    } catch (err) {
      return { data: null, error: `Hetzner request failed: ${err}` };
    }
  }

  function toVpsInstance(
    server: HetznerServer,
    agentId: string,
  ): VpsInstance {
    return {
      id: String(server.id),
      provider: "hetzner",
      status: mapHetznerStatus(server.status),
      ipv4: server.public_net?.ipv4?.ip ?? "",
      ipv6: server.public_net?.ipv6?.ip ?? "",
      serverType: server.server_type?.name ?? "",
      region: server.datacenter?.name ?? "",
      createdAt: server.created,
      agentId,
      providerMeta: {
        hetznerStatus: server.status,
        hetznerName: server.name,
      },
    };
  }

  return {
    name: "hetzner",

    async create(opts): Promise<ProvisionResult> {
      const { manifest, cloudInitScript, sshKeyIds } = opts;
      const serverType =
        manifest.resources.serverType || config.defaultServerType;
      const region = manifest.resources.region || config.defaultRegion;

      const body: Record<string, unknown> = {
        name: `moltagent-${manifest.identity.id.slice(0, 8)}`,
        server_type: serverType,
        location: region,
        image: config.defaultImage,
        user_data: cloudInitScript,
        labels: {
          moltagent: "true",
          "agent-id": manifest.identity.id,
          "owner-id": manifest.identity.ownerId,
        },
        start_after_create: true,
      };

      if (sshKeyIds?.length) {
        body.ssh_keys = sshKeyIds;
      }

      const { data, error } = await hetznerFetch<{ server: HetznerServer }>(
        "/servers",
        { method: "POST", body: JSON.stringify(body) },
      );

      if (error || !data?.server) {
        return { success: false, error: error ?? "No server in response" };
      }

      return {
        success: true,
        instance: toVpsInstance(data.server, manifest.identity.id),
      };
    },

    async destroy(instanceId): Promise<DestroyResult> {
      const { error } = await hetznerFetch(`/servers/${instanceId}`, {
        method: "DELETE",
      });
      if (error) return { success: false, error };
      return { success: true };
    },

    async status(instanceId): Promise<VpsInstance | null> {
      const { data, error } = await hetznerFetch<{ server: HetznerServer }>(
        `/servers/${instanceId}`,
      );
      if (error || !data?.server) return null;
      // Agent ID is stored in labels
      const agentId = data.server.labels?.["agent-id"] ?? "";
      return toVpsInstance(data.server, agentId);
    },

    async list(): Promise<VpsInstance[]> {
      const { data, error } = await hetznerFetch<{
        servers: HetznerServer[];
      }>("/servers?label_selector=moltagent%3Dtrue");
      if (error || !data?.servers) return [];
      return data.servers.map((s) =>
        toVpsInstance(s, s.labels?.["agent-id"] ?? ""),
      );
    },
  };
}

// -- Hetzner API types (minimal subset) --

interface HetznerServer {
  id: number;
  name: string;
  status: string;
  created: string;
  public_net?: {
    ipv4?: { ip: string };
    ipv6?: { ip: string };
  };
  server_type?: { name: string };
  datacenter?: { name: string };
  labels?: Record<string, string>;
}

function mapHetznerStatus(
  s: string,
): VpsInstance["status"] {
  switch (s) {
    case "initializing":
    case "starting":
      return "creating";
    case "running":
      return "running";
    case "stopping":
      return "stopping";
    case "off":
      return "stopped";
    default:
      return "error";
  }
}
