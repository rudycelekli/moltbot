import { fromMarkdown } from "mdast-util-from-markdown";

type PositionedMarkdownNode = {
  type: string;
  value?: string;
  alt?: string | null;
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  children?: PositionedMarkdownNode[];
};

function readMarkdownSourceLinks(markdown: string) {
  const links: Array<{ start: number; end: number; node: PositionedMarkdownNode }> = [];
  const tree: PositionedMarkdownNode = fromMarkdown(markdown);
  const pending = [tree];

  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) {
      continue;
    }
    if (node.type === "link" || node.type === "image") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (start !== undefined && end !== undefined) {
        links.push({ start, end, node });
      }
      // The outer link owns nested image source, so overlapping spans are not useful to callers.
      continue;
    }
    for (const child of node.children ?? []) {
      pending.push(child);
    }
  }

  return links.toSorted((left, right) => left.start - right.start);
}

/** Returns parser-owned source spans for inline links, autolinks, and images. */
export function findMarkdownLinkSourceSpans(markdown: string): Array<[number, number]> {
  return readMarkdownSourceLinks(markdown).map(({ start, end }) => [start, end]);
}

function readLinkText(node: PositionedMarkdownNode): string {
  const text: string[] = [];
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    if (current.type === "image" || current.type === "imageReference") {
      text.push(current.alt ?? "");
    } else if (current.value !== undefined) {
      text.push(current.value);
    } else if (current.type === "break") {
      text.push(" ");
    } else {
      const children = current.children ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child) {
          pending.push(child);
        }
      }
    }
  }
  return text.join("");
}

/** Replaces explicit inline links and images with their parser-owned label text. */
export function flattenMarkdownInlineLinks(markdown: string): string {
  if (!markdown.includes("[")) {
    return markdown;
  }
  const chunks: string[] = [];
  let cursor = 0;
  for (const { start, end, node } of readMarkdownSourceLinks(markdown)) {
    // Autolinks retain their visible URL; reference links are outside this owner's inline contract.
    if (markdown[start] !== "[" && !markdown.startsWith("![", start)) {
      continue;
    }
    chunks.push(markdown.slice(cursor, start), readLinkText(node));
    cursor = end;
  }
  chunks.push(markdown.slice(cursor));
  return chunks.join("");
}
