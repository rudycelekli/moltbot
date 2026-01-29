/**
 * MoltAgent Provisioner
 *
 * Provider-agnostic interface for VPS lifecycle management.
 * Each cloud provider implements the VpsProvider interface.
 * The Provisioner class orchestrates: create VPS -> inject manifest -> monitor.
 */
import type { MoltAgentManifest } from "./schema.js";

// -- Types --

export interface VpsInstance {
  /** Provider-assigned instance ID */
  id: string;
  /** Provider name (hetzner, docker-local, fly, etc.) */
  provider: string;
  /** Current status */
  status: "creating" | "running" | "stopping" | "stopped" | "error";
  /** Public IPv4 address (empty until assigned) */
  ipv4: string;
  /** Public IPv6 address */
  ipv6: string;
  /** Server type / size */
  serverType: string;
  /** Datacenter region */
  region: string;
  /** When the instance was created */
  createdAt: string;
  /** Agent manifest ID this instance is running */
  agentId: string;
  /** Provider-specific metadata */
  providerMeta: Record<string, unknown>;
}

export interface ProvisionResult {
  success: boolean;
  instance?: VpsInstance;
  error?: string;
}

export interface DestroyResult {
  success: boolean;
  error?: string;
}

// -- Provider Interface --

export interface VpsProvider {
  /** Provider identifier */
  readonly name: string;

  /** Create a new VPS with the given cloud-init script */
  create(opts: {
    manifest: MoltAgentManifest;
    cloudInitScript: string;
    sshKeyIds?: string[];
  }): Promise<ProvisionResult>;

  /** Destroy/delete a VPS instance */
  destroy(instanceId: string): Promise<DestroyResult>;

  /** Get current status of an instance */
  status(instanceId: string): Promise<VpsInstance | null>;

  /** List all instances managed by this provider */
  list(): Promise<VpsInstance[]>;
}

// -- Provider Registry --

const providers = new Map<string, VpsProvider>();

export function registerProvider(provider: VpsProvider): void {
  providers.set(provider.name, provider);
}

export function getProvider(name: string): VpsProvider | undefined {
  return providers.get(name);
}

export function listProviders(): string[] {
  return [...providers.keys()];
}

// -- Provisioner --

export class MoltAgentProvisioner {
  private instances = new Map<string, VpsInstance>();

  constructor(private defaultProvider: string) {}

  async provision(
    manifest: MoltAgentManifest,
    cloudInitScript: string,
  ): Promise<ProvisionResult> {
    const providerName =
      manifest.resources.provider || this.defaultProvider;
    const provider = getProvider(providerName);
    if (!provider) {
      return {
        success: false,
        error: `Unknown VPS provider: ${providerName}. Available: ${listProviders().join(", ")}`,
      };
    }

    const result = await provider.create({
      manifest,
      cloudInitScript,
    });

    if (result.success && result.instance) {
      this.instances.set(manifest.identity.id, result.instance);
    }

    return result;
  }

  async destroy(agentId: string): Promise<DestroyResult> {
    const instance = this.instances.get(agentId);
    if (!instance) {
      return { success: false, error: `No instance found for agent ${agentId}` };
    }

    const provider = getProvider(instance.provider);
    if (!provider) {
      return { success: false, error: `Provider ${instance.provider} not found` };
    }

    const result = await provider.destroy(instance.id);
    if (result.success) {
      this.instances.delete(agentId);
    }
    return result;
  }

  async getStatus(agentId: string): Promise<VpsInstance | null> {
    const instance = this.instances.get(agentId);
    if (!instance) return null;

    const provider = getProvider(instance.provider);
    if (!provider) return instance;

    const updated = await provider.status(instance.id);
    if (updated) {
      this.instances.set(agentId, updated);
    }
    return updated ?? instance;
  }

  listInstances(): VpsInstance[] {
    return [...this.instances.values()];
  }
}
