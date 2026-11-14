import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import {
  buildTieredModelChain,
  FALLBACK_MODELS,
  GEMINI_MODEL_FAST_DEFAULT,
  GEMINI_MODEL_HEAVY_DEFAULT,
  GEMINI_MODEL_PRIMARY_DEFAULT,
  HEAVY_INPUT_THRESHOLD_CHARS,
  type Category,
  type ModelTier,
} from "./config.js";
import { atomicWriteFile, readFileWithRetry } from "./lib/atomic-write.js";
import {
  mergePropertyList,
  parseNoteFrontmatter,
  serializeNoteFrontmatter,
} from "./lib/frontmatter.js";
import { jaccard, tokenize } from "./lib/memory-similarity.js";
import { normalizeNFC } from "./lib/unicode.js";
import type { Logger } from "./logger.js";
import {
  formatDisplayDateTime,
  selectTopRelevantSummaries,
  type OrganizedNotePayload,
  type OrganizeOperation,
  type VaultContext,
} from "./vault.js";

const VALID_CATEGORIES = [
  "pessoas",
  "projetos_negocios",
  "faculdade_estudos",
  "padroes_prompts",
  "pessoal_vida",
] as const;

const FrontmatterSchema = z
  .object({
    title: z.string().optional().default("Nota Organizada"),
    aliases: z.array(z.string()).optional().default([]),
    tags: z.array(z.string()).optional().default([]),
    relacionamento: z.string().optional(),
    created: z.string().optional().default(""),
    updated: z.string().optional().default(""),
    category: z.enum(VALID_CATEGORIES).catch("pessoal_vida" satisfies Category),
    status: z.enum(["rascunho", "ativo", "referencia", "arquivado"]).catch("ativo"),
  })
  .transform((fm) => {
    const cleanTitle = fm.title.trim() || "Nota Organizada";
    const cleanAliases = fm.aliases.map((a) => a.trim()).filter(Boolean).slice(0, 8);
    const cleanTags = fm.tags.map((t) => t.trim()).filter(Boolean).slice(0, 10);
    return {
      title: cleanTitle,
      aliases: cleanAliases.length > 0 ? cleanAliases : [cleanTitle],
      tags: cleanTags.length > 0 ? cleanTags : ["nota"],
      ...(fm.relacionamento ? { relacionamento: fm.relacionamento } : {}),
      created: fm.created.trim() || "2026-11-14 00:00",
      updated: fm.updated.trim() || "2026-11-14 00:00",
      category: fm.category,
      status: fm.status,
    };
  });

const RawOperationSchema = z.object({
  action: z.enum([
    "APPEND_TO_EXISTING",
    "UPDATE_SECTION_IN_EXISTING",
    "CREATE_NEW",
    "SKIP_DUPLICATE",
  ]),
  target_path: z.string().min(1),
  section_heading: z.string().optional(),
  content_markdown: z.string().optional(),
  markdown_body: z.string().optional(),
  content: z.string().optional(),
  new_tags: z.array(z.string()).optional(),
  new_aliases: z.array(z.string()).optional(),
  changelog_entry: z.string().optional(),
  suggested_filename: z.string().optional(),
  frontmatter: FrontmatterSchema.optional(),
  duplicate_reason: z.string().optional(),
});

const OperationSchema = RawOperationSchema.transform(({ markdown_body, content, ...rest }) => {
  const merged = (rest.content_markdown ?? markdown_body ?? content ?? "").trim();
  const normalized: OrganizeOperation = {
    action: rest.action,
    target_path: rest.target_path,
    ...(rest.section_heading !== undefined ? { section_heading: rest.section_heading } : {}),
    ...(merged.length > 0 ? { content_markdown: merged } : {}),
    ...(rest.new_tags !== undefined ? { new_tags: rest.new_tags } : {}),
    ...(rest.new_aliases !== undefined ? { new_aliases: rest.new_aliases } : {}),
    ...(rest.changelog_entry !== undefined ? { changelog_entry: rest.changelog_entry } : {}),
    ...(rest.suggested_filename !== undefined ? { suggested_filename: rest.suggested_filename } : {}),
    ...(rest.frontmatter !== undefined ? { frontmatter: rest.frontmatter } : {}),
    ...(rest.duplicate_reason !== undefined ? { duplicate_reason: rest.duplicate_reason } : {}),
  };
  return normalized;
});

const MultiOperationsResponseSchema = z
  .object({
    operations: z.array(OperationSchema).min(1).max(120),
  })
  .transform((data) => {
    // Descarta operacoes de escrita sem conteudo para que 1 item vazio nao derrube o lote inteiro
    const validOps = data.operations.filter((op) => {
      if (op.action === "SKIP_DUPLICATE") {
        return true;
      }
      return Boolean(op.content_markdown && op.content_markdown.trim().length > 0);
    });
    return {
      operations: validOps.length > 0 ? validOps : [data.operations[0]!],
    };
  })
  .refine(
    (data) =>
      data.operations.every(
        (op) =>
          op.action === "SKIP_DUPLICATE" ||
          Boolean(op.content_markdown && op.content_markdown.trim().length > 0),
      ),
    {
      message: "Nenhuma operacao com content_markdown valido retornada.",
    },
  );

export class TransientNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientNetworkError";
  }
}

export class AllKeysExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllKeysExhaustedError";
  }
}

export type GeminiClientRunner = (
  apiKey: string,
  model: string,
  prompt: string,
  schema: Record<string, unknown>,
  systemInstructionOverride?: string,
) => Promise<string>;

export interface RefineNoteResult {
  updated_markdown: string;
  extracted_operations?: OrganizeOperation[] | undefined;
}

const RefineNoteResponseSchema = z.object({
  updated_markdown: z.string().min(1),
  extracted_operations: z.array(OperationSchema).optional(),
});

export interface MergeTargetResult {
  action: "UPDATE" | "NO_OP";
  reason?: string | undefined;
  updated_markdown?: string | undefined;
}

const MergeTargetResponseSchema = z
  .object({
    action: z.enum(["UPDATE", "NO_OP"]),
    reason: z.string().optional(),
    updated_markdown: z.string().optional(),
  })
  .refine(
    (data) =>
      data.action === "NO_OP" ||
      Boolean(data.updated_markdown && data.updated_markdown.trim().length > 0),
    {
      message: "UPDATE exige updated_markdown nao vazio.",
    },
  );

export interface GeminiExecutionMeta {
  modelUsed: string;
  keyNumber: number;
}

export interface NoteOrganizerAI {
  organizeNote(params: {
    originalFilename: string;
    rawContent: string;
    createdStr: string;
    updatedStr: string;
    historicalDateStr?: string | undefined;
    vaultContext: VaultContext;
    isChatDump?: boolean;
  }): Promise<OrganizedNotePayload>;
  refineExistingNote?(params: {
    relativePath: string;
    currentContent: string;
    updatedStr: string;
    historicalDateStr: string;
    vaultContext: VaultContext;
  }): Promise<RefineNoteResult>;
  mergeWithExistingNote?(params: {
    relativePath: string;
    existingContent: string;
    incomingOps: readonly OrganizeOperation[];
    originalFilename: string;
    historicalDateStr: string;
    updatedStr: string;
  }): Promise<MergeTargetResult>;
  getLastExecutionMeta?(): GeminiExecutionMeta | undefined;
}

