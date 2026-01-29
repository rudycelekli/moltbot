/**
 * LobeHub Integration Layer
 *
 * Utilities for integrating with LobeHub's agent system.
 * Converts LobeHub agent definitions into MoltAgent manifests,
 * and provides the client SDK for LobeHub to call the control plane.
 *
 * This module is imported by the LobeHub frontend plugin to:
 * 1. Convert a LobeHub agent into a MoltAgent manifest
 * 2. Deploy the agent to the control plane
 * 3. Manage deployed agents from within LobeHub
 */
import type { MoltAgentManifest } from "./schema.js";

// -- LobeHub Agent Types (subset of LobeHub's agent schema) --

export interface LobeHubAgent {
  /** LobeHub agent identifier */
  identifier: string;
  /** Display name */
  meta: {
    title: string;
    description?: string;
    avatar?: string;
    tags?: string[];
  };
  /** System prompt / role */
  systemRole: string;
  /** Model configuration */
  model?: {
    provider?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };
  /** Plugins enabled */
  plugins?: string[];
  /** Knowledge base references */
  knowledgeBases?: Array<{
    id: string;
    name: string;
    files?: Array<{ name: string; url: string }>;
  }>;
  /** Tool definitions */
  tools?: Array<{
    identifier: string;
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
  }>;
}

// -- Deploy Options (user picks in LobeHub UI) --

export interface DeployOptions {
  /** VPS provider */
  provider?: string;
  /** Server size */
  serverType?: string;
  /** Datacenter region */
  region?: string;
  /** Control plane WebSocket URL */
  controlPlaneUrl: string;
  /** Control plane auth token */
  controlPlaneToken: string;
  /** Owner user ID */
  ownerId: string;
  /** Capabilities to enable */
  capabilities?: {
    webBrowsing?: boolean;
    codeExecution?: boolean;
    terminalAccess?: boolean;
    fileSystem?: boolean;
  };
  /** Git repos to clone */
  repos?: Array<{
    url: string;
    branch?: string;
    path: string;
    setupCommand?: string;
  }>;
  /** Messaging channels to connect */
  channels?: Array<{
    type: string;
    credentials: Record<string, string>;
    settings?: Record<string, unknown>;
  }>;
  /** Financial controls */
  financialControls?: {
    maxPerTransaction?: number;
    maxPerDay?: number;
    maxPerMonth?: number;
    requireApprovalForAllSpend?: boolean;
  };
  /** Agent goals / OKRs */
  goals?: Array<{
    title: string;
    description?: string;
    priority?: number;
    keyResults?: Array<{
      description: string;
      targetValue?: number;
      unit?: string;
    }>;
  }>;
  /** Skills to enable */
  skills?: string[];
}

// -- Manifest Generator --

/**
 * Converts a LobeHub agent + deploy options into a MoltAgent manifest.
 * This is the bridge between LobeHub's agent model and MoltBot's runtime.
 */
export function lobeHubAgentToManifest(
  agent: LobeHubAgent,
  options: DeployOptions,
): MoltAgentManifest {
  // Map LobeHub provider names to MoltBot provider names
  const providerMap: Record<string, string> = {
    anthropic: "anthropic",
    openai: "openai",
    google: "google",
    azure: "azure",
    bedrock: "bedrock",
    ollama: "ollama",
  };

  const manifest: MoltAgentManifest = {
    schemaVersion: "1.0",

    identity: {
      id: crypto.randomUUID(),
      name: agent.meta.title,
      ownerId: options.ownerId,
      description: agent.meta.description,
      avatarUrl: agent.meta.avatar,
      tags: agent.meta.tags ?? [],
    },

    agentConfig: {
      systemPrompt: agent.systemRole,
      provider: providerMap[agent.model?.provider ?? "anthropic"] ?? "anthropic",
      model: agent.model?.model ?? "claude-sonnet-4-20250514",
      temperature: agent.model?.temperature ?? 0.7,
      maxTokens: agent.model?.maxTokens ?? 4096,
      skills: options.skills ?? mapPluginsToSkills(agent.plugins ?? []),
      customTools: (agent.tools ?? []).map((t) => ({
        name: t.identifier,
        description: t.description,
        inputSchema: t.parameters,
      })),
    },

    capabilities: {
      webBrowsing: options.capabilities?.webBrowsing ?? false,
      codeExecution: options.capabilities?.codeExecution ?? false,
      terminalAccess: options.capabilities?.terminalAccess ?? false,
      fileSystem: options.capabilities?.fileSystem ?? false,
      repos: (options.repos ?? []).map((r) => ({
        url: r.url,
        branch: r.branch ?? "main",
        path: r.path,
        setupCommand: r.setupCommand,
      })),
      systemPackages: [],
      npmGlobals: [],
      pipPackages: [],
    },

    channels: {
      channels: (options.channels ?? []).map((ch) => ({
        type: ch.type,
        credentials: ch.credentials,
        settings: ch.settings ?? {},
        enabled: true,
      })),
    },

    resources: {
      serverType: options.serverType ?? "cpx21",
      region: options.region ?? "nbg1",
      diskSizeGb: 0,
      dockerImage: "",
      provider: options.provider ?? "",
    },

    financialControls: {
      maxPerTransaction: options.financialControls?.maxPerTransaction ?? 0,
      maxPerDay: options.financialControls?.maxPerDay ?? 10,
      maxPerMonth: options.financialControls?.maxPerMonth ?? 100,
      cryptoWalletEnabled: false,
      walletAddress: "",
      requireApprovalForAllSpend:
        options.financialControls?.requireApprovalForAllSpend ?? true,
    },

    controlPlane: {
      url: options.controlPlaneUrl,
      token: options.controlPlaneToken,
      heartbeatIntervalSec: 30,
      statusReportIntervalSec: 300,
    },

    retention: {
      actionLogRetentionDays: 7,
      sessionRecordingRetentionDays: 3,
      liveActionStream: true,
      screenRecording: false,
    },

    goals: {
      goals: (options.goals ?? []).map((g) => ({
        title: g.title,
        description: g.description ?? "",
        priority: g.priority ?? 3,
        dueDate: undefined,
        keyResults: (g.keyResults ?? []).map((kr) => ({
          description: kr.description,
          targetValue: kr.targetValue,
          currentValue: 0,
          unit: kr.unit ?? "",
        })),
      })),
    },

    knowledge: {
      urls: [],
      filePaths: [],
      documents:
        agent.knowledgeBases?.flatMap(
          (kb) =>
            kb.files?.map((f) => ({
              title: f.name,
              content: `[File from knowledge base: ${kb.name}] URL: ${f.url}`,
            })) ?? [],
        ) ?? [],
    },

    metadata: {
      sourceLobeHubAgentId: agent.identifier,
      deployedFrom: "lobehub",
    },
  };

  return manifest;
}

