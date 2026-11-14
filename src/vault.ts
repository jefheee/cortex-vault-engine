import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CATEGORY_TO_FOLDER,
  IGNORED_ROOT_FILES,
  ROOT_FOLDERS,
  type Category,
  type NoteStatus,
} from "./config.js";
import { atomicWriteFile, readFileWithRetry } from "./lib/atomic-write.js";
import { withFsRetry } from "./lib/fs-retry.js";
import { sanitizeMemorySlug } from "./lib/memory-write.js";
import { normalizeNFC, normalizeVaultPath } from "./lib/unicode.js";

export type OperationAction =
  | "CREATE_NEW"
  | "APPEND_TO_EXISTING"
  | "UPDATE_SECTION_IN_EXISTING"
  | "SKIP_DUPLICATE";

export interface NoteFrontmatter {
  title: string;
  aliases: string[];
  tags: string[];
  relacionamento?: string | undefined;
  created: string;
  updated: string;
  category: Category;
  status: NoteStatus;
}

export interface OrganizeOperation {
  action: OperationAction;
  target_path: string;
  section_heading?: string | undefined;
  content_markdown?: string | undefined;
  new_tags?: string[] | undefined;
  new_aliases?: string[] | undefined;
  changelog_entry?: string | undefined;
  suggested_filename?: string | undefined;
  frontmatter?: NoteFrontmatter | undefined;
  duplicate_reason?: string | undefined;
}

export interface OrganizedNotePayload {
  operations: OrganizeOperation[];
}

export interface ExistingNoteSummary {
  relativePath: string;
  name: string;
  title: string;
  aliases: string[];
  tags: string[];
  headings: string[];
  mtimeMs: number;
  size: number;
  lastBotWriteHash?: string | undefined;
}

export interface VaultIndexCache {
  version: 1;
  entries: Record<string, Omit<ExistingNoteSummary, "relativePath">>;
}

export interface VaultContext {
  notes: string[];
  folders: string[];
  summaries: ExistingNoteSummary[];
  cacheStats: {
    cacheHits: number;
    cacheMisses: number;
  };
}

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;
const TEMP_FILE_PATTERNS = [/^~\$/, /^\.~\$/, /\.tmp$/i, /\.part$/i, /\.crdownload$/i];

/** Determina se um arquivo na raiz ou inbox_chats deve ser ignorado pelo watcher (.md, .txt e .gdoc suportados). */
export function shouldIgnoreRootFile(filename: string): boolean {
  const norm = normalizeNFC(filename);
  const lower = norm.toLowerCase();
  if (!lower.endsWith(".md") && !lower.endsWith(".txt") && !lower.endsWith(".gdoc")) {
    return true;
  }
  if (norm.startsWith(".")) {
    return true;
  }
  if (IGNORED_ROOT_FILES.has(lower)) {
    return true;
  }
  return TEMP_FILE_PATTERNS.some((pattern) => pattern.test(norm));
}

/** Determina se um arquivo dentro de subpasta (01_Pessoas..05_Pessoal_e_Vida) deve ser ignorado. */
export function shouldIgnoreSubfolderFile(relPath: string): boolean {
  const normRel = normalizeNFC(relPath);
  const base = path.basename(normRel);
  const lower = base.toLowerCase();
  if (!lower.endsWith(".md")) {
    return true;
  }
  if (normRel.split(/[\\/]/).some((part) => part.startsWith("."))) {
    return true;
  }
  return TEMP_FILE_PATTERNS.some((pattern) => pattern.test(base));
}

/** Verifica se o nome segue o padrao de nota vazia padrao do Obsidian ("Sem título*.md|txt"). */
export function isUntitledFile(filename: string): boolean {
  return /^sem\s+t[ií]tulo(?:\s+\d+)?\.(?:md|txt)$/i.test(filename.trim());
}

/** Remove extensao .md ou .txt ou .gdoc de um nome de arquivo. */
export function stripNoteExtension(filename: string): string {
  return filename.trim().replace(/\.(?:md|txt|gdoc)$/i, "");
}