const NETWORK_ERROR_PATTERNS = [
  "enotfound",
  "etimedout",
  "econnreset",
  "econnrefused",
  "eai_again",
  "fetch failed",
  "network",
  "socket hang up",
  "und_err_",
];

/** Identifica se o erro representa falta de internet/conectividade temporaria. */
export function isTransientNetworkError(err: unknown): boolean {
  const text = (err instanceof Error ? `${err.name} ${err.message}` : String(err)).toLowerCase();
  return NETWORK_ERROR_PATTERNS.some((pattern) => text.includes(pattern));
}

function isApiKeyInvalidError(err: unknown): boolean {
  const text = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    text.includes("api_key_invalid") ||
    text.includes("api key not valid") ||
    text.includes("api keys are not supported") ||
    text.includes("401")
  );
}

function isModelFallbackEligibleError(err: unknown): boolean {
  if (isTransientNetworkError(err) || isApiKeyInvalidError(err)) {
    return false;
  }
  const text = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    text.includes("404") ||
    text.includes("403") ||
    text.includes("429") ||
    text.includes("500") ||
    text.includes("503") ||
    text.includes("resource_exhausted") ||
    text.includes("quota") ||
    text.includes("rate limit") ||
    text.includes("permission_denied") ||
    text.includes("not found") ||
    text.includes("unavailable") ||
    text.includes("overloaded") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("aborted") ||
    text.includes("deadline") ||
    text.includes("is not supported") ||
    (text.includes("model") && (text.includes("invalid") || text.includes("unknown")))
  );
}

function isLongTermUnavailableForKey(err: unknown): boolean {
  const errMsg = err instanceof Error ? err.message : String(err);
  const lower = errMsg.toLowerCase();
  return (
    lower.includes("404") ||
    lower.includes("not found") ||
    lower.includes("403") ||
    lower.includes("permission_denied") ||
    lower.includes("is not supported") ||
    /limit\s*:\s*0/i.test(errMsg) ||
    /requests\s+per\s+day|per\s*day|generaterequestsperday|permodelperday/i.test(errMsg)
  );
}

function classifyApiFailure(err: unknown): {
  kind: "network" | "rate_or_server" | "invalid_key" | "other";
  cooldownMs: number;
  message: string;
} {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (isTransientNetworkError(err)) {
    return { kind: "network", cooldownMs: 0, message };
  }
  if (
    lower.includes("429") ||
    lower.includes("resource_exhausted") ||
    lower.includes("quota") ||
    lower.includes("rate limit") ||
    lower.includes("500") ||
    lower.includes("503") ||
    lower.includes("unavailable") ||
    lower.includes("model_chain_unavailable")
  ) {
    return { kind: "rate_or_server", cooldownMs: 120_000, message };
  }
  if (
    lower.includes("api_key_invalid") ||
    lower.includes("api key not valid") ||
    lower.includes("api keys are not supported") ||
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("permission_denied")
  ) {
    return { kind: "invalid_key", cooldownMs: 30 * 60_000, message };
  }
  return { kind: "other", cooldownMs: 0, message };
}

/** Gerencia o pool de chaves API com cooldown e rotacao automatica. */
export class KeyPool {
  private readonly keys: string[];
  private readonly cooldownUntil: number[];
  private activeIndex = 0;

  constructor(keys: readonly string[]) {
    this.keys = [...keys];
    this.cooldownUntil = keys.map(() => 0);
  }

  get size(): number {
    return this.keys.length;
  }

  /** Executa uma operacao rotacionando automaticamente entre chaves disponiveis em caso de erro de cota/servidor. */
  async executeWithFailover<T>(
    fn: (apiKey: string, keyNumber: number) => Promise<T>,
    logger: Logger,
    nowFn: () => number = Date.now,
  ): Promise<T> {
    if (this.keys.length === 0) {
      throw new AllKeysExhaustedError("Nenhuma chave API do Gemini configurada.");
    }

    const now = nowFn();
    const startIndex = this.activeIndex;
    let triedCount = 0;
    let lastError: unknown = null;

    for (let offset = 0; offset < this.keys.length; offset++) {
      const idx = (startIndex + offset) % this.keys.length;
      if ((this.cooldownUntil[idx] ?? 0) > now) {
        continue;
      }

      triedCount += 1;
      const keyNumber = idx + 1;

      try {
        const result = await fn(this.keys[idx]!, keyNumber);
        this.activeIndex = idx;
        return result;
      } catch (err: unknown) {
        lastError = err;
        const classified = classifyApiFailure(err);

        if (classified.kind === "network") {
          throw new TransientNetworkError(classified.message);
        }

        if (classified.kind === "rate_or_server" || classified.kind === "invalid_key") {
          this.cooldownUntil[idx] = nowFn() + classified.cooldownMs;
          const nextAvailable = this.findNextAvailableIndex(idx, nowFn());
          if (nextAvailable !== -1) {
            this.activeIndex = nextAvailable;
            await logger.warn(
              `Key #${keyNumber} falhou (${classified.kind}: ${classified.message}). ` +
              `Key #${nextAvailable + 1} activated`,
            );
          } else {
            await logger.error(
              `Key #${keyNumber} falhou (${classified.kind}). Nenhuma outra chave disponivel no momento.`,
            );
          }
          continue;
        }

        throw err;
      }
    }

    if (triedCount === 0 || lastError !== null) {
      throw new AllKeysExhaustedError(
        `Todas as ${this.keys.length} chaves em cooldown ou falharam. Ultimo erro: ${lastError instanceof Error ? lastError.message : String(lastError ?? "cooldown")
        }`,
      );
    }

    throw new AllKeysExhaustedError("Falha ao selecionar chave do pool.");
  }

  private findNextAvailableIndex(failedIdx: number, now: number): number {
    for (let offset = 1; offset < this.keys.length; offset++) {
      const candidate = (failedIdx + offset) % this.keys.length;
      if ((this.cooldownUntil[candidate] ?? 0) <= now) {
        return candidate;
      }
    }
    return -1;
  }
}

function buildJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      operations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "APPEND_TO_EXISTING",
                "UPDATE_SECTION_IN_EXISTING",
                "CREATE_NEW",
                "SKIP_DUPLICATE",
              ],
            },
            target_path: { type: "string" },
            section_heading: { type: "string" },
            content_markdown: {
              type: "string",
              description:
                "Conteudo Markdown estruturado completo a inserir/atualizar na nota alvo (ou motivo curto em SKIP_DUPLICATE).",
            },
            new_tags: {
              type: "array",
              items: { type: "string" },
            },
            new_aliases: {
              type: "array",
              items: { type: "string" },
            },
            changelog_entry: { type: "string" },
            suggested_filename: { type: "string" },
            frontmatter: {
              type: "object",
              properties: {
                title: { type: "string" },
                aliases: { type: "array", items: { type: "string" } },
                tags: { type: "array", items: { type: "string" } },
                relacionamento: { type: "string" },
                created: { type: "string" },
                updated: { type: "string" },
                category: {
                  type: "string",
                  enum: [...VALID_CATEGORIES],
                },
                status: {
                  type: "string",
                  enum: ["rascunho", "ativo", "referencia", "arquivado"],
                },
              },
              required: ["title", "aliases", "tags", "created", "updated", "category", "status"],
            },
            duplicate_reason: { type: "string" },
          },
          required: ["action", "target_path", "content_markdown"],
        },
      },
    },
    required: ["operations"],
  };
}

