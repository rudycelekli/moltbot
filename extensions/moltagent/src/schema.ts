/**
 * MoltAgent Manifest Schema
 *
 * Defines the complete specification for a deployable autonomous agent.
 * This schema is shared between LobeHub (agent design) and MoltBot (runtime).
 * A manifest is created in LobeHub when a user clicks "Deploy as MoltAgent"
 * and consumed by the MoltBot instance on the provisioned VPS.
 */
import { z } from "zod";

// -- Identity --

export const agentIdentitySchema = z.object({
  /** Unique agent ID (UUID v4, assigned by control plane) */
  id: z.string().uuid(),
  /** Human-readable agent name */
  name: z.string().min(1).max(128),
  /** Owner user ID from the control plane */
  ownerId: z.string().min(1),
  /** Optional description of what this agent does */
  description: z.string().max(2048).optional(),
  /** Optional avatar URL */
  avatarUrl: z.string().url().optional(),
  /** Tags for filtering/grouping in the management dashboard */
  tags: z.array(z.string()).default([]),
});

// -- Agent Configuration --

export const agentConfigSchema = z.object({
  /** System prompt that defines the agent's persona and behavior */
  systemPrompt: z.string().min(1),
  /** LLM provider key (e.g. "anthropic", "openai", "google") */
  provider: z.string().default("anthropic"),
  /** Model ID (e.g. "claude-sonnet-4-20250514", "gpt-4o") */
  model: z.string().default("claude-sonnet-4-20250514"),
  /** Temperature for generation */
  temperature: z.number().min(0).max(2).default(0.7),
  /** Maximum tokens per response */
  maxTokens: z.number().int().positive().default(4096),
  /** Skills to enable from the skills/ directory */
  skills: z.array(z.string()).default([]),
  /** Custom tools defined inline (name + description + schema) */
  customTools: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        inputSchema: z.record(z.unknown()).optional(),
      }),
    )
    .default([]),
});

// -- Capabilities --

export const capabilitiesSchema = z.object({
  /** Enable Playwright-based web browsing */
  webBrowsing: z.boolean().default(false),
  /** Enable sandboxed code execution */
  codeExecution: z.boolean().default(false),
  /** Enable terminal/bash access */
  terminalAccess: z.boolean().default(false),
  /** Enable file system read/write */
  fileSystem: z.boolean().default(false),
  /** Git repos to clone into the workspace on setup */
  repos: z
    .array(
      z.object({
        url: z.string().url(),
        branch: z.string().default("main"),
        path: z.string(),
        setupCommand: z.string().optional(),
      }),
    )
    .default([]),
  /** Additional system packages to install */
  systemPackages: z.array(z.string()).default([]),
  /** Additional npm global packages to install */
  npmGlobals: z.array(z.string()).default([]),
  /** Additional pip packages to install */
  pipPackages: z.array(z.string()).default([]),
});

// -- Channels --

export const channelConfigSchema = z.object({
  /** Channel type (telegram, discord, slack, etc.) */
  type: z.string(),
  /** Channel-specific credentials (token, API key, etc.) */
  credentials: z.record(z.string()),
  /** Channel-specific settings */
  settings: z.record(z.unknown()).default({}),
  /** Whether this channel is enabled */
  enabled: z.boolean().default(true),
});

export const channelsSchema = z.object({
  /** List of messaging channels to connect */
  channels: z.array(channelConfigSchema).default([]),
});

// -- Resources --

export const resourcesSchema = z.object({
  /** Server type/size (e.g. "cpx21" for Hetzner, "shared-cpu-1x" for Fly.io) */
  serverType: z.string().default("cpx21"),
  /** Region/datacenter location */
  region: z.string().default("nbg1"),
  /** Disk size in GB (0 = provider default) */
  diskSizeGb: z.number().int().nonnegative().default(0),
  /** Docker image to use (empty = build from cloud-init) */
  dockerImage: z.string().default(""),
  /** VPS provider override (empty = use plugin config default) */
  provider: z.string().default(""),
});

// -- Financial Controls --