/** Formata Date no padrao local YYYY-MM-DD HH:mm exigido pelo frontmatter. */
export function formatDateTime(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Formata Date no padrao visivel DD/MM/YYYY HH:mm para carimbos inline de texto. */
export function formatDisplayDateTime(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Formata Date como YYYY-MM-DD para entradas de changelog. */
export function formatDateOnly(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Extrai objeto Date a partir do padrao Samsung Notes `_YYMMDD_HHMMSS.txt` ou usa fallback. */
export function extractHistoricalDateObjFromFilename(
  filename: string,
  fallbackMtime: Date,
): Date {
  const match = filename.match(/_(\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:\.[^.]+)?$/);
  if (!match) {
    return fallbackMtime;
  }
  const year = 2000 + Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return fallbackMtime;
  }

  const parsed = new Date(year, month - 1, day, hour, minute, second);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return fallbackMtime;
  }
  return parsed;
}

/** Extrai data historica formatada (`DD/MM/YYYY HH:mm`) de nomes Samsung Notes `_YYMMDD_HHMMSS.txt`. */
export function extractHistoricalDateFromFilename(
  filename: string,
  fallbackMtime: Date,
): string {
  return formatDisplayDateTime(extractHistoricalDateObjFromFilename(filename, fallbackMtime));
}

/** Calcula hash SHA-256 normalizado (LF) para guarda anti-loop de edicoes do bot. */
export function computeContentHash(content: string): string {
  return crypto
    .createHash("sha256")
    .update(content.replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");
}

/** Garante carimbo discreto de data/hora (`📅 DD/MM/YYYY HH:mm`) sem duplicar datas ja presentes no texto. */
export function ensureInlineDateStamp(markdown: string, displayDateStr: string): string {
  const trimmed = markdown.trim();
  const dateOnly = displayDateStr.slice(0, 10);
  if (!trimmed || trimmed.includes("📅") || (dateOnly.length === 10 && trimmed.includes(dateOnly))) {
    return trimmed;
  }

  const lines = trimmed.split(/\r?\n/);
  let stampedHeading = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (
      /^#{2,3}\s+/.test(line) &&
      !/^##\s+(?:🔗\s*)?Conexões Relacionadas/i.test(line) &&
      !/^##\s+Hist[oó]rico de Evolu/i.test(line)
    ) {
      if (!line.includes("📅") && !(dateOnly.length === 10 && line.includes(dateOnly))) {
        lines[i] = `${line.trimEnd()} \`📅 ${displayDateStr}\``;
        stampedHeading = true;
        break;
      }
    }
  }

  if (stampedHeading) {
    return lines.join("\n");
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const lineTrim = lines[i]!.trim();
    if (
      lineTrim.length > 0 &&
      !lineTrim.startsWith("```") &&
      !lineTrim.startsWith("|") &&
      !lineTrim.startsWith("# ")
    ) {
      lines[i] = `${lines[i]!.trimEnd()} *(📅 ${displayDateStr})*`;
      break;
    }
  }

  return lines.join("\n");
}

/**
 * Detecta se uma nota esta efetivamente vazia (0 bytes, apenas espacos em branco,
 * ou apenas frontmatter YAML `--- ... ---` sem texto real no corpo).
 */
export function isEffectivelyEmptyNote(content: string): boolean {
  const normalized = content.replace(/^\uFEFF/, "").trim();
  if (normalized.length === 0) {
    return true;
  }

  const fmMatch = normalized.match(/^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/);
  if (!fmMatch) {
    return false;
  }

  const innerYaml = (fmMatch[1] ?? "").trim();
  if (innerYaml.length > 0) {
    const yamlLines = innerYaml.split(/\r?\n/);
    const looksLikeYaml = yamlLines.every(
      (line) =>
        line.trim().length === 0 ||
        /^\s*#/.test(line) ||
        /^\s*-\s*/.test(line) ||
        /^[a-zA-Z0-9_-]+\s*:/.test(line) ||
        /^\s{2,}\S/.test(line),
    );
    if (!looksLikeYaml) {
      return false;
    }
  }

  const body = normalized.slice(fmMatch[0].length).trim();
  return body.length === 0;
}

/** Sanitiza nome de arquivo para compatibilidade estrita com Windows, Android e Google Drive. */
export function sanitizeFilename(rawName: string): string {
  const slug = sanitizeMemorySlug(rawName);
  const cleaned = slug
    .replace(INVALID_FILENAME_CHARS, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();

  const base = (cleaned || "Nota Organizada").slice(0, 120).replace(/[. ]+$/g, "").trim();
  return `${normalizeNFC(base || "Nota Organizada")}.md`;
}

/** Normaliza uma tag para kebab-case sem prefixo '#'. */
export function normalizeKebabTag(tag: string): string {
  return tag
    .trim()
    .replace(/^#+/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function sanitizeFolderSegment(segment: string): string {
  return segment
    .trim()
    .replace(/\.(?:md|txt|gdoc)$/i, "")
    .replace(INVALID_FILENAME_CHARS, "")
    .replace(/\.\./g, "")
    .replace(/\s+/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
}

/**
 * Valida a pasta destino contra as pastas existentes nos 5 pilares ativos.
 * Permite tambem subpastas semanticas limpas dentro de um dos 5 pilares.
 */
export function resolveTargetFolder(
  requestedFolder: string,
  category: Category,
  allowedFolders: readonly string[],
): string {
  const rawParts = requestedFolder
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);

  if (rawParts.length >= 1 && /\.(?:md|txt|gdoc)$/i.test(rawParts[rawParts.length - 1] ?? "")) {
    rawParts.pop();
  }

  const normalized = rawParts.join("/");

  const exactMatch = allowedFolders.find(
    (folder) => folder.toLowerCase() === normalized.toLowerCase(),
  );
  if (exactMatch) {
    return exactMatch;
  }

  const segments = rawParts.map(sanitizeFolderSegment).filter(Boolean);
  if (segments.length >= 1) {
    const matchedRoot = ROOT_FOLDERS.find(
      (root) => root.toLowerCase() === segments[0]!.toLowerCase(),
    );
    if (matchedRoot) {
      const subSegments = segments.slice(1, 3);
      return subSegments.length > 0 ? [matchedRoot, ...subSegments].join("/") : matchedRoot;
    }
  }

  return CATEGORY_TO_FOLDER[category];
}

function stripYamlQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Extrai metadados leves (title, aliases, tags e titulos ##/###) de uma nota Markdown. */
export function extractNoteSummary(
  content: string,
  relativePath: string,
  mtimeMs: number = 0,
  size: number = 0,
): ExistingNoteSummary {
  const name = path.basename(relativePath, ".md");
  let title = name;
  const aliases: string[] = [];
  const tags: string[] = [];
  const headings: string[] = [];

  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  let body = content;

  if (fmMatch && fmMatch[1] !== undefined) {
    body = content.slice(fmMatch[0].length);
    const lines = fmMatch[1].split(/\r?\n/);
    let currentListKey: "aliases" | "tags" | null = null;

    for (const line of lines) {
      const keyMatch = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
      if (keyMatch) {
        const key = keyMatch[1]!.toLowerCase();
        const val = keyMatch[2]!.trim();
        currentListKey = null;

        if (key === "title" && val) {
          title = stripYamlQuotes(val);
        } else if (key === "aliases") {
          if (val.startsWith("[") && val.endsWith("]")) {
            val
              .slice(1, -1)
              .split(",")
              .map(stripYamlQuotes)
              .filter(Boolean)
              .forEach((a) => aliases.push(a));
          } else if (!val) {
            currentListKey = "aliases";
          }
        } else if (key === "tags") {
          if (val.startsWith("[") && val.endsWith("]")) {
            val
              .slice(1, -1)
              .split(",")
              .map(stripYamlQuotes)
              .filter(Boolean)
              .forEach((t) => tags.push(t));
          } else if (!val) {
            currentListKey = "tags";
          }
        }
        continue;
      }

      const itemMatch = line.match(/^\s+-\s+(.+)$/);
      if (itemMatch && currentListKey) {
        const itemVal = stripYamlQuotes(itemMatch[1]!);
        if (itemVal) {
          if (currentListKey === "aliases") {
            aliases.push(itemVal);
          } else {
            tags.push(itemVal);
          }
        }
      }
    }
  }

  for (const line of body.split(/\r?\n/)) {
    const hMatch = line.match(/^#{2,3}\s+(.+)$/);
    if (hMatch && hMatch[1]) {
      headings.push(hMatch[1].trim());
      if (headings.length >= 16) {
        break;
      }
    }
  }

  return {
    relativePath,
    name,
    title,
    aliases: aliases.slice(0, 8),
    tags: tags.slice(0, 10),
    headings,
    mtimeMs,
    size,
  };
}

async function loadIndexCache(cachePath: string | undefined): Promise<VaultIndexCache> {
  if (!cachePath) {
    return { version: 1, entries: {} };
  }
  try {
    const raw = await readFileWithRetry(cachePath);
    const parsed = JSON.parse(raw) as Partial<VaultIndexCache>;
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
      return { version: 1, entries: { ...parsed.entries } };
    }
  } catch {
    // Cache ausente ou corrompido: reconstroi
  }
  return { version: 1, entries: {} };
}

/**
 * Coleta o contexto do cofre usando cache incremental (`vault-index.json`).
 * So relê do disco arquivos novos ou com `mtimeMs`/`size` alterados.
 */
export async function collectVaultContext(
  vaultRoot: string,
  indexCachePath?: string,
): Promise<VaultContext> {
  const existingCache = await loadIndexCache(indexCachePath);
  const nextEntries: VaultIndexCache["entries"] = {};
  const noteSet = new Set<string>();
  const folderList: string[] = [];
  const summaries: ExistingNoteSummary[] = [];

  let cacheHits = 0;
  let cacheMisses = 0;
  let dirty = false;

  async function walk(absDir: string, relDir: string): Promise<void> {
    const normRelDir = normalizeVaultPath(relDir);
    folderList.push(normRelDir);
    const entries = await withFsRetry(
      () => fs.readdir(absDir, { withFileTypes: true }),
      `vault:readdir:${normRelDir}`,
    );
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const absPath = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absPath, `${normRelDir}/${entry.name}`);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const relPath = normalizeVaultPath(`${normRelDir}/${entry.name}`);
        noteSet.add(normalizeNFC(entry.name.slice(0, -3)));

        let mtimeMs = 0;
        let size = 0;
        try {
          const st = await withFsRetry(() => fs.stat(absPath), `vault:stat:${relPath}`);
          mtimeMs = st.mtimeMs;
          size = st.size;
        } catch {
          continue;
        }

        const cached = existingCache.entries[relPath];
        if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
          cacheHits += 1;
          nextEntries[relPath] = cached;
          summaries.push({ relativePath: relPath, ...cached });
          continue;
        }

        cacheMisses += 1;
        dirty = true;
        try {
          const content = await readFileWithRetry(absPath);
          const parsed = extractNoteSummary(content, relPath, mtimeMs, size);
          const { relativePath: _ignored, ...rest } = parsed;
          const preservedHash = cached?.lastBotWriteHash;
          const entryWithHash = preservedHash ? { ...rest, lastBotWriteHash: preservedHash } : rest;
          nextEntries[relPath] = entryWithHash;
          summaries.push({ ...parsed, ...(preservedHash ? { lastBotWriteHash: preservedHash } : {}) });
        } catch {
          const fallback = {
            name: normalizeNFC(entry.name.slice(0, -3)),
            title: normalizeNFC(entry.name.slice(0, -3)),
            aliases: [],
            tags: [],
            headings: [],
            mtimeMs,
            size,
            ...(cached?.lastBotWriteHash ? { lastBotWriteHash: cached.lastBotWriteHash } : {}),
          };
          nextEntries[relPath] = fallback;
          summaries.push({ relativePath: relPath, ...fallback });
        }
      }
    }
  }

  for (const rootFolder of ROOT_FOLDERS) {
    const absRootFolder = path.join(vaultRoot, rootFolder);
    try {
      const stat = await withFsRetry(() => fs.stat(absRootFolder), `vault:stat:${rootFolder}`);
      if (stat.isDirectory()) {
        await walk(absRootFolder, rootFolder);
      } else {
        folderList.push(rootFolder);
      }
    } catch {
      folderList.push(rootFolder);
    }
  }

  if (Object.keys(existingCache.entries).length !== Object.keys(nextEntries).length) {
    dirty = true;
  }

  if (indexCachePath && dirty) {
    try {
      await atomicWriteFile(
        indexCachePath,
        JSON.stringify({ version: 1, entries: nextEntries }, null, 2),
      );
    } catch {
      // Nao bloqueia pipeline se escrita do cache falhar
    }
  }

  return {
    notes: Array.from(noteSet).sort((a, b) => a.localeCompare(b, "pt-BR")),
    folders: folderList.sort((a, b) => a.localeCompare(b, "pt-BR")),
    summaries: summaries.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "pt-BR")),
    cacheStats: { cacheHits, cacheMisses },
  };
}

