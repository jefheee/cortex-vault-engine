import { normalizeNFC, normalizeWikilinkTarget } from "./unicode.js";

export interface ExtractedWikilink {
  raw: string;
  target: string;
  alias?: string | undefined;
  heading?: string | undefined;
  isEmbed: boolean;
}

const ASSET_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "pdf",
  "canvas",
  "base",
  "excalidraw",
  "html",
  "htm",
  "mp3",
  "mp4",
  "mov",
  "zip",
]);

/**
 * Remove blocos de codigo cercados (``` / ~~~) e codigo inline multi-crase (`obsidian-mind`),
 * impedindo que exemplos literais de `[[...]]` contem como links reais no grafo.
 */
export function stripCodeRegions(content: string): string {
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trimStart();
    if (inFence) {
      if (trimmed.startsWith(fenceMarker)) {
        inFence = false;
      }
      continue;
    }
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = true;
      fenceMarker = trimmed.slice(0, 3);
      continue;
    }
    out.push(line.replace(/(`+)(?:(?!\1)[^\n])*?\1(?!`)/g, ""));
  }

  return out.join("\n");
}

/** Extrai todos os `[[Target|Alias]]` e `[[Target#Heading]]` validos fora de blocos de codigo. */
export function extractWikilinks(markdown: string): ExtractedWikilink[] {
  const results: ExtractedWikilink[] = [];
  const masked = stripCodeRegions(markdown);
  const re = /(!)?\[\[([^\[\]\n]+?)\]\]/g;

  for (const match of masked.matchAll(re)) {
    const raw = match[0];
    const isEmbed = Boolean(match[1]);
    let inner = (match[2] ?? "").replaceAll("\\|", "|").replaceAll("&#124;", "|");

    const pipeIdx = inner.indexOf("|");
    const targetAndHeading = (pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner).trim();
    const alias = pipeIdx >= 0 ? inner.slice(pipeIdx + 1).trim() : undefined;

    const hashIdx = targetAndHeading.indexOf("#");
    const rawTarget = (hashIdx >= 0 ? targetAndHeading.slice(0, hashIdx) : targetAndHeading).trim();
    const heading = hashIdx >= 0 ? targetAndHeading.slice(hashIdx + 1).trim() : undefined;

    const target = normalizeWikilinkTarget(rawTarget);
    if (!target || target.includes("{{")) {
      continue;
    }

    const dotIdx = target.lastIndexOf(".");
    if (dotIdx !== -1) {
      const ext = target.slice(dotIdx + 1).toLowerCase();
      if (ASSET_EXTENSIONS.has(ext)) {
        continue;
      }
    }

    results.push({
      raw,
      target,
      ...(alias ? { alias: normalizeNFC(alias) } : {}),
      ...(heading ? { heading: normalizeNFC(heading) } : {}),
      isEmbed,
    });
  }

  return results;
}

/**
 * Normaliza todos os wikilinks fora de blocos de codigo para Unicode NFC
 * e remove caracteres invalidos de nomes de arquivo no destino.
 */
export function normalizeMarkdownWikilinks(markdown: string): string {
  const lines = normalizeNFC(markdown.replace(/\r\n/g, "\n")).split("\n");
  let inFence = false;
  let fenceMarker = "";

  const normalizedLines = lines.map((line) => {
    const trimmed = line.trimStart();
    if (inFence) {
      if (trimmed.startsWith(fenceMarker)) {
        inFence = false;
      }
      return line;
    }
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = true;
      fenceMarker = trimmed.slice(0, 3);
      return line;
    }

    return line.replace(/(!)?\[\[([^\[\]\n]+?)\]\]/g, (_full, embed: string | undefined, body: string) => {
      const normalizedBody = normalizeNFC(body)
        .replace(/([<>:"*?])/g, "")
        .replace(/\s+/g, " ")
        .trim();
      return `${embed ?? ""}[[${normalizedBody}]]`;
    });
  });

  return normalizedLines.join("\n");
}

function stripMdExt(value: string): string {
  return value.replace(/\.md$/i, "");
}

function normalizeRelative(rel: string): string | null {
  const parts: string[] = [];
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

export type WikilinkResolver = (target: string, sourceRelPath: string) => boolean;

/** Constroi resolvedor de wikilinks por caminho exato, basename ou alias (`obsidian-mind`). */
export function buildWikilinkResolver(
  files: readonly string[],
  aliasesByFile: ReadonlyMap<string, readonly string[]>,
): WikilinkResolver {
  const pathSet = new Set(files.map((f) => stripMdExt(normalizeNFC(f).replace(/\\/g, "/")).toLowerCase()));
  const basenames = new Set(
    files.map((f) => {
      const norm = normalizeNFC(f).replace(/\\/g, "/");
      const base = norm.split("/").pop() ?? norm;
      return stripMdExt(base).toLowerCase();
    }),
  );
  const aliases = new Set(
    [...aliasesByFile.values()].flat().map((a) => normalizeNFC(a).toLowerCase()),
  );

  return (target: string, sourceRelPath: string): boolean => {
    const clean = stripMdExt(normalizeNFC(target).replace(/\\/g, "/")).toLowerCase();
    if (!clean) {
      return true;
    }

    if (clean.startsWith("./") || clean.startsWith("../")) {
      const sourceDir = normalizeNFC(sourceRelPath)
        .replace(/\\/g, "/")
        .toLowerCase()
        .split("/")
        .slice(0, -1)
        .join("/");
      const resolved = normalizeRelative(sourceDir ? `${sourceDir}/${clean}` : clean);
      return resolved !== null && pathSet.has(resolved);
    }

    if (clean.includes("/")) {
      if (pathSet.has(clean)) {
        return true;
      }
      for (const p of pathSet) {
        if (p.endsWith(`/${clean}`)) {
          return true;
        }
      }
      return false;
    }

    return basenames.has(clean) || aliases.has(clean);
  };
}