function buildRefineJsonSchema(): Record<string, unknown> {
  const organizeSchema = buildJsonSchema();
  const opItems = (organizeSchema.properties as Record<string, unknown>).operations;
  return {
    type: "object",
    properties: {
      updated_markdown: { type: "string" },
      extracted_operations: opItems,
    },
    required: ["updated_markdown"],
  };
}

function buildMergeJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: ["UPDATE", "NO_OP"] },
      reason: { type: "string" },
      updated_markdown: { type: "string" },
    },
    required: ["action"],
  };
}

const SectionFoldEditSchema = z.object({
  mode: z.enum(["REPLACE_SECTION", "APPEND_NEW_SECTION"]),
  target_heading: z.string().min(1),
  markdown: z.string().min(1),
});

const SectionFoldResponseSchema = z
  .object({
    action: z.enum(["UPDATE", "NO_OP"]),
    reason: z.string().optional(),
    section_edits: z.array(SectionFoldEditSchema).optional(),
    new_tags: z.array(z.string()).optional(),
    new_aliases: z.array(z.string()).optional(),
  })
  .refine(
    (data) =>
      data.action === "NO_OP" ||
      Boolean(data.section_edits && data.section_edits.length > 0),
    {
      message: "UPDATE em Section-Aware Wiki-Fold exige ao menos 1 item em section_edits.",
    },
  );

function buildSectionFoldJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: ["UPDATE", "NO_OP"] },
      reason: { type: "string" },
      section_edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["REPLACE_SECTION", "APPEND_NEW_SECTION"] },
            target_heading: { type: "string" },
            markdown: { type: "string" },
          },
          required: ["mode", "target_heading", "markdown"],
        },
      },
      new_tags: { type: "array", items: { type: "string" } },
      new_aliases: { type: "array", items: { type: "string" } },
    },
    required: ["action"],
  };
}

interface ParsedH2Section {
  headingLine: string;
  headingText: string;
  body: string;
}

function splitMarkdownBodyIntoH2Sections(body: string): {
  preamble: string;
  sections: ParsedH2Section[];
} {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const preambleLines: string[] = [];
  const sections: ParsedH2Section[] = [];
  let current: { headingLine: string; headingText: string; lines: string[] } | null = null;
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
    }

    if (!inFence && /^##\s+(.+)$/.test(line)) {
      if (current) {
        sections.push({
          headingLine: current.headingLine,
          headingText: current.headingText,
          body: current.lines.join("\n").trimEnd(),
        });
      }
      const match = line.match(/^##\s+(.+)$/);
      current = {
        headingLine: line.trim(),
        headingText: (match?.[1] ?? line).trim(),
        lines: [],
      };
      continue;
    }

    if (current) {
      current.lines.push(line);
    } else {
      preambleLines.push(line);
    }
  }

  if (current) {
    sections.push({
      headingLine: current.headingLine,
      headingText: current.headingText,
      body: current.lines.join("\n").trimEnd(),
    });
  }

  return {
    preamble: preambleLines.join("\n").trimEnd(),
    sections,
  };
}

function selectRelevantSectionsForFold(
  sections: readonly ParsedH2Section[],
  incomingOps: readonly OrganizeOperation[],
  maxTotalChars = 14_000,
): ParsedH2Section[] {
  const queryText = incomingOps
    .map((op) => `${op.section_heading ?? ""} ${op.content_markdown ?? ""}`)
    .join(" ");
  const queryTokens = tokenize(queryText);

  const scored = sections.map((sec, idx) => {
    const headingMatchBoost = incomingOps.some(
      (op) =>
        op.section_heading &&
        normalizeNFC(sec.headingText).toLowerCase().includes(normalizeNFC(op.section_heading).toLowerCase()),
    )
      ? 2.0
      : 0;
    const changelogBoost =
      /hist[oó]rico|changelog|conex[oõ]es/i.test(sec.headingText) ? 0.35 : 0;
    const lexical = jaccard(queryTokens, tokenize(`${sec.headingText} ${sec.body.slice(0, 2000)}`));
    return { sec, idx, score: headingMatchBoost + changelogBoost + lexical };
  });

  scored.sort((a, b) => b.score - a.score);

  const picked: ParsedH2Section[] = [];
  let budget = 0;
  for (const item of scored) {
    const len = item.sec.headingLine.length + item.sec.body.length;
    if (picked.length > 0 && budget + len > maxTotalChars) {
      continue;
    }
    picked.push(item.sec);
    budget += len;
    if (picked.length >= 4) break;
  }

  return picked;
}