function tokenizeForRelevance(text: string): Set<string> {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const tokens = normalized.match(/[a-z0-9]{3,}/g) ?? [];
  return new Set(tokens);
}

/**
 * Seleciona ate `limit` (padrao 45) notas mais relevantes localmente quando o cofre
 * ultrapassa `threshold`, priorizando maxima precisao contextual.
 */
export function selectTopRelevantSummaries(params: {
  rawContent: string;
  originalFilename: string;
  summaries: readonly ExistingNoteSummary[];
  limit?: number;
  recentCount?: number;
  threshold?: number;
}): ExistingNoteSummary[] {
  const {
    rawContent,
    originalFilename,
    summaries,
    limit = 45,
    recentCount = 8,
    threshold = 60,
  } = params;

  if (summaries.length <= threshold) {
    return [...summaries];
  }

  const queryTokens = tokenizeForRelevance(`${originalFilename} ${rawContent}`);
  const selected = new Map<string, ExistingNoteSummary>();

  // Mantem sempre dossies mestres e padroes prioritarios no contexto para evitar fragmentacao
  const alwaysIncludePatterns = [
    "00_perfil_mestre_jefherson.md",
    "00_mapa_de_pessoas.md",
    "04_padroes_e_prompts/",
    "cofre pessoal",
    "chaves de api e credenciais",
    "ads unisul",
    "setup do computador",
    "gaming, pro clubs",
    "ficha de treino",
  ];
  for (const s of summaries) {
    const lower = s.relativePath.toLowerCase();
    if (alwaysIncludePatterns.some((pat) => lower.includes(pat))) {
      selected.set(s.relativePath, s);
    }
  }

  const recent = [...summaries]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, recentCount);
  for (const item of recent) {
    selected.set(item.relativePath, item);
  }

  const scored = summaries
    .map((summary) => {
      let score = 0;
      const titleTokens = tokenizeForRelevance(`${summary.name} ${summary.title}`);
      const aliasTokens = tokenizeForRelevance(summary.aliases.join(" "));
      const tagTokens = tokenizeForRelevance(summary.tags.join(" "));
      const headingTokens = tokenizeForRelevance(summary.headings.join(" "));
      const pathTokens = tokenizeForRelevance(summary.relativePath);

      for (const tok of queryTokens) {
        if (titleTokens.has(tok)) score += 3;
        if (aliasTokens.has(tok)) score += 3;
        if (tagTokens.has(tok)) score += 2.5;
        if (headingTokens.has(tok)) score += 2;
        if (pathTokens.has(tok)) score += 1.5;
      }
      return { summary, score };
    })
    .sort((a, b) => b.score - a.score || b.summary.mtimeMs - a.summary.mtimeMs);

  for (const entry of scored) {
    if (selected.size >= limit) {
      break;
    }
    selected.set(entry.summary.relativePath, entry.summary);
  }

  return Array.from(selected.values()).slice(0, limit);
}