/**
 * Map LobeHub plugin identifiers to MoltBot skill names.
 * LobeHub plugins and MoltBot skills overlap in some areas.
 */
function mapPluginsToSkills(plugins: string[]): string[] {
  const pluginToSkill: Record<string, string> = {
    "web-browsing": "coding-agent",
    "search-engine": "coding-agent",
    "web-crawler": "coding-agent",
    github: "github",
    "dalle-3": "openai-image-gen",
    "stable-diffusion": "openai-image-gen",
    arxiv: "coding-agent",
    "realtime-weather": "weather",
  };

  const skills = new Set<string>();
  for (const plugin of plugins) {
    const skill = pluginToSkill[plugin];
    if (skill) skills.add(skill);
  }
  return [...skills];
}

// -- Control Plane Client SDK --

/**
 * Client SDK for LobeHub to call the MoltAgent control plane.
 * Used in the LobeHub frontend to deploy, manage, and monitor agents.
 */
export class MoltAgentClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private async request<T>(
    path: string,
    opts: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}/moltagent/dashboard${path}`, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return res.json() as Promise<T>;
  }

  // Fleet
  async getOverview() {
    return this.request<{
      fleet: { total: number; online: number; offline: number; totalActions: number; totalSpend: number };
      approvals: { pending: number };
    }>("/overview");
  }

  async listAgents() {
    return this.request<{
      agents: Array<{
        id: string;
        name: string;
        connection: string;
        totalActions: number;
        totalSpend: number;
      }>;
    }>("/agents");
  }

  async getAgent(agentId: string) {
    return this.request(`/agents/${agentId}`);
  }

  // Deploy
  async deploy(manifest: MoltAgentManifest) {
    return this.request<{ agentId: string; instance: unknown }>(
      "/agents",
      { method: "POST", body: manifest },
    );
  }

  async destroyAgent(agentId: string) {
    return this.request(`/agents/${agentId}`, { method: "DELETE" });
  }

  // Commands
  async sendMessage(agentId: string, content: string, channel?: string) {
    return this.request(`/agents/${agentId}/message`, {
      method: "POST",
      body: { content, channel },
    });
  }

  async updateGoals(agentId: string, goals: MoltAgentManifest["goals"]["goals"]) {
    return this.request(`/agents/${agentId}/goals`, {
      method: "POST",
      body: { goals },
    });
  }

  async injectKnowledge(
    agentId: string,
    documents: Array<{ title: string; content: string }>,
  ) {
    return this.request(`/agents/${agentId}/knowledge`, {
      method: "POST",
      body: { documents },
    });
  }

  async restartAgent(agentId: string) {
    return this.request(`/agents/${agentId}/restart`, { method: "POST" });
  }

  // Actions
  async getActions(agentId: string, limit = 50, offset = 0) {
    return this.request<{ actions: unknown[] }>(
      `/agents/${agentId}/actions?limit=${limit}&offset=${offset}`,
    );
  }

  // Approvals
  async getPendingApprovals(agentId?: string) {
    const qs = agentId ? `?agentId=${agentId}` : "";
    return this.request<{ approvals: unknown[] }>(`/approvals${qs}`);
  }

  async respondApproval(requestId: string, approved: boolean, reason?: string) {
    return this.request(`/approvals/${requestId}/respond`, {
      method: "POST",
      body: { approved, reason, respondedBy: "lobehub" },
    });
  }
}
