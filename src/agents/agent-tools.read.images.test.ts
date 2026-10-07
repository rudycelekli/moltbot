import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNoisyPngBuffer } from "../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOpenClawReadTool } from "./agent-tools.read.js";
import { createReadTool } from "./sessions/tools/read.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("core read image admission", () => {
  it.each([false, true])("reads a PNG snapshot (partially written: %s)", async (partial) => {
    const workspaceDir = tempDirs.make("openclaw-read-image-admission-");
    const complete = createNoisyPngBuffer(64, 64);
    // Stop inside IDAT, after the PNG signature and complete IHDR have been written.
    const bytes = partial ? complete.subarray(0, Math.floor(complete.length / 2)) : complete;
    const imagePath = path.join(workspaceDir, "snapshot.png");
    await fs.writeFile(imagePath, bytes);
    const tool = createOpenClawReadTool(createReadTool(workspaceDir), { cwd: workspaceDir });

    const result = await tool.execute("read-image", { path: imagePath });

    expect(result.content.filter((block) => block.type === "image")).toEqual(
      partial ? [] : [{ type: "image", mimeType: "image/png", data: complete.toString("base64") }],
    );
    if (partial) {
      expect(result.content).toContainEqual({
        type: "text",
        text: expect.stringMatching(/omitted image payload/i),
      });
    }

    await fs.writeFile(path.join(workspaceDir, "next.txt"), "The next read still works.\n");
    const next = await tool.execute("read-text", { path: "next.txt" });
    expect(next.content).toEqual([{ type: "text", text: "The next read still works.\n" }]);
  });
});