/**
 * Localiza uma nota existente correspondente a `targetPath` (exato ou por nome/titulo unico).
 */
export function findMatchingNoteSummary(
  targetPath: string,
  summaries: readonly ExistingNoteSummary[],
): ExistingNoteSummary | undefined {
  const norm = targetPath.trim().replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  if (!norm) {
    return undefined;
  }

  const exact = summaries.find((s) => s.relativePath.toLowerCase() === norm);
  if (exact) {
    return exact;
  }

  const targetStem = path.posix.basename(norm).replace(/\.md$/i, "");
  if (!targetStem) {
    return undefined;
  }

  const stemMatches = summaries.filter(
    (s) => s.name.toLowerCase() === targetStem || s.title.toLowerCase() === targetStem,
  );
  if (stemMatches.length === 1) {
    return stemMatches[0];
  }
  return undefined;
}

/** Evita sobrescrever notas existentes caso ja exista um arquivo com o mesmo nome na pasta destino. */
export async function resolveUniqueDestination(
  folderAbsPath: string,
  filename: string,
): Promise<string> {
  const ext = ".md";
  const stem = filename.slice(0, -ext.length);
  let candidate = path.join(folderAbsPath, filename);
  let counter = 2;

  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(folderAbsPath, `${stem} (${counter})${ext}`);
      counter += 1;
    } catch {
      return candidate;
    }
  }
}

function escapeYamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
}

/** Serializa o frontmatter YAML padronizado e o corpo formatado da nota nova. */
export function serializeMarkdownNote(
  fm: NoteFrontmatter,
  formattedBody: string,
  createdAt: Date,
  updatedAt: Date,
): string {
  const aliases = fm.aliases.slice(0, 5);
  const tags = fm.tags
    .map(normalizeKebabTag)
    .filter((tag) => tag.length > 0)
    .slice(0, 8);

  const effectiveTags = tags.length > 0 ? tags : [fm.category, "nota"];
  const effectiveAliases = aliases.length > 0 ? aliases : [fm.title];

  const lines: string[] = [
    "---",
    `title: ${escapeYamlString(fm.title)}`,
    "aliases:",
    ...effectiveAliases.map((alias) => `  - ${escapeYamlString(alias)}`),
    "tags:",
    ...effectiveTags.map((tag) => `  - ${tag}`),
    ...(fm.relacionamento ? [`relacionamento: ${escapeYamlString(fm.relacionamento)}`] : []),
    `created: ${formatDateTime(createdAt)}`,
    `updated: ${formatDateTime(updatedAt)}`,
    `category: ${fm.category}`,
    `status: ${fm.status}`,
    "---",
    "",
    formattedBody.trim(),
    "",
  ];

  return lines.join("\n");
}

function updateYamlFrontmatterTimestampAndLists(
  existingContent: string,
  updatedAt: Date,
  newTags?: readonly string[],
  newAliases?: readonly string[],
): { frontmatterBlock: string; body: string } {
  const updatedStr = formatDateTime(updatedAt);
  const fmMatch = existingContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fmMatch || fmMatch[1] === undefined) {
    return { frontmatterBlock: "", body: existingContent };
  }

  const body = existingContent.slice(fmMatch[0].length).replace(/^\r?\n+/, "");
  let fmLines = fmMatch[1].split(/\r?\n/);

  const updatedIdx = fmLines.findIndex((l) => /^updated:\s*/i.test(l));
  if (updatedIdx !== -1) {
    fmLines[updatedIdx] = `updated: ${updatedStr}`;
  } else {
    fmLines.push(`updated: ${updatedStr}`);
  }

  if (newTags && newTags.length > 0) {
    fmLines = mergeYamlListBlock(fmLines, "tags", newTags, true);
  }
  if (newAliases && newAliases.length > 0) {
    fmLines = mergeYamlListBlock(fmLines, "aliases", newAliases, false);
  }

  return {
    frontmatterBlock: `---\n${fmLines.join("\n")}\n---\n\n`,
    body,
  };
}

