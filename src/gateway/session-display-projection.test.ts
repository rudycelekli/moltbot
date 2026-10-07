import { describe, expect, test } from "vitest";
import { projectSessionDisplayMessage } from "./session-display-projection.js";

const SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS = 240;

describe("projectSessionDisplayMessage", () => {
  test("keeps visible user and assistant text while excluding non-display rows", () => {
    const messages = [
      { role: "user", content: "Initial request" },
      { role: "assistant", content: "Visible final answer" },
      { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
      { role: "system", content: "system event" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private thought" },
          { type: "reasoning", text: "reasoning summary" },
        ],
      },
      { role: "assistant", content: "NO_REPLY" },
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        openclawDelivery: { replyToCurrent: true },
      },
    ];

    expect(messages.map((message) => projectSessionDisplayMessage(message))).toEqual([
      { role: "user", text: "Initial request" },
      { role: "assistant", text: "Visible final answer" },
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  test("bounds previews without splitting surrogate pairs", () => {
    const longReply = `${"a".repeat(SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS - 2)}😊tail`;
    const preview = projectSessionDisplayMessage({ role: "assistant", content: longReply });

    expect(preview?.text).toHaveLength(SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS);
    expect(preview?.text).toBe(`${"a".repeat(SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS - 3)}...`);
  });

  test("honors explicit preview budgets up to the shared cap", () => {
    const maxChars = 800;
    const message = { role: "assistant", content: "a".repeat(maxChars + 20) };
    const preview = projectSessionDisplayMessage(message, { maxChars });

    expect(preview?.text).toHaveLength(maxChars);
    expect(preview?.text).toBe(`${"a".repeat(maxChars - 3)}...`);
    expect(projectSessionDisplayMessage(message, { maxChars: Number.MAX_SAFE_INTEGER })?.text).toBe(
      `${"a".repeat(maxChars - 3)}...`,
    );
  });

  const longUrl = `https://example.com/${"x".repeat(SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS)}`;
  test.each([
    ["ordinary link", `Read the [deployment guide](${longUrl})`, "Read the deployment guide"],
    [
      "nested link label",
      `Read the [Report [Q3]](${longUrl}) and then deploy.`,
      "Read the Report [Q3] and then deploy.",
    ],
    [
      "balanced link destination",
      `Read the [report](${longUrl}/report_(Q3)) and then deploy.`,
      "Read the report and then deploy.",
    ],
    [
      "escaped link destination",
      String.raw`Read the [report](${longUrl}/report\)Q3) and then deploy.`,
      "Read the report and then deploy.",
    ],
  ])("flattens Markdown %s before bounding a preview", (_name, content, expected) => {
    const message = { role: "assistant", content };
    expect(projectSessionDisplayMessage(message, { flattenMarkdown: true })?.text).toBe(expected);
    expect(projectSessionDisplayMessage(message, { maxChars: 800 })?.text).toBe(content);
  });

  test.each([
    [
      "plain punctuation",
      "Keep foo_bar_baz (Q3) and [notes].",
      "Keep foo_bar_baz (Q3) and [notes].",
    ],
    ["fenced link", `Before\n\`\`\`md\n[Report [Q3]](${longUrl})\n\`\`\`\nAfter`, "Before After"],
  ])("keeps %s behavior while flattening a preview", (_name, content, expected) => {
    expect(
      projectSessionDisplayMessage({ role: "assistant", content }, { flattenMarkdown: true })?.text,
    ).toBe(expected);
  });

  test("preserves quoted directive examples", () => {
    const quoted = "Use `[[reply_to_current]]` literally.";
    expect(projectSessionDisplayMessage({ role: "assistant", content: quoted })?.text).toBe(quoted);
  });
});
