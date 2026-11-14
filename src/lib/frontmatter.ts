import { normalizeNFC } from "./unicode.js";

export interface ParsedNoteFrontmatter {
  hasFrontmatter: boolean;
  rawYaml: string;
  properties: Record<string, unknown>;
  body: string;
}

const ORDERED_KEYS = [
  "title",
  "aliases",
  "tags",
  "category",
  "relacionamento",
  "source_chat",
  "created",
  "updated",
  "status",
] as const;

export function stripYamlQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

export function quoteYamlScalar(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
}

/** Normaliza uma tag para kebab-case sem prefixo '#'. */
export function normalizeTagValue(tag: string): string {
  return tag
    .trim()
    .replace(/^#+/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function splitInlineYamlList(inner: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quote === null) {
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ",") {
        out.push(cur);
        cur = "";
        continue;
      }
    } else if (ch === "\\" && quote === '"' && i + 1 < inner.length) {
      cur += ch + inner[++i]!;
      continue;
    } else if (ch === quote) {
      if (quote === "'" && inner[i + 1] === "'") {
        cur += "''";
        i++;
        continue;
      }
      quote = null;
    }
    cur += ch;
  }

  out.push(cur);
  return out;
}

/**
 * Faz o parse estruturado do frontmatter YAML e do corpo Markdown (`obsidian-mind`).
 * Suporta listas em bloco, listas inline e preservacao de propriedades extras.
 */
export function parseNoteFrontmatter(markdown: string): ParsedNoteFrontmatter {
  const normalized = normalizeNFC(markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"));
  if (!normalized.startsWith("---\n")) {
    return {
      hasFrontmatter: false,
      rawYaml: "",
      properties: {},
      body: normalized,
    };
  }

  const lines = normalized.split("\n");
  const closeIdx = lines.indexOf("---", 1);
  if (closeIdx === -1) {
    return {
      hasFrontmatter: false,
      rawYaml: "",
      properties: {},
      body: normalized,
    };
  }

  const yamlLines = lines.slice(1, closeIdx);
  const rawYaml = yamlLines.join("\n");
  const body = lines.slice(closeIdx + 1).join("\n").replace(/^\n+/, "");
  const properties: Record<string, unknown> = {};

  let activeListKey: string | null = null;

  for (const line of yamlLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv && kv[1]) {
      const key = kv[1];
      const val = (kv[2] ?? "").trim();
      activeListKey = null;

      if (!val) {
        properties[key] = [];
        activeListKey = key;
      } else if (val.startsWith("[") && val.endsWith("]")) {
        const items = splitInlineYamlList(val.slice(1, -1))
          .map(stripYamlQuotes)
          .filter(Boolean);
        properties[key] = items;
      } else if (val === "true") {
        properties[key] = true;
      } else if (val === "false") {
        properties[key] = false;
      } else {
        properties[key] = stripYamlQuotes(val);
      }
      continue;
    }

    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && activeListKey) {
      const itemVal = stripYamlQuotes(listItem[1] ?? "");
      if (itemVal) {
        const existing = properties[activeListKey];
        if (Array.isArray(existing)) {
          existing.push(itemVal);
        } else {
          properties[activeListKey] = [itemVal];
        }
      }
    }
  }

  return {
    hasFrontmatter: true,
    rawYaml,
    properties,
    body,
  };
}

function formatYamlPropertyLines(key: string, value: unknown): string[] {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  if (Array.isArray(value)) {
    const rawItems = value.map((item) => String(item).trim()).filter(Boolean);
    const items =
      key === "tags"
        ? Array.from(new Set(rawItems.map(normalizeTagValue).filter(Boolean)))
        : Array.from(new Set(rawItems));

    if (items.length === 0) {
      return [];
    }

    return [
      `${key}:`,
      ...items.map((item) => `  - ${key === "tags" ? item : quoteYamlScalar(item)}`),
    ];
  }

  if (typeof value === "boolean" || typeof value === "number") {
    return [`${key}: ${String(value)}`];
  }

  const str = String(value).trim();
  if (!str) {
    return [];
  }

  if (
    key === "created" ||
    key === "updated" ||
    key === "category" ||
    key === "status"
  ) {
    if (!/[:#\[\]{}&*!|>'"]/.test(str)) {
      return [`${key}: ${str}`];
    }
    if (/^\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?$/.test(str)) {
      return [`${key}: ${str}`];
    }
  }

  return [`${key}: ${quoteYamlScalar(str)}`];
}

/**
 * Serializa frontmatter YAML e corpo Markdown em formato padronizado (`obsidian-skills` PROPERTIES.md),
 * mantendo ordem canonica de chaves e preservando chaves personalizadas extras.
 */
export function serializeNoteFrontmatter(
  properties: Record<string, unknown>,
  body: string,
): string {
  const orderedKeys: string[] = [];
  const seen = new Set<string>();

  for (const key of ORDERED_KEYS) {
    if (key in properties) {
      orderedKeys.push(key);
      seen.add(key);
    }
  }
  for (const key of Object.keys(properties)) {
    if (!seen.has(key)) {
      orderedKeys.push(key);
      seen.add(key);
    }
  }

  const yamlLines: string[] = ["---"];
  for (const key of orderedKeys) {
    yamlLines.push(...formatYamlPropertyLines(key, properties[key]));
  }
  yamlLines.push("---");

  const cleanBody = normalizeNFC(body.replace(/\r\n/g, "\n")).trim();
  return `${yamlLines.join("\n")}\n\n${cleanBody}\n`;
}

/** Mescla arrays de strings sem duplicatas (case-insensitive para aliases, kebab-case para tags). */
export function mergePropertyList(
  existing: unknown,
  additions: readonly string[] | undefined,
  isTag: boolean,
  maxItems?: number,
): string[] {
  const baseList = Array.isArray(existing)
    ? existing.map((v) => String(v))
    : typeof existing === "string" && existing.trim()
      ? [existing.trim()]
      : [];

  const combined = [...baseList, ...(additions ?? [])];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of combined) {
    const cleaned = isTag ? normalizeTagValue(raw) : raw.trim();
    if (!cleaned) {
      continue;
    }
    const key = cleaned.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(cleaned);
      if (maxItems && result.length >= maxItems) {
        break;
      }
    }
  }

  return result;
}