function mergeYamlListBlock(
  frontmatterLines: string[],
  key: "tags" | "aliases",
  additions: readonly string[],
  isTag: boolean,
): string[] {
  if (additions.length === 0) {
    return frontmatterLines;
  }

  const normalizedAdditions = additions
    .map((item) => (isTag ? normalizeKebabTag(item) : item.trim()))
    .filter(Boolean);
  if (normalizedAdditions.length === 0) {
    return frontmatterLines;
  }

  const keyIdx = frontmatterLines.findIndex((line) =>
    new RegExp(`^${key}:\\s*$`, "i").test(line),
  );
  if (keyIdx === -1) {
    return frontmatterLines;
  }

  let endIdx = keyIdx + 1;
  const existing = new Set<string>();
  while (endIdx < frontmatterLines.length) {
    const m = frontmatterLines[endIdx]!.match(/^\s+-\s+(.+)$/);
    if (!m) {
      break;
    }
    const val = stripYamlQuotes(m[1]!);
    existing.add(isTag ? normalizeKebabTag(val) : val.toLowerCase());
    endIdx += 1;
  }

  const toInsert: string[] = [];
  for (const item of normalizedAdditions) {
    const checkKey = isTag ? item : item.toLowerCase();
    if (!existing.has(checkKey)) {
      existing.add(checkKey);
      toInsert.push(isTag ? `  - ${item}` : `  - ${escapeYamlString(item)}`);
    }
  }

  if (toInsert.length === 0) {
    return frontmatterLines;
  }

  return [
    ...frontmatterLines.slice(0, endIdx),
    ...toInsert,
    ...frontmatterLines.slice(endIdx),
  ];
}

function normalizeHeadingForMatch(raw: string): string {
  return raw
    .replace(/^#{1,6}\s+/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findHeadingRange(
  lines: string[],
  sectionHeading: string,
): { startLine: number; level: number; endLine: number } | null {
  const targetNorm = normalizeHeadingForMatch(sectionHeading);
  if (!targetNorm) {
    return null;
  }

  let startLine = -1;
  let level = 2;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(/^(#{1,6})\s+(.+)$/);
    if (!match) {
      continue;
    }
    const headingNorm = normalizeHeadingForMatch(match[2]!);
    if (
      headingNorm === targetNorm ||
      headingNorm.includes(targetNorm) ||
      targetNorm.includes(headingNorm)
    ) {
      startLine = i;
      level = match[1]!.length;
      break;
    }
  }

  if (startLine === -1) {
    return null;
  }

  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (/^---$/.test(trimmed)) {
      const next = (lines[i + 1] ?? "").trim();
      if (/^##\s+(?:🔗\s*)?Conexões Relacionadas|\*\*Links Relacionados:\*\*/i.test(next)) {
        endLine = i;
        break;
      }
    }
    const headingMatch = lines[i]!.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch && headingMatch[1]!.length <= level) {
      endLine = i;
      break;
    }
  }

  return { startLine, level, endLine };
}

/**
 * Mescla novo conteudo em uma nota existente, respeitando `sectionHeading` quando encontrado,
 * atualizando `updated` e mesclando `tags`/`aliases` sem duplicatas antes do rodape de conexoes.
 */