function normalizeSectionHeadingForCompare(raw: string): string {
  return normalizeNFC(raw)
    .replace(/^#+\s*/, "")
    .replace(/`📅[^`]+`/g, "")
    .trim()
    .toLowerCase();
}

function applySectionFoldEdits(opts: {
  existingContent: string;
  incomingOps: readonly OrganizeOperation[];
  edits: readonly z.infer<typeof SectionFoldEditSchema>[];
  originalFilename: string;
  updatedStr: string;
  extraTags?: readonly string[] | undefined;
  extraAliases?: readonly string[] | undefined;
}): string {
  const parsed = parseNoteFrontmatter(opts.existingContent);
  const { preamble, sections } = splitMarkdownBodyIntoH2Sections(parsed.body);
  const working = sections.map((s) => ({ ...s }));

  for (const edit of opts.edits) {
    const cleanTarget = normalizeSectionHeadingForCompare(edit.target_heading);
    let cleanMd = normalizeNFC(edit.markdown).trim();
    const lines = cleanMd.split(/\r?\n/);
    const firstLine = (lines[0] ?? "").trim();
    let headingLine = firstLine.startsWith("## ")
      ? firstLine
      : `## ${normalizeNFC(edit.target_heading).replace(/^#+\s*/, "").trim()}`;
    let sectionBody = firstLine.startsWith("## ") ? lines.slice(1).join("\n").trim() : cleanMd;

    if (edit.mode === "REPLACE_SECTION") {
      const matchIdx = working.findIndex(
        (s) =>
          normalizeSectionHeadingForCompare(s.headingText) === cleanTarget ||
          normalizeSectionHeadingForCompare(s.headingText).includes(cleanTarget) ||
          cleanTarget.includes(normalizeSectionHeadingForCompare(s.headingText)),
      );
      if (matchIdx !== -1) {
        working[matchIdx] = {
          headingLine,
          headingText: headingLine.replace(/^##\s+/, "").trim(),
          body: sectionBody,
        };
        continue;
      }
    }

    const connectionsIdx = working.findIndex((s) =>
      /conex[oõ]es\s+relacionadas/i.test(s.headingText),
    );
    const inserted: ParsedH2Section = {
      headingLine,
      headingText: headingLine.replace(/^##\s+/, "").trim(),
      body: sectionBody,
    };
    if (connectionsIdx !== -1) {
      working.splice(connectionsIdx, 0, inserted);
    } else {
      working.push(inserted);
    }
  }

  const rebuiltSections = working.map((s) => `${s.headingLine}\n\n${s.body}`.trimEnd());
  const rebuiltBody = [preamble, ...rebuiltSections]
    .filter((chunk) => chunk.trim().length > 0)
    .join("\n\n");

  const props: Record<string, unknown> = { ...parsed.properties };
  props.updated = opts.updatedStr;
  if (!props.source_chat) {
    props.source_chat = normalizeNFC(opts.originalFilename);
  }
  const opTags = opts.incomingOps.flatMap((op) => op.new_tags ?? []);
  const allNewTags = [...opTags, ...(opts.extraTags ?? [])];
  if (allNewTags.length > 0) {
    props.tags = mergePropertyList(props.tags, allNewTags, true, 12);
  }
  const opAliases = opts.incomingOps.flatMap((op) => op.new_aliases ?? []);
  const allNewAliases = [...opAliases, ...(opts.extraAliases ?? [])];
  if (allNewAliases.length > 0) {
    props.aliases = mergePropertyList(props.aliases, allNewAliases, false, 10);
  }

  return parsed.hasFrontmatter
    ? serializeNoteFrontmatter(props, rebuiltBody)
    : `${rebuiltBody.trimEnd()}\n`;
}

const SYSTEM_INSTRUCTION = [
  "Voce e o Cortex Vault Engine (V6.0), motor autonomo de Wiki-Ingest e Second Brain Obsidian de Jefherson Luiz da Silva.",
  "REGRAS CRITICAS DE DESTILACAO (Wiki-Ingest), CALLOUTS OBSIDIAN, MERMAID E PESSOAS:",
  "1. DIVISOR MULTI-ASSUNTO (operations[]): Se a entrada mencionar varios temas independentes, FATIE em multiplas operacoes para os destinos exatos nos 5 pilares.",
  "2. NOTAS INDIVIDUAIS DE PESSOAS (01_Pessoas/): NUNCA agrupe pessoas em um unico arquivo. Cada pessoa citada recebe sua propria ficha em `01_Pessoas/<Nome da Pessoa>.md` (com YAML `relacionamento`), link `[[Nome da Pessoa]]` nas notas relacionadas e atualizacao em `01_Pessoas/00_Mapa_de_Pessoas.md`.",
  "3. OBSIDIAN FLAVORED MARKDOWN (obsidian-skills):",
  "   - Use Callouts nativos do Obsidian para destacar contexto: `> [!abstract] Resumo`, `> [!tip] Próximos Passos`, `> [!warning] Pontos de Atenção`, `> [!info] Arquitetura`.",
  "   - Em notas de arquitetura, banco de dados, fluxos ou sistemas (ex: `Kitsune Finance`, `DraftClub`, `System Optimizer`, `Sobrado Imbituba`, `Banco de Dados A3`), inclua um bloco Mermaid valido (` ```mermaid `) quando agregar clareza.",
  "   - Use `[[Wikilinks]]` densos conectando projetos, pessoas e conceitos existentes no cofre (nunca invente links para notas inexistentes fora deste lote).",
  "   - Carimbo de data discreto (`📅`): frontmatter YAML ja traz `created:`/`updated:`. NUNCA coloque `📅` no titulo `# H1`, nao repita `*(📅 ...)*` em todos os bullets e no maximo use `## Seção \\`📅 DD/MM/YYYY\\``.",
  "4. MINERACAO PROFUNDA DE CONVERSAS DE IA (CHAT_DISTILLER EM 2 FRENTES):",
  "   Quando a entrada for um chat exportado (`CHAT_DUMP`), NUNCA salve dialogo bruto ('Voce disse' / 'O Gemini disse'). Extraia em 2 frentes:",
  "   - FRENTE 1 (DNA Comportamental, Postura & Regras para IAs): Como Jefherson pensa, exige rigor tecnico, rejeita suposicoes/bypass/codigo duplicado -> emita operacoes para `05_Pessoal_e_Vida/00_Perfil_Mestre_Jefherson.md` (secao `Estilo Cognitivo, Comunicação e Trabalho com IA`, com `changelog_entry`) e/ou `04_Padroes_e_Prompts/`.",
  "   - FRENTE 2 (Fatos, Projetos, Decisoes Tecnicas, Codigo/SQL/Calculos): Destile todos os detalhes tecnicos concretos sem perder numeros, URLs, arquiteturas ou decisoes para `01_Pessoas/`, `02_Projetos_e_Negocios/`, `03_Faculdade_e_Estudos/` e `05_Pessoal_e_Vida/`.",
  "5. CONSOLIDACAO PRIORITARIA (Wiki-Fold sem fragmentacao):",
  "   - Pessoas individuais -> '01_Pessoas/<Nome>.md' + indice '01_Pessoas/00_Mapa_de_Pessoas.md'",
  "   - Bancos, Pix, E-Titulo, Contas/Acessos pessoais -> '05_Pessoal_e_Vida/Geral/Cofre Pessoal - Bancos, Contas e Acessos.md'",
  "   - Chaves de API/Tokens de dev/Supabase -> '02_Projetos_e_Negocios/Credenciais_e_Infra/Chaves de API e Credenciais Mestras.md'",
  "   - Faculdade UNISUL/A3/Provas/QA/GQS -> '03_Faculdade_e_Estudos/ADS_UNISUL/ADS UNISUL - Disciplinas, Provas e Projetos.md'",
  "   - Treinos/Academia/Corrida/Hand Grip/Saude -> '05_Pessoal_e_Vida/Treino_e_Saude/Ficha de Treino e Medidas Corporais.md' ou nota medica dedicada quando houver exames extensos.",
  "   - PC/Roteador/Monitor/SSD/Perifericos -> '05_Pessoal_e_Vida/Hardware_e_Setup/Setup do Computador (Especificações e Periféricos).md'",
  "   - Games/Pro Clubs/Witcher/OBS/Spotify -> '05_Pessoal_e_Vida/Gaming_e_Conteudo/Gaming, Pro Clubs, Mods e Live Stream.md'",
  "   - Perfil, DNA cognitivo, preferencias de IA, rotina, patrimonio -> '05_Pessoal_e_Vida/00_Perfil_Mestre_Jefherson.md' (com `changelog_entry`).",
  "6. USE 'CREATE_NEW' somente para dominios/projetos/pessoas ainda sem nota equivalente no cofre; caso contrario use 'APPEND_TO_EXISTING' / 'UPDATE_SECTION_IN_EXISTING', ou 'SKIP_DUPLICATE' se 100% redundante.",
].join("\n");

const REFINE_SYSTEM_INSTRUCTION = [
  "Voce e o Reorganizador Incremental (V6.0 Cortex) de notas existentes no cofre Obsidian de Jefherson Luiz da Silva.",
  "O usuario acabou de editar manualmente uma nota dentro das subpastas.",
  "SUAS REGRAS:",
  "1. Preserve 100% dos fatos validos e do frontmatter YAML (atualize `updated:` para o timestamp fornecido). Nunca apague dados reais.",
  "2. Organize com sintaxe Obsidian limpa: converta citacoes de pessoas/projetos em `[[Wikilinks]]` validos, remova headings vazios e use callouts (`> [!abstract]`, `> [!tip]`, `> [!warning]`) apenas quando melhorar a legibilidade sem alterar fatos.",
  "3. Carimbo de data discreto: NUNCA repita data no `# H1`, nao polua bullets irmaos e carimbe apenas novidades sem data.",
  "4. Se o usuario mencionou uma nova pessoa sem ficha em `01_Pessoas/` ou assunto de outro dossie, emita `extracted_operations[]` correspondentes.",
].join("\n");

const MERGE_SYSTEM_INSTRUCTION = [
  "Voce e o Motor Wiki-Fold Read-Before-Write (V6.0 Cortex) do cofre Obsidian de Jefherson Luiz da Silva.",
  "Sua tarefa e executar WIKI-FOLD cirurgico comparando o estado atual da nota alvo com os novos fatos extraidos.",
  "REGRAS OBRIGATORIAS:",
  "1. VERIFICACAO DE DUPLICATA: Se TODOS os fatos novos recebidos ja estiverem cobertos na nota atual, retorne `action: 'NO_OP'` com `reason` objetivo e NAO modifique a nota.",
  "2. WIKI-FOLD (ATUALIZACAO EM VEZ DE DUPLICACAO): Se um fato novo atualiza ou corrige um dado antigo, substitua apenas a informacao desatualizada preservando o restante da secao intacto.",
  "3. INSERCAO LIMPA + CALLOUTS: Para fatos genuinamente novos, insira na secao semanticamente exata (ou crie subsecao antes de `## 🔗 Conexões Relacionadas`), utilizando callouts Obsidian (`> [!abstract]`, `> [!tip]`, `> [!warning]`) e `[[Wikilinks]]` validos quando apropriado.",
  "4. YAML & CHANGELOG: Atualize `updated:` para o timestamp informado, mescle `new_tags`/`new_aliases` sem duplicar e NUNCA altere `created:`. Em `05_Pessoal_e_Vida/00_Perfil_Mestre_Jefherson.md`, atualize a secao alvo e adicione o resumo `[YYYY-MM-DD]` em `## Histórico de Evolução (Changelog Pessoal)`.",
  "5. CARIMBOS LIMPOS (`📅`): NAO coloque `📅` no titulo `# H1` nem polua todos os bullets.",
  "6. INTEGRIDADE TOTAL: Nunca resuma nem apague blocos, tabelas, diagramas Mermaid ou secoes existentes nao relacionadas a atualizacao.",
].join("\n");

const SECTION_FOLD_SYSTEM_INSTRUCTION = [
  "Voce e o Motor Section-Aware Wiki-Fold (V6.0 Cortex) para notas extensas do cofre Obsidian de Jefherson Luiz da Silva.",
  "Em vez de reescrever a nota inteira, voce recebe o INDICE DE SECOES (## H2) da nota atual, as secoes mais relevantes em texto integral e os novos fatos.",
  "Retorne JSON com `action: 'UPDATE'` (ou `'NO_OP'` se 100% ja estiver na nota) e `section_edits[]` contendo APENAS as secoes alteradas (`REPLACE_SECTION` com o heading exato da secao alvo e seu Markdown completo atualizado, ou `APPEND_NEW_SECTION` para uma secao inedita).",
  "Preserve integralmente tabelas, diagramas Mermaid, callouts e fatos existentes dentro da secao substituida, mesclando apenas o conhecimento novo/atualizado.",
].join("\n");

export const CHUNK_TRIGGER_CHARS = 32_000;
export const DEFAULT_CHUNK_MAX_CHARS = 28_000;

/**
 * Divide textos massivos (ex.: chats de 40 KB - 250 KB) em partes logicas respeitando headings e paragrafos.
 */
export function splitLargeTextIntoChunks(
  rawContent: string,
  maxChunkChars = DEFAULT_CHUNK_MAX_CHARS,
): string[] {
  if (rawContent.length <= maxChunkChars) {
    return [rawContent];
  }

  const lines = rawContent.split(/\r?\n/);
  const chunks: string[] = [];
  let currentLines: string[] = [];
  let currentLen = 0;
  const preferredBreakLen = Math.floor(maxChunkChars * 0.6);

  const flush = () => {
    const text = currentLines.join("\n").trim();
    if (text.length > 0) {
      chunks.push(text);
    }
    currentLines = [];
    currentLen = 0;
  };

  for (const line of lines) {
    if (line.length > maxChunkChars) {
      flush();
      for (let i = 0; i < line.length; i += maxChunkChars) {
        chunks.push(line.slice(i, i + maxChunkChars));
      }
      continue;
    }

    const lineCost = line.length + 1;
    const isHeadingBreak = /^#{1,3}\s/.test(line.trim());
    const isBlankBreak = line.trim().length === 0;

    if (
      currentLines.length > 0 &&
      (currentLen + lineCost > maxChunkChars ||
        (currentLen >= preferredBreakLen && (isHeadingBreak || isBlankBreak)))
    ) {
      flush();
    }

    currentLines.push(line);
    currentLen += lineCost;
  }

  flush();
  return chunks.length > 0 ? chunks : [rawContent];
}

/**
 * Consolida operacoes vindas de multiplos chunks: remove SKIP_DUPLICATE redundantes
 * quando ha escritas validas e mescla operacoes CREATE_NEW que apontam para o mesmo arquivo.
 */
export function consolidateChunkOperations(allOps: readonly OrganizeOperation[]): OrganizeOperation[] {
  const nonSkip = allOps.filter((op) => op.action !== "SKIP_DUPLICATE");
  if (nonSkip.length === 0) {
    return allOps.length > 0 ? [allOps[0]!] : [];
  }

  const result: OrganizeOperation[] = [];
  const createIndexByKey = new Map<string, number>();

  for (const op of nonSkip) {
    if (op.action === "CREATE_NEW") {
      const keyName = (op.suggested_filename ?? op.frontmatter?.title ?? op.target_path)
        .trim()
        .toLowerCase();
      const dedupKey = `${op.target_path.trim().toLowerCase()}::${keyName}`;
      const existingIdx = createIndexByKey.get(dedupKey);
      if (existingIdx !== undefined) {
        const prev = result[existingIdx]!;
        const mergedContent = [prev.content_markdown ?? "", op.content_markdown ?? ""]
          .map((s) => s.trim())
          .filter(Boolean)
          .join("\n\n");
        const mergedTags = Array.from(
          new Set([
            ...(prev.new_tags ?? []),
            ...(op.new_tags ?? []),
            ...(prev.frontmatter?.tags ?? []),
            ...(op.frontmatter?.tags ?? []),
          ]),
        );
        const mergedAliases = Array.from(
          new Set([
            ...(prev.new_aliases ?? []),
            ...(op.new_aliases ?? []),
            ...(prev.frontmatter?.aliases ?? []),
            ...(op.frontmatter?.aliases ?? []),
          ]),
        );

        result[existingIdx] = {
          ...prev,
          ...(mergedContent ? { content_markdown: mergedContent } : {}),
          ...(mergedTags.length > 0 ? { new_tags: mergedTags } : {}),
          ...(mergedAliases.length > 0 ? { new_aliases: mergedAliases } : {}),
          ...(prev.frontmatter
            ? {
                frontmatter: {
                  ...prev.frontmatter,
                  ...(mergedTags.length > 0 ? { tags: mergedTags.slice(0, 10) } : {}),
                  ...(mergedAliases.length > 0 ? { aliases: mergedAliases.slice(0, 8) } : {}),
                },
              }
            : {}),
        };
        continue;
      }
      createIndexByKey.set(dedupKey, result.length);
    }

    result.push(op);
  }

  return result;
}

/** Cria cliente Gemini V5.3 com Pool de Chaves, cache de quota zero, Chunked Map-Reduce e Tiered Model Routing. */
export function createGeminiOrganizer(params: {
  apiKeys: readonly string[];
  model?: string;
  modelPrimary?: string;
  modelHeavy?: string;
  modelFast?: string;
  heavyInputThresholdChars?: number;
  modelFallbacks?: readonly string[];
  checkpointsDir?: string | undefined;
  tempDir?: string | undefined;
  requestTimeoutMs?: number | undefined;
  logger: Logger;
  customRunner?: GeminiClientRunner;
  nowFn?: () => number;
}): NoteOrganizerAI {
  const pool = new KeyPool(params.apiKeys);
  const nowFn = params.nowFn ?? Date.now;
  const unavailableKeyModels = new Map<string, number>();
  const KEY_MODEL_UNAVAILABLE_TTL_MS = 6 * 60 * 60 * 1000;
  const requestTimeoutMs = params.requestTimeoutMs ?? 45_000;
  let lastExecutionMeta: GeminiExecutionMeta | undefined;

  const modelPrimary =
    params.modelPrimary?.trim() || params.model?.trim() || GEMINI_MODEL_PRIMARY_DEFAULT;
  const modelHeavy = params.modelHeavy?.trim() || GEMINI_MODEL_HEAVY_DEFAULT;
  const modelFast = params.modelFast?.trim() || GEMINI_MODEL_FAST_DEFAULT;
  const heavyThreshold = params.heavyInputThresholdChars ?? HEAVY_INPUT_THRESHOLD_CHARS;
  const baseFallbacks =
    params.modelFallbacks && params.modelFallbacks.length > 0
      ? [...params.modelFallbacks]
      : [...FALLBACK_MODELS];

  const defaultRunner: GeminiClientRunner = async (
    apiKey,
    model,
    prompt,
    schema,
    systemInstructionOverride,
  ) => {
    const ai = new GoogleGenAI({ apiKey });
    const sysInstruction = systemInstructionOverride ?? SYSTEM_INSTRUCTION;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Gemini API (${model}) timeout after ${requestTimeoutMs}ms.`));
      }, requestTimeoutMs);
    });

    try {
      if (process.env.USE_INTERACTIONS_API === "true") {
        const interactionsApi = (ai as unknown as {
          interactions?: {
            create?: (req: Record<string, unknown>) => Promise<{ output_text?: string }>;
          };
        }).interactions;

        if (typeof interactionsApi?.create === "function") {
          try {
            const interaction = await Promise.race([
              interactionsApi.create({
                model,
                input: prompt,
                system_instruction: sysInstruction,
                response_format: {
                  type: "text",
                  mime_type: "application/json",
                  schema,
                },
              }),
              timeoutPromise,
            ]);
            if (interaction.output_text && interaction.output_text.trim().length > 0) {
              return interaction.output_text;
            }
          } catch (interactionsErr: unknown) {
            if (isTransientNetworkError(interactionsErr) || isApiKeyInvalidError(interactionsErr)) {
              throw interactionsErr;
            }
          }
        }
      }

      const response = await Promise.race([
        ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction: sysInstruction,
            responseMimeType: "application/json",
            responseJsonSchema: schema,
            abortSignal: controller.signal,
          },
        }),
        timeoutPromise,
      ]);
      const rawOutput = response.text;
      if (!rawOutput) {
        throw new Error(`Gemini API (${model}) retornou resposta vazia sem text.`);
      }
      return rawOutput;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };

  const runner = params.customRunner ?? defaultRunner;

  const isKeyModelCachedUnavailable = (keyNumber: number, candidateModel: string): boolean => {
    const cacheKey = `${keyNumber}:${candidateModel}`;
    const expiresAt = unavailableKeyModels.get(cacheKey);
    if (expiresAt === undefined) {
      return false;
    }
    if (nowFn() >= expiresAt) {
      unavailableKeyModels.delete(cacheKey);
      return false;
    }
    return true;
  };

  const runPromptWithFallback = async (opts: {
    tier: ModelTier;
    contextLabel: string;
    prompt: string;
    schema: Record<string, unknown>;
    systemInstructionOverride?: string;
  }): Promise<string> => {
    const candidateModels = buildTieredModelChain({
      tier: opts.tier,
      modelPrimary,
      modelHeavy,
      modelFast,
      modelFallbacks: baseFallbacks,
    });

    return pool.executeWithFailover(
      async (apiKey, keyNumber) => {
        const filteredModels = candidateModels.filter(
          (m) => !isKeyModelCachedUnavailable(keyNumber, m),
        );
        if (filteredModels.length === 0) {
          throw new Error(
            `MODEL_CHAIN_UNAVAILABLE: Todos os ${candidateModels.length} modelos da Key #${keyNumber} estao no cache temporario de indisponibilidade/RPD.`,
          );
        }

        let lastModelErr: unknown = null;
        let allModelsUnavailable = true;
        for (let i = 0; i < filteredModels.length; i++) {
          const candidateModel = filteredModels[i]!;
          try {
            const output = await runner(
              apiKey,
              candidateModel,
              opts.prompt,
              opts.schema,
              opts.systemInstructionOverride,
            );
            lastExecutionMeta = { modelUsed: candidateModel, keyNumber };
            await params.logger.info(
              `✅ [OK] Processed (${opts.contextLabel}) via model=${candidateModel} (Key #${keyNumber})`,
            );
            return output;
          } catch (err: unknown) {
            lastModelErr = err;
            if (isModelFallbackEligibleError(err)) {
              const errMsg = err instanceof Error ? err.message : String(err);
              const lowerMsg = errMsg.toLowerCase();
              if (isLongTermUnavailableForKey(err)) {
                unavailableKeyModels.set(
                  `${keyNumber}:${candidateModel}`,
                  nowFn() + KEY_MODEL_UNAVAILABLE_TTL_MS,
                );
              }
              if (
                !lowerMsg.includes("404") &&
                !lowerMsg.includes("not found") &&
                !isLongTermUnavailableForKey(err)
              ) {
                allModelsUnavailable = false;
              }
              if (i < filteredModels.length - 1) {
                const nextModel = filteredModels[i + 1]!;
                await params.logger.warn(
                  `MODEL_FALLBACK: Modelo "${candidateModel}" indisponivel/limitado na Key #${keyNumber} (${errMsg}). Tentando "${nextModel}".`,
                );
                continue;
              }
            } else {
              allModelsUnavailable = false;
            }
            if (allModelsUnavailable && i === filteredModels.length - 1) {
              throw new Error(
                `MODEL_CHAIN_UNAVAILABLE: ${
                  lastModelErr instanceof Error ? lastModelErr.message : String(lastModelErr)
                }`,
              );
            }
            throw err;
          }
        }
        throw (
          lastModelErr ??
          new Error("MODEL_CHAIN_UNAVAILABLE: Nenhum modelo Gemini disponivel na cadeia de fallback.")
        );
      },
      params.logger,
      params.nowFn,
    );
  };

  return {
    getLastExecutionMeta(): GeminiExecutionMeta | undefined {
      return lastExecutionMeta;
    },

    async organizeNote({
      originalFilename,
      rawContent,
      createdStr,
      updatedStr,
      historicalDateStr,
      vaultContext,
      isChatDump = false,
    }): Promise<OrganizedNotePayload> {
      const effectiveHistoricalStamp = historicalDateStr ?? formatDisplayDateTime(new Date());
      const chunks =
        rawContent.length > CHUNK_TRIGGER_CHARS
          ? splitLargeTextIntoChunks(rawContent, DEFAULT_CHUNK_MAX_CHARS)
          : [rawContent];

      let checkpointPath: string | undefined;
      let completedChunkIndices = new Set<number>();
      const collectedOps: OrganizeOperation[] = [];

      if (chunks.length > 1) {
        await params.logger.info(
          `MAP_REDUCE_START (${originalFilename}): ${rawContent.length} chars divididos em ${chunks.length} partes.`,
        );
        if (params.checkpointsDir) {
          const hash = crypto
            .createHash("sha256")
            .update(`${originalFilename}:${rawContent.length}:${rawContent.slice(0, 1024)}`)
            .digest("hex")
            .slice(0, 16);
          checkpointPath = path.join(params.checkpointsDir, `mapreduce-${hash}.json`);
          try {
            const rawCkpt = await readFileWithRetry(checkpointPath);
            const ckpt = JSON.parse(rawCkpt) as {
              totalChunks?: number;
              completedChunkIndices?: number[];
              collectedOps?: OrganizeOperation[];
            };
            if (ckpt.totalChunks === chunks.length && Array.isArray(ckpt.collectedOps)) {
              completedChunkIndices = new Set(ckpt.completedChunkIndices ?? []);
              collectedOps.push(...ckpt.collectedOps);
              await params.logger.info(
                `CHECKPOINT_RESUME (${originalFilename}): retomando de ${completedChunkIndices.size}/${chunks.length} partes concluidas (${collectedOps.length} operacoes carregadas).`,
              );
            }
          } catch {
            // Sem checkpoint previo para esta nota.
          }
        }
      }

      let lastChunkError: unknown = null;

      for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        if (completedChunkIndices.has(chunkIdx)) {
          continue;
        }

        if (chunks.length > 1 && chunkIdx > 0 && !params.customRunner) {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
        }

        const chunkText = chunks[chunkIdx]!;
        const topSummaries = selectTopRelevantSummaries({
          rawContent: chunkText,
          originalFilename,
          summaries: vaultContext.summaries,
        });

        const compactSummaries = topSummaries.map((s) => ({
          path: s.relativePath,
          title: s.title,
          aliases: s.aliases,
          tags: s.tags,
          headings: s.headings,
        }));

        const partLabel =
          chunks.length > 1 ? ` (Parte ${chunkIdx + 1}/${chunks.length})` : "";
        const contextLabel = `${originalFilename}${partLabel}`;

        const prompt = [
          `Arquivo original: ${originalFilename}${partLabel}`,
          `Tipo de entrada: ${
            isChatDump
              ? "CHAT_DUMP (MINERACAO EM 2 FRENTES: Frente 1 = DNA comportamental, preferencias e regras de IA; Frente 2 = Fatos, Pessoas, Projetos e Estudos; descartar dialogo bruto)"
              : "NOTA_RAPIDA_OU_TEXTO (fatiar multiplos assuntos em operations[] se aplicavel)"
          }`,
          `created: ${createdStr}`,
          `updated: ${updatedStr}`,
          `Data de registro/origem para referencia (usar de forma discreta e sem repeticao): ${effectiveHistoricalStamp}`,
          ...(chunks.length > 1
            ? [
                `Atencao Map-Reduce: esta e a Parte ${chunkIdx + 1} de ${chunks.length} de um arquivo extenso. Extraia APENAS os aprendizados, regras, fatos, projetos e DNA comportamental presentes neste trecho, preenchendo content_markdown de forma concisa e completa.`,
              ]
            : []),
          "",
          "Pastas existentes nos 5 pilares ativos:",
          ...vaultContext.folders.map((folder) => `- ${folder}`),
          "",
          `Top ${compactSummaries.length} notas existentes (de ${vaultContext.summaries.length} totais) para Smart Merge, UPDATE_SECTION e Wikilinks:`,
          JSON.stringify(compactSummaries),
          "",
          "Conteudo bruto:",
          "<<<NOTA_BRUTA>>>",
          chunkText,
          "<<<FIM_NOTA_BRUTA>>>",
        ].join("\n");

        const tier: ModelTier =
          chunkText.length > heavyThreshold || isChatDump ? "heavy" : "primary";

        try {
          const rawOutput = await runPromptWithFallback({
            tier,
            contextLabel,
            prompt,
            schema: buildJsonSchema(),
          });
          const parsedJson: unknown = JSON.parse(rawOutput);
          const validated = MultiOperationsResponseSchema.parse(parsedJson);
          collectedOps.push(...validated.operations);
          completedChunkIndices.add(chunkIdx);

          if (checkpointPath) {
            await atomicWriteFile(
              checkpointPath,
              JSON.stringify(
                {
                  originalFilename,
                  totalChunks: chunks.length,
                  completedChunkIndices: [...completedChunkIndices],
                  collectedOps,
                  updatedAt: new Date().toISOString(),
                },
                null,
                2,
              ),
              params.tempDir,
            );
          }
        } catch (chunkErr: unknown) {
          if (chunkErr instanceof TransientNetworkError || chunkErr instanceof AllKeysExhaustedError) {
            throw chunkErr;
          }
          lastChunkError = chunkErr;
          if (chunks.length === 1) {
            throw chunkErr;
          }
          await params.logger.warn(
            `MAP_REDUCE_CHUNK_WARN (${contextLabel}): ${
              chunkErr instanceof Error ? chunkErr.message : String(chunkErr)
            }`,
          );
        }
      }

      if (checkpointPath) {
        await fs.unlink(checkpointPath).catch(() => undefined);
      }

      if (collectedOps.length === 0) {
        throw (
          lastChunkError ??
          new Error(`Nenhuma operacao extraida nos chunks de ${originalFilename}.`)
        );
      }

      return { operations: consolidateChunkOperations(collectedOps) };
    },

    async mergeWithExistingNote({
      relativePath,
      existingContent,
      incomingOps,
      originalFilename,
      historicalDateStr,
      updatedStr,
    }): Promise<MergeTargetResult> {
      const incomingJson = JSON.stringify(
        incomingOps.map((op) => ({
          action: op.action,
          section_heading: op.section_heading,
          content_markdown: op.content_markdown,
          new_tags: op.new_tags,
          new_aliases: op.new_aliases,
          changelog_entry: op.changelog_entry,
        })),
      );

      const parsedExisting = parseNoteFrontmatter(existingContent);
      const { sections } = splitMarkdownBodyIntoH2Sections(parsedExisting.body);
      const shouldUseSectionFold =
        (existingContent.length > 16_000 || incomingJson.length > 16_000) &&
        sections.length >= 2;

      if (shouldUseSectionFold) {
        const headingIndex = sections
          .map((s, idx) => `- [${idx}] ${s.headingLine} (${s.body.length} chars)`)
          .join("\n");
        const selectedSections = selectRelevantSectionsForFold(sections, incomingOps);
        const selectedText = selectedSections
          .map((s) => `${s.headingLine}\n\n${s.body}`.trimEnd())
          .join("\n\n---\n\n");

        const foldPrompt = [
          `Arquivo alvo existente (Section-Aware Wiki-Fold): ${relativePath}`,
          `Origem da atualizacao: ${originalFilename}`,
          `updated (YAML): ${updatedStr}`,
          `Data historica de referencia: ${historicalDateStr}`,
          "",
          "INDICE COMPLETO DE SECOES (## H2) DA NOTA EXISTENTE:",
          headingIndex,
          "",
          "SECOES CANDIDATAS RELEVANTES EM TEXTO INTEGRAL:",
          "<<<SECOES_EXISTENTES>>>",
          selectedText,
          "<<<FIM_SECOES_EXISTENTES>>>",
          "",
          "NOVOS FATOS / OPERACOES PARA WIKI-FOLD:",
          "<<<NOVOS_FATOS>>>",
          incomingJson,
          "<<<FIM_NOVOS_FATOS>>>",
        ].join("\n");

        const foldTier: ModelTier =
          selectedText.length + incomingJson.length > heavyThreshold ? "heavy" : "primary";
        const rawFoldOutput = await runPromptWithFallback({
          tier: foldTier,
          contextLabel: `wiki-fold:${relativePath}`,
          prompt: foldPrompt,
          schema: buildSectionFoldJsonSchema(),
          systemInstructionOverride: SECTION_FOLD_SYSTEM_INSTRUCTION,
        });
        const parsedJson: unknown = JSON.parse(rawFoldOutput);
        const foldParsed = SectionFoldResponseSchema.safeParse(parsedJson);

        if (foldParsed.success) {
          if (foldParsed.data.action === "NO_OP") {
            return {
              action: "NO_OP",
              ...(foldParsed.data.reason ? { reason: foldParsed.data.reason } : {}),
            };
          }
          const updatedMarkdown = applySectionFoldEdits({
            existingContent,
            incomingOps,
            edits: foldParsed.data.section_edits ?? [],
            originalFilename,
            updatedStr,
            extraTags: foldParsed.data.new_tags,
            extraAliases: foldParsed.data.new_aliases,
          });
          return {
            action: "UPDATE",
            ...(foldParsed.data.reason ? { reason: foldParsed.data.reason } : {}),
            updated_markdown: updatedMarkdown,
          };
        }

        // Fallback se mock de teste devolveu schema MergeTargetResponseSchema diretamente
        return MergeTargetResponseSchema.parse(parsedJson);
      }

      const prompt = [
        `Arquivo alvo existente: ${relativePath}`,
        `Origem da atualizacao: ${originalFilename}`,
        `updated (YAML): ${updatedStr}`,
        `Data historica de referencia (nao duplicar se ja presente): ${historicalDateStr}`,
        "",
        "CONTEUDO COMPLETO ATUAL DA NOTA NO DISCO:",
        "<<<NOTA_EXISTENTE>>>",
        existingContent,
        "<<<FIM_NOTA_EXISTENTE>>>",
        "",
        "OPERACOES / NOVOS FATOS PARA MESCLAR (READ-BEFORE-WRITE):",
        "<<<NOVOS_FATOS>>>",
        incomingJson,
        "<<<FIM_NOVOS_FATOS>>>",
      ].join("\n");

      const totalSize = existingContent.length + incomingJson.length;
      const tier: ModelTier = totalSize > heavyThreshold ? "heavy" : "primary";
      const rawOutput = await runPromptWithFallback({
        tier,
        contextLabel: `merge:${relativePath}`,
        prompt,
        schema: buildMergeJsonSchema(),
        systemInstructionOverride: MERGE_SYSTEM_INSTRUCTION,
      });
      const parsedJson: unknown = JSON.parse(rawOutput);
      return MergeTargetResponseSchema.parse(parsedJson);
    },

    async refineExistingNote({
      relativePath,
      currentContent,
      updatedStr,
      historicalDateStr,
      vaultContext,
    }): Promise<RefineNoteResult> {
      const topSummaries = selectTopRelevantSummaries({
        rawContent: currentContent,
        originalFilename: relativePath,
        summaries: vaultContext.summaries,
      });

      const compactSummaries = topSummaries.map((s) => ({
        path: s.relativePath,
        title: s.title,
        aliases: s.aliases,
      }));

      const prompt = [
        `Nota editada pelo usuario: ${relativePath}`,
        `updated (YAML): ${updatedStr}`,
        `Data/hora para carimbo inline (📅) apenas nas novidades sem data: ${historicalDateStr}`,
        "",
        "Pastas existentes:",
        ...vaultContext.folders.map((folder) => `- ${folder}`),
        "",
        `Notas existentes para Wikilinks (${compactSummaries.length}):`,
        JSON.stringify(compactSummaries),
        "",
        "Conteudo atual completo da nota:",
        "<<<NOTA_ATUAL>>>",
        currentContent,
        "<<<FIM_NOTA_ATUAL>>>",
      ].join("\n");

      const rawOutput = await runPromptWithFallback({
        tier: "fast",
        contextLabel: relativePath,
        prompt,
        schema: buildRefineJsonSchema(),
        systemInstructionOverride: REFINE_SYSTEM_INSTRUCTION,
      });
      const parsedJson: unknown = JSON.parse(rawOutput);
      return RefineNoteResponseSchema.parse(parsedJson);
    },
  };
}
