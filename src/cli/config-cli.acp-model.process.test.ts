import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatCliProcessFailure, runCliProcessChild } from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const nativeModel = "fixture/known";
const unknownModel = "unregistered-fixture/not-configured";

async function createConfigFixture(runtime: "acp" | "native" = "acp") {
  const root = tempDirs.make("openclaw-config-acp-model-");
  const configPath = path.join(root, "config", "openclaw.json");
  const config: OpenClawConfig = {
    agents: {
      defaults: { workspace: path.join(root, "workspace"), model: { primary: nativeModel } },
      entries: {
        main: {},
        harness: {
          runtime:
            runtime === "acp"
              ? { type: "acp", acp: { agent: "cursor", backend: "acpx", mode: "persistent" } }
              : { type: "embedded" },
        },
      },
    },
    models: {
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: "https://provider.example.invalid/v1",
          models: [
            {
              id: "known",
              name: "Configured native model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32000,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
    plugins: { enabled: false },
  };
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    COMSPEC: process.env.COMSPEC,
    ESBUILD_WORKER_THREADS: process.env.ESBUILD_WORKER_THREADS,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    NO_COLOR: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_HOME: root,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_HIDE_BANNER: "1",
    OPENCLAW_NO_RESPAWN: "1",
  };
  return {
    config,
    configPath,
    run: (args: string[]) =>
      runCliProcessChild({ nodeArgs: [path.resolve("openclaw.mjs"), "config", ...args], env }),
  };
}

describe("config set ACP harness models through the packaged CLI", () => {
  // The separate process proves public command parsing, plugin selection, runtime
  // model admission, exit status, and disk writes without replacing those owners.
  it.each([
    { name: "bare object primary", model: { primary: "composer-2.5", fallbacks: [] } },
    {
      name: "qualified object primary with a configured native fallback",
      model: { primary: "opencode/muse-spark-1.3", fallbacks: [nativeModel] },
    },
    { name: "string primary", model: "composer-2.5" },
  ])("accepts an ACP $name without native provider registration", async ({ model }) => {
    const fixture = await createConfigFixture();
    const before = await fs.readFile(fixture.configPath);
    const result = await fixture.run([
      "set",
      "agents.entries.harness.model",
      JSON.stringify(model),
      "--strict-json",
      "--dry-run",
      "--json",
    ]);
    expect(result.code, formatCliProcessFailure({ reason: "ACP model preview", ...result })).toBe(
      0,
    );
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.errors).toBeUndefined();
    expect(await fs.readFile(fixture.configPath)).toEqual(before);
  });

  it("writes the authored ACP primary while preserving the native defaults", async () => {
    const fixture = await createConfigFixture();
    const model = { primary: "composer-2.5", fallbacks: [] };
    const result = await fixture.run([
      "set",
      "agents.entries.harness.model",
      JSON.stringify(model),
      "--strict-json",
    ]);
    expect(result.code, formatCliProcessFailure({ reason: "ACP model write", ...result })).toBe(0);
    const written = JSON.parse(await fs.readFile(fixture.configPath, "utf8"));
    expect(written.agents.entries.harness).toEqual({
      ...fixture.config.agents?.entries?.harness,
      model,
    });
    expect(written.agents.defaults).toEqual(fixture.config.agents?.defaults);
    expect(written.models).toEqual(fixture.config.models);
    expect(written.plugins).toEqual(fixture.config.plugins);
  });

  it.each([
    {
      name: "native primary",
      runtime: "native" as const,
      model: { primary: unknownModel },
      errorPath: "primary",
    },
    {
      name: "ACP native fallback",
      runtime: "acp" as const,
      model: { primary: "composer-2.5", fallbacks: [unknownModel] },
      errorPath: "fallbacks.0",
    },
  ])(
    "rejects an unregistered $name and preserves config bytes",
    async ({ runtime, model, errorPath }) => {
      const fixture = await createConfigFixture(runtime);
      const before = await fs.readFile(fixture.configPath);
      const result = await fixture.run([
        "set",
        "agents.entries.harness.model",
        JSON.stringify(model),
        "--strict-json",
        "--dry-run",
        "--json",
      ]);
      expect(
        result.code,
        formatCliProcessFailure({ reason: "native model refusal", ...result }),
      ).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([
          {
            kind: "model",
            message: expect.stringContaining(`at agents.entries.harness.model.${errorPath}:`),
          },
        ]),
      });
      expect(await fs.readFile(fixture.configPath)).toEqual(before);
    },
  );

  it("accepts a configured native primary without credentials", async () => {
    const fixture = await createConfigFixture("native");
    const before = await fs.readFile(fixture.configPath);
    const result = await fixture.run([
      "set",
      "agents.entries.harness.model",
      JSON.stringify({ primary: nativeModel }),
      "--strict-json",
      "--dry-run",
      "--json",
    ]);
    expect(
      result.code,
      formatCliProcessFailure({ reason: "configured native model preview", ...result }),
    ).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.errors).toBeUndefined();
    expect(await fs.readFile(fixture.configPath)).toEqual(before);
  });
});
