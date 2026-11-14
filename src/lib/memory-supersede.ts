import { parseNoteFrontmatter, serializeNoteFrontmatter, stripYamlQuotes } from "./frontmatter.js";
import { normalizeNFC } from "./unicode.js";

export interface FrontmatterEdit {
  readonly changed: boolean;
  readonly text: string;
  readonly reason: string;
}

/**
 * Adiciona ou estende uma lista no frontmatter YAML sem duplicar valores (`obsidian-mind/memory-supersede.ts`).
 */
export function addToFrontmatterList(md: string, key: string, value: string): FrontmatterEdit {
  const normalizedValue = normalizeNFC(value).trim();
  if (!normalizedValue) {
    return { changed: false, text: md, reason: "empty value" };
  }

  const parsed = parseNoteFrontmatter(md);
  if (!parsed.hasFrontmatter) {
    return { changed: false, text: md, reason: "no frontmatter block" };
  }

  const props: Record<string, unknown> = { ...parsed.properties };
  const current = props[key];
  const existingList: string[] = Array.isArray(current)
    ? current.map((v) => normalizeNFC(stripYamlQuotes(String(v))).trim()).filter(Boolean)
    : typeof current === "string" && current.trim()
      ? [normalizeNFC(stripYamlQuotes(current)).trim()]
      : [];

  if (existingList.some((item) => item.toLowerCase() === normalizedValue.toLowerCase())) {
    return { changed: false, text: md, reason: "already present" };
  }

  props[key] = [...existingList, normalizedValue];
  const serialized = serializeNoteFrontmatter(props, parsed.body);
  return {
    changed: true,
    text: serialized,
    reason: existingList.length > 0 ? "extended" : "added",
  };
}

/**
 * Registra rastreabilidade de supersessao e provenance no frontmatter ao consolidar nota existente.
 */
export function recordSupersedeMetadata(
  existingMarkdown: string,
  opts: {
    sourceChat?: string | undefined;
    supersededTitle?: string | undefined;
    updatedAt?: string | undefined;
  },
): string {
  const parsed = parseNoteFrontmatter(existingMarkdown);
  const props: Record<string, unknown> = parsed.hasFrontmatter ? { ...parsed.properties } : {};

  props.updated = opts.updatedAt ?? new Date().toISOString().slice(0, 10);

  let next = parsed.hasFrontmatter
    ? serializeNoteFrontmatter(props, parsed.body)
    : serializeNoteFrontmatter(props, existingMarkdown);

  if (opts.sourceChat) {
    if (!props.source_chat) {
      const reparsed = parseNoteFrontmatter(next);
      reparsed.properties.source_chat = normalizeNFC(opts.sourceChat);
      next = serializeNoteFrontmatter(reparsed.properties, reparsed.body);
    } else {
      next = addToFrontmatterList(next, "source_chats", opts.sourceChat).text;
    }
  }

  if (opts.supersededTitle) {
    next = addToFrontmatterList(next, "supersedes", opts.supersededTitle).text;
  }

  return next;
}