export function mergeIntoExistingNote(params: {
  existingContent: string;
  appendSectionMarkdown: string;
  sectionHeading?: string | undefined;
  newTags?: readonly string[] | undefined;
  newAliases?: readonly string[] | undefined;
  updatedAt: Date;
}): string {
  const {
    existingContent,
    appendSectionMarkdown,
    sectionHeading,
    newTags,
    newAliases,
    updatedAt,
  } = params;
  const { frontmatterBlock, body } = updateYamlFrontmatterTimestampAndLists(
    existingContent,
    updatedAt,
    newTags,
    newAliases,
  );

  const trimmedAppend = appendSectionMarkdown.trim();

  if (sectionHeading) {
    const lines = body.split(/\r?\n/);
    const range = findHeadingRange(lines, sectionHeading);
    if (range) {
      let insertAt = range.endLine;
      while (insertAt > range.startLine + 1 && lines[insertAt - 1]!.trim() === "") {
        insertAt -= 1;
      }
      const appendLines = trimmedAppend.split(/\r?\n/);
      // Se o bloco ja vier com heading repetido identico, remove a primeira linha
      if (
        appendLines.length > 1 &&
        normalizeHeadingForMatch(appendLines[0]!) === normalizeHeadingForMatch(lines[range.startLine]!)
      ) {
        appendLines.shift();
      }
      lines.splice(insertAt, 0, ...appendLines);
      return `${frontmatterBlock}${lines.join("\n").trimEnd()}\n`;
    }
  }

  const footerPattern =
    /\r?\n---\r?\n+(?:##\s+(?:🔗\s*)?Conexões Relacionadas|\*\*Links Relacionados:\*\*)/i;
  const footerMatch = body.match(footerPattern);

  const blockToAppend =
    sectionHeading && !trimmedAppend.startsWith("#")
      ? `## ${sectionHeading.replace(/^#{1,6}\s+/, "").trim()}\n${trimmedAppend}`
      : trimmedAppend;

  let updatedBody: string;
  if (footerMatch && footerMatch.index !== undefined) {
    const beforeFooter = body.slice(0, footerMatch.index).trimEnd();
    const footer = body.slice(footerMatch.index).trimStart();
    updatedBody = `${beforeFooter}\n\n${blockToAppend}\n\n${footer}`.trimEnd();
  } else {
    updatedBody = `${body.trimEnd()}\n\n${blockToAppend}`.trimEnd();
  }

  return `${frontmatterBlock}${updatedBody}\n`;
}

/** Substitui ou cria uma secao especifica em uma nota existente sem duplicar conteudo. */
export function updateSectionInExistingNote(params: {
  existingContent: string;
  sectionHeading: string;
  replacementMarkdown: string;
  newTags?: readonly string[] | undefined;
  newAliases?: readonly string[] | undefined;
  updatedAt: Date;
}): string {
  const {
    existingContent,
    sectionHeading,
    replacementMarkdown,
    newTags,
    newAliases,
    updatedAt,
  } = params;
  const { frontmatterBlock, body } = updateYamlFrontmatterTimestampAndLists(
    existingContent,
    updatedAt,
    newTags,
    newAliases,
  );

  const lines = body.split(/\r?\n/);
  const range = findHeadingRange(lines, sectionHeading);
  if (!range) {
    return mergeIntoExistingNote({
      existingContent,
      appendSectionMarkdown: replacementMarkdown,
      sectionHeading,
      newTags,
      newAliases,
      updatedAt,
    });
  }

  const replacementLines = replacementMarkdown.trim().split(/\r?\n/);
  if (
    replacementLines.length > 0 &&
    normalizeHeadingForMatch(replacementLines[0]!) ===
    normalizeHeadingForMatch(lines[range.startLine]!)
  ) {
    replacementLines.shift();
  }

  const trailingBlank = range.endLine < lines.length ? [""] : [];
  lines.splice(
    range.startLine + 1,
    range.endLine - (range.startLine + 1),
    ...replacementLines,
    ...trailingBlank,
  );

  return `${frontmatterBlock}${lines.join("\n").trimEnd()}\n`;
}

/**
 * Aplica uma evolucao no Perfil Mestre (`00_Perfil_Mestre_Jefherson.md`):
 * atualiza/adiciona o fato na secao alvo dentro de `Estado Atual` e
 * registra a entrada carimbada com `[YYYY-MM-DD]` em `Historico de Evolucao`.
 */
export function applyProfileUpdate(params: {
  profileContent: string;
  sectionToUpdate: string;
  updatedFactMarkdown: string;
  changelogEntry: string;
  updatedAt: Date;
}): string {
  const { profileContent, sectionToUpdate, updatedFactMarkdown, changelogEntry, updatedAt } =
    params;
  const { frontmatterBlock, body } = updateYamlFrontmatterTimestampAndLists(
    profileContent,
    updatedAt,
  );

  const lines = body.split(/\r?\n/);
  const cleanSection = sectionToUpdate.replace(/^#{1,6}\s+/, "").trim();
  const factLines = updatedFactMarkdown.trim().split(/\r?\n/);
  const dateStamp = formatDateOnly(updatedAt);
  const formattedChangelog = /^-\s*\[?\d{4}-\d{2}-\d{2}/.test(changelogEntry.trim())
    ? changelogEntry.trim()
    : `- \`[${dateStamp}]\` ${changelogEntry.trim().replace(/^-\s*/, "")}`;

  const normTarget = normalizeHeadingForMatch(cleanSection);
  const historyIdx = lines.findIndex((l) => /^##\s+Hist[oó]rico de Evolu[cç][aã]o/i.test(l));
  const searchLimit = historyIdx !== -1 ? historyIdx : lines.length;

  let sectionIdx = -1;
  for (let i = 0; i < searchLimit; i++) {
    const m = lines[i]!.match(/^###\s+(.+)$/);
    if (m && normalizeHeadingForMatch(m[1]!).includes(normTarget)) {
      sectionIdx = i;
      break;
    }
  }

  if (sectionIdx !== -1) {
    let insertIdx = sectionIdx + 1;
    while (insertIdx < searchLimit && !/^#{2,3}\s+/.test(lines[insertIdx]!)) {
      insertIdx += 1;
    }
    while (insertIdx > sectionIdx + 1 && lines[insertIdx - 1]!.trim() === "") {
      insertIdx -= 1;
    }

    for (const factLineRaw of factLines) {
      const factLine = factLineRaw.trim();
      if (!factLine) {
        continue;
      }
      const keyMatch = factLine.match(/^-\s+\*\*([^*]+):\*\*/);
      let replaced = false;
      if (keyMatch && keyMatch[1]) {
        const prefix = `- **${keyMatch[1].toLowerCase()}:**`;
        for (let i = sectionIdx + 1; i < insertIdx; i++) {
          if (lines[i]!.trim().toLowerCase().startsWith(prefix)) {
            lines[i] = factLine;
            replaced = true;
            break;
          }
        }
      }

      if (!replaced && !lines.slice(sectionIdx + 1, insertIdx).some((l) => l.trim() === factLine)) {
        lines.splice(insertIdx, 0, factLine);
        insertIdx += 1;
      }
    }
  } else {
    const fallbackIdx = historyIdx !== -1 ? historyIdx : lines.length;
    lines.splice(fallbackIdx, 0, `### ${cleanSection}`, ...factLines, "");
  }

  const newHistoryIdx = lines.findIndex((l) => /^##\s+Hist[oó]rico de Evolu[cç][aã]o/i.test(l));
  if (newHistoryIdx !== -1) {
    let endHistoryIdx = newHistoryIdx + 1;
    while (
      endHistoryIdx < lines.length &&
      !/^##\s+/.test(lines[endHistoryIdx]!) &&
      !/^---$/.test(lines[endHistoryIdx]!.trim())
    ) {
      endHistoryIdx += 1;
    }
    while (endHistoryIdx > newHistoryIdx + 1 && lines[endHistoryIdx - 1]!.trim() === "") {
      endHistoryIdx -= 1;
    }
    if (!lines.slice(newHistoryIdx + 1, endHistoryIdx).some((l) => l.trim() === formattedChangelog)) {
      lines.splice(endHistoryIdx, 0, formattedChangelog);
    }
  } else {
    lines.push("", "## Histórico de Evolução (Changelog Pessoal)", formattedChangelog);
  }

  return `${frontmatterBlock}${lines.join("\n").trimEnd()}\n`;
}

/**
 * Copia arquivo bruto processado para `.automacao/processed_archive/` e mantém no maximo `maxEntries` arquivos recentes.
 */
export async function archiveProcessedFile(params: {
  sourcePath: string;
  originalFilename: string;
  archiveDir: string;
  now?: Date;
  maxEntries?: number;
}): Promise<string> {
  const { sourcePath, originalFilename, archiveDir, now = new Date(), maxEntries = 100 } = params;
  await withFsRetry(() => fs.mkdir(archiveDir, { recursive: true }), "archive:mkdir");

  const ext = path.extname(originalFilename) || ".md";
  const safeBase = sanitizeFilename(originalFilename).replace(/\.md$/i, "");
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const archiveName = `${stamp}_${safeBase}${ext}`;
  const archivePath = path.join(archiveDir, archiveName);

  await withFsRetry(() => fs.copyFile(sourcePath, archivePath), `archive:copy:${originalFilename}`);

  const entries = await withFsRetry(
    () => fs.readdir(archiveDir, { withFileTypes: true }),
    "archive:readdir",
  );
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  if (files.length > maxEntries) {
    const toRemove = files.slice(0, files.length - maxEntries);
    for (const oldFile of toRemove) {
      await fs.unlink(path.join(archiveDir, oldFile)).catch(() => undefined);
    }
  }

  return archivePath;
}

/** Grava no `vault-index.json` o SHA-256 exato escrito pelo bot para impedir re-processamento (anti-loop). */
export async function recordBotWriteHash(params: {
  indexCachePath: string;
  relPath: string;
  content: string;
  mtimeMs?: number | undefined;
  size?: number | undefined;
}): Promise<string> {
  const { indexCachePath, relPath, content } = params;
  const normalizedRel = normalizeVaultPath(relPath);
  const hash = computeContentHash(content);
  const cache = await loadIndexCache(indexCachePath);
  const baseName = normalizeNFC(path.basename(normalizedRel).replace(/\.(?:md|txt)$/i, ""));
  const mtimeMs = params.mtimeMs ?? Date.now();
  const size = params.size ?? Buffer.byteLength(content, "utf8");
  const parsed = extractNoteSummary(content, normalizedRel, mtimeMs, size);
  const { relativePath: _ignored, ...rest } = parsed;

  cache.entries[normalizedRel] = {
    ...rest,
    name: rest.name || baseName,
    lastBotWriteHash: hash,
  };

  await atomicWriteFile(indexCachePath, JSON.stringify(cache, null, 2));
  return hash;
}

/** Retorna a entrada em cache de uma nota especifica em `vault-index.json`, se existir. */
export async function getCachedIndexEntry(
  indexCachePath: string,
  relPath: string,
): Promise<Omit<ExistingNoteSummary, "relativePath"> | undefined> {
  const cache = await loadIndexCache(indexCachePath);
  return cache.entries[normalizeVaultPath(relPath)];
}

/** Remove uma entrada especifica de `vault-index.json`. */
export async function removeCachedIndexEntry(
  indexCachePath: string,
  relPath: string,
): Promise<void> {
  const cache = await loadIndexCache(indexCachePath);
  const norm = normalizeVaultPath(relPath);
  if (norm in cache.entries) {
    delete cache.entries[norm];
    await atomicWriteFile(indexCachePath, JSON.stringify(cache, null, 2));
  }
}

/** Varre todas as notas dos 5 pilares e preenche `lastBotWriteHash` com o estado atual em disco. */
export async function refreshAllBotWriteHashes(
  vaultRoot: string,
  indexCachePath: string,
): Promise<number> {
  const cache = await loadIndexCache(indexCachePath);
  const nextEntries: VaultIndexCache["entries"] = {};
  let count = 0;

  async function walk(absDir: string, relDir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const absPath = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absPath, `${relDir}/${entry.name}`);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const relPath = `${relDir}/${entry.name}`;
        try {
          const [st, content] = await Promise.all([
            fs.stat(absPath),
            fs.readFile(absPath, "utf8"),
          ]);
          const parsed = extractNoteSummary(content, relPath, st.mtimeMs, st.size);
          const { relativePath: _ignored, ...rest } = parsed;
          nextEntries[relPath] = {
            ...rest,
            lastBotWriteHash: computeContentHash(content),
          };
          count += 1;
        } catch {
          if (cache.entries[relPath]) {
            nextEntries[relPath] = cache.entries[relPath]!;
          }
        }
      }
    }
  }

  for (const rootFolder of ROOT_FOLDERS) {
    await walk(path.join(vaultRoot, rootFolder), rootFolder);
  }

  await atomicWriteFile(indexCachePath, JSON.stringify({ version: 1, entries: nextEntries }, null, 2));
  return count;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove `[[Wikilinks]]` quebrados que apontavam para uma nota excluida em todo o cofre.
 * Atualiza tambem `lastBotWriteHash` das notas ajustadas quando `indexCachePath` e informado.
 */
export async function removeBrokenWikilinksFromVault(params: {
  vaultRoot: string;
  deletedRelPathOrName: string;
  indexCachePath?: string | undefined;
}): Promise<string[]> {
  const { vaultRoot, deletedRelPathOrName, indexCachePath } = params;
  const norm = normalizeNFC(deletedRelPathOrName).replace(/\\/g, "/").replace(/\.md$/i, "");
  const stem = path.posix.basename(norm);
  const targets = Array.from(new Set([stem, norm].filter(Boolean))).map(escapeRegex);
  if (targets.length === 0) {
    return [];
  }

  const targetAlternation = `(?:${targets.join("|")})`;
  const bulletOnlyLineRegex = new RegExp(
    `^\\s*[-*]\\s*\\[\\[${targetAlternation}(?:\\|[^\\]]+)?\\]\\]\\s*$`,
    "i",
  );
  const inlineLinkRegex = new RegExp(
    `\\[\\[${targetAlternation}(?:\\|([^\\]]+))?\\]\\]`,
    "gi",
  );

  const modifiedRelPaths: string[] = [];

  async function walk(absDir: string, relDir: string): Promise<void> {
    let entries;
    try {
      entries = await withFsRetry(
        () => fs.readdir(absDir, { withFileTypes: true }),
        `links:readdir:${relDir}`,
      );
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const absPath = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absPath, `${relDir}/${entry.name}`);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const relPath = normalizeVaultPath(`${relDir}/${entry.name}`);
        let content: string;
        try {
          content = await readFileWithRetry(absPath);
        } catch {
          continue;
        }
        const originalLines = content.split(/\r?\n/);
        const nextLines: string[] = [];
        let changed = false;

        for (const line of originalLines) {
          if (bulletOnlyLineRegex.test(line)) {
            changed = true;
            continue;
          }
          const replaced = line.replace(inlineLinkRegex, (_full, alias?: string) => {
            changed = true;
            return alias?.trim() || stem;
          });
          nextLines.push(replaced);
        }

        if (changed) {
          const updatedContent = nextLines.join("\n");
          await atomicWriteFile(absPath, updatedContent);
          modifiedRelPaths.push(relPath);
          if (indexCachePath) {
            const st = await fs.stat(absPath).catch(() => null);
            await recordBotWriteHash({
              indexCachePath,
              relPath,
              content: updatedContent,
              mtimeMs: st?.mtimeMs,
              size: st?.size,
            }).catch(() => undefined);
          }
        }
      }
    }
  }

  for (const rootFolder of ROOT_FOLDERS) {
    await walk(path.join(vaultRoot, rootFolder), rootFolder);
  }

  return modifiedRelPaths;
}

/**
 * Move uma nota vazia (ou apenas YAML sem corpo) para `.automacao/trash/`
 * e remove quaisquer `[[Wikilinks]]` quebrados que apontavam para ela.
 */
export async function moveEmptyNoteToTrash(params: {
  absPath: string;
  relPath: string;
  vaultRoot: string;
  trashDir: string;
  indexCachePath?: string | undefined;
  now?: Date | undefined;
}): Promise<{ trashPath: string; cleanedLinksIn: string[] }> {
  const { absPath, relPath, vaultRoot, trashDir, indexCachePath, now = new Date() } = params;
  await withFsRetry(() => fs.mkdir(trashDir, { recursive: true }), "trash:mkdir");

  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeBase = sanitizeFilename(path.basename(relPath));
  const trashPath = path.join(trashDir, `${stamp}_${safeBase}`);

  await withFsRetry(() => fs.copyFile(absPath, trashPath), `trash:copy:${relPath}`);
  await withFsRetry(() => fs.unlink(absPath), `trash:unlink:${relPath}`);

  if (indexCachePath) {
    await removeCachedIndexEntry(indexCachePath, relPath).catch(() => undefined);
  }

  const cleanedLinksIn = await removeBrokenWikilinksFromVault({
    vaultRoot,
    deletedRelPathOrName: relPath,
    indexCachePath,
  });

  return { trashPath, cleanedLinksIn };
}

/** Atualiza apenas `updated:` e garante carimbo de data em linha editada manualmente quando IA estiver offline. */
export function stampUserEditedNoteFallback(content: string, editedAt: Date): string {
  const { frontmatterBlock, body } = updateYamlFrontmatterTimestampAndLists(content, editedAt);
  const displayDate = formatDisplayDateTime(editedAt);
  const trimmedBody = body.trimEnd();
  if (!trimmedBody) {
    return `${frontmatterBlock}`;
  }

  const lines = trimmedBody.split(/\r?\n/);
  const footerIdx = lines.findIndex((l) =>
    /^##\s+(?:🔗\s*)?Conexões Relacionadas/i.test(l.trim()),
  );
  const limitIdx = footerIdx !== -1 ? footerIdx : lines.length;

  let targetIdx = -1;
  for (let i = limitIdx - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed && !/^---$/.test(trimmed)) {
      targetIdx = i;
      break;
    }
  }

  const dateOnly = displayDate.slice(0, 10);
  if (
    targetIdx !== -1 &&
    !lines[targetIdx]!.includes("📅") &&
    !(dateOnly.length === 10 && lines[targetIdx]!.includes(dateOnly))
  ) {
    const line = lines[targetIdx]!;
    if (/^#{2,3}\s+/.test(line)) {
      lines[targetIdx] = `${line.trimEnd()} \`📅 ${displayDate}\``;
    } else if (!/^\|/.test(line.trim())) {
      lines[targetIdx] = `${line.trimEnd()} *(📅 ${displayDate})*`;
    }
  }

  return `${frontmatterBlock}${lines.join("\n").trimEnd()}\n`;
}

export type GdocReadResult =
  | { ok: true; docId: string; text: string; url?: string | undefined }
  | { ok: false; reason: string; docId?: string | undefined };

/**
 * Tenta ler JSON de um arquivo `.gdoc` no Google Drive Desktop e baixar o texto plano via `/export?format=txt`.
 * Trata erros de arquivo virtual do Drive Desktop e redirecionamentos 401/403 sem travar o daemon.
 */
export async function tryReadGdocExport(gdocAbsPath: string): Promise<GdocReadResult> {
  let rawJson: string;
  try {
    const st = await fs.stat(gdocAbsPath);
    if (!st.isFile()) {
      return { ok: false, reason: "drive_virtual_shortcut" };
    }
    rawJson = await fs.readFile(gdocAbsPath, "utf8");
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "EISDIR" || code === "EPERM" || code === "EINVAL") {
      return { ok: false, reason: "drive_virtual_shortcut" };
    }
    return {
      ok: false,
      reason: `read_error:${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let parsed: { doc_id?: unknown; resource_id?: unknown; url?: unknown };
  try {
    parsed = JSON.parse(rawJson) as { doc_id?: unknown; resource_id?: unknown; url?: unknown };
  } catch {
    return { ok: false, reason: "invalid_gdoc_json" };
  }

  const docId =
    typeof parsed.doc_id === "string" && parsed.doc_id.trim()
      ? parsed.doc_id.trim()
      : typeof parsed.resource_id === "string" && parsed.resource_id.trim()
        ? parsed.resource_id.trim()
        : "";
  const url = typeof parsed.url === "string" ? parsed.url : undefined;

  if (!docId) {
    return { ok: false, reason: "missing_doc_id" };
  }

  const exportUrl = `https://docs.google.com/document/d/${encodeURIComponent(docId)}/export?format=txt`;
  try {
    const response = await fetch(exportUrl, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
    });

    if (!response.ok) {
      return { ok: false, reason: `http_${response.status}`, docId };
    }

    const text = await response.text();
    if (
      /<!doctype html/i.test(text) ||
      (/<html/i.test(text) && /accounts\.google\.com|ServiceLogin/i.test(text))
    ) {
      return { ok: false, reason: "http_401_login_required", docId };
    }

    return { ok: true, docId, text, url };
  } catch (err: unknown) {
    return {
      ok: false,
      reason: `fetch_error:${err instanceof Error ? err.message : String(err)}`,
      docId,
    };
  }
}