export const financialControlsSchema = z.object({
  /** Maximum spend per transaction in USD before requiring approval */
  maxPerTransaction: z.number().nonnegative().default(0),
  /** Maximum daily spend in USD */
  maxPerDay: z.number().nonnegative().default(0),
  /** Maximum monthly spend in USD */
  maxPerMonth: z.number().nonnegative().default(0),
  /** Whether the agent can hold crypto wallet keys */
  cryptoWalletEnabled: z.boolean().default(false),
  /** Wallet address (if crypto enabled) */
  walletAddress: z.string().default(""),
  /** Require explicit approval for all spend (overrides thresholds) */
  requireApprovalForAllSpend: z.boolean().default(true),
});

// -- Control Plane --

export const controlPlaneSchema = z.object({
  /** WebSocket URL to connect back to (e.g. wss://app.lobehub.com/agents/ws) */
  url: z.string().url(),
  /** Auth token for the bridge connection */
  token: z.string().min(1),
  /** Heartbeat interval in seconds */
  heartbeatIntervalSec: z.number().int().positive().default(30),
  /** How often to send full status reports (seconds) */
  statusReportIntervalSec: z.number().int().positive().default(300),
});

// -- Retention & Audit --

export const retentionSchema = z.object({
  /** Days to retain action logs (0 = provider default) */
  actionLogRetentionDays: z.number().int().nonnegative().default(7),
  /** Days to retain session recordings */
  sessionRecordingRetentionDays: z.number().int().nonnegative().default(3),
  /** Whether to stream actions to the control plane in real-time */
  liveActionStream: z.boolean().default(true),
  /** Whether to enable screen recording of browser sessions */
  screenRecording: z.boolean().default(false),
});

// -- OKRs / Goals --

export const goalSchema = z.object({
  /** Goal title */
  title: z.string().min(1),
  /** Detailed description */
  description: z.string().default(""),
  /** Priority (1 = highest) */
  priority: z.number().int().min(1).max(5).default(3),
  /** Due date (ISO 8601) */
  dueDate: z.string().datetime().optional(),
  /** Key results / measurable outcomes */
  keyResults: z
    .array(
      z.object({
        description: z.string(),
        targetValue: z.number().optional(),
        currentValue: z.number().default(0),
        unit: z.string().default(""),
      }),
    )
    .default([]),
});

export const goalsSchema = z.object({
  /** Agent's objectives and key results */
  goals: z.array(goalSchema).default([]),
});

// -- Knowledge Base --

export const knowledgeSchema = z.object({
  /** URLs to index into the agent's RAG knowledge base */
  urls: z.array(z.string().url()).default([]),
  /** File paths (on the VPS) to index */
  filePaths: z.array(z.string()).default([]),
  /** Inline text documents to inject into knowledge */
  documents: z
    .array(
      z.object({
        title: z.string(),
        content: z.string(),
      }),
    )
    .default([]),
});

// -- Full Manifest --

export const moltAgentManifestSchema = z.object({
  /** Schema version for forward compatibility */
  schemaVersion: z.literal("1.0"),
  identity: agentIdentitySchema,
  agentConfig: agentConfigSchema,
  capabilities: capabilitiesSchema,
  channels: channelsSchema,
  resources: resourcesSchema,
  financialControls: financialControlsSchema,
  controlPlane: controlPlaneSchema,
  retention: retentionSchema,
  goals: goalsSchema,
  knowledge: knowledgeSchema,
  /** Arbitrary metadata (for provider-specific or user-defined fields) */
  metadata: z.record(z.unknown()).default({}),
});

export type MoltAgentManifest = z.infer<typeof moltAgentManifestSchema>;
export type AgentIdentity = z.infer<typeof agentIdentitySchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export type ChannelConfig = z.infer<typeof channelConfigSchema>;
export type Resources = z.infer<typeof resourcesSchema>;
export type FinancialControls = z.infer<typeof financialControlsSchema>;
export type ControlPlane = z.infer<typeof controlPlaneSchema>;
export type RetentionConfig = z.infer<typeof retentionSchema>;
export type Goal = z.infer<typeof goalSchema>;
export type KnowledgeConfig = z.infer<typeof knowledgeSchema>;
