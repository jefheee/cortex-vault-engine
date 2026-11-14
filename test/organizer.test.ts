import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildTieredModelChain,
  collectApiKeys,
  collectModelFallbacks,
  type AppConfig,
} from "../src/config.js";
import {
  CHUNK_TRIGGER_CHARS,
  consolidateChunkOperations,
  createGeminiOrganizer,
  splitLargeTextIntoChunks,
  type NoteOrganizerAI,
} from "../src/gemini.js";
import {
  cleanStickyNoteText,
  dotNetTicksToDate,
} from "../src/import_sticky_notes.js";
import { atomicWriteFile } from "../src/lib/atomic-write.js";
import { runActiveHygieneAndLint } from "../src/lib/lint-engine.js";
import { findSimilarExistingNote } from "../src/lib/memory-similarity.js";
import { TransactionManager } from "../src/lib/transaction.js";
import { normalizeNFC, normalizeVaultPath } from "../src/lib/unicode.js";
import { validateNoteBeforeWrite } from "../src/lib/validate-write.js";
import { acquireLock, releaseLock } from "../src/lock.js";
import type { Logger } from "../src/logger.js";
import { scanVaultRoot, type RetryEntry } from "../src/organizer.js";
import {
  applyProfileUpdate,
  collectVaultContext,
  computeContentHash,
  ensureInlineDateStamp,
  extractHistoricalDateFromFilename,
  findMatchingNoteSummary,
  isEffectivelyEmptyNote,
  isUntitledFile,
  normalizeKebabTag,
  recordBotWriteHash,
  resolveTargetFolder,
  sanitizeFilename,
  selectTopRelevantSummaries,
  shouldIgnoreRootFile,
  tryReadGdocExport,
} from "../src/vault.js";

const tempDirs: string[] = [];

async function createTempVault(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-v4-test-"));
  tempDirs.push(dir);

  const dirs = [
    "01_Pessoas",
    "02_Projetos_e_Negocios/Sistemas_e_SaaS",
    "02_Projetos_e_Negocios/Credenciais_e_Infra",
    "03_Faculdade_e_Estudos/ADS_UNISUL",
    "04_Padroes_e_Prompts",
    "05_Pessoal_e_Vida/Hardware_e_Setup",
    ".automacao/inbox_chats",
    ".automacao/processed_archive",
  ];
  for (const d of dirs) {
    await fs.mkdir(path.join(dir, d), { recursive: true });
  }

  await fs.writeFile(
    path.join(dir, "02_Projetos_e_Negocios/Sistemas_e_SaaS/Ideias Projeto DraftClub.md"),
    [
      "---",
      'title: "Ideias Projeto DraftClub - Sistema de OVR"',
      "aliases:",
      '  - "DraftClub OVR"',
      "tags:",
      "  - draftclub",
      "created: 2026-10-13 02:12",
      "updated: 2026-11-14 01:33",
      "category: projetos_negocios",
      "status: rascunho",
      "---",
      "",
      "## Sistema de OVR",
      "- Teto minimo 79 e maximo 89.",
      "",
      "---",
      "## Conexões Relacionadas",
      "- [[Chaves de API e Credenciais Mestras]]",
      "",
    ].join("\n"),
    "utf8",
  );

  await fs.writeFile(
    path.join(dir, "02_Projetos_e_Negocios/Credenciais_e_Infra/Chaves de API e Credenciais Mestras.md"),
    "# Credenciais Mestras\n",
    "utf8",
  );

  await fs.writeFile(
    path.join(dir, "05_Pessoal_e_Vida/00_Perfil_Mestre_Jefherson.md"),
    [
      "---",
      'title: "00 - Perfil Mestre: Jefherson Luiz da Silva"',
      "aliases:",
      '  - "Perfil Mestre"',
      "tags:",
      "  - perfil-mestre",
      "created: 2026-11-14 01:55",
      "updated: 2026-11-14 01:55",
      "category: pessoal_vida",
      "status: ativo",
      "---",
      "",
      "## Estado Atual (Verdade Ativa)",
      "",
      "### Rotina, Lazer e Patrimônio",
      "- **Música:** Rap, Hip Hop e Trap americano.",
      "",
      "## Histórico de Evolução (Changelog Pessoal)",
      "- `[2026-11-14]` Consolidação inicial.",
      "",
    ].join("\n"),
    "utf8",
  );

  return dir;
}

function createMemoryLogger(entries: string[]): Logger {
  return {
    info: async (msg: string) => {
      entries.push(`INFO: ${msg}`);
    },
    warn: async (msg: string) => {
      entries.push(`WARN: ${msg}`);
    },
    error: async (msg: string) => {
      entries.push(`ERROR: ${msg}`);
    },
  };
}

function buildTestConfig(vaultRoot: string): AppConfig {
  return {
    automacaoDir: path.join(vaultRoot, ".automacao"),
    vaultRoot,
    logFile: path.join(vaultRoot, ".automacao", "organizer.log"),
    trashDir: path.join(vaultRoot, ".automacao", "trash"),
    processedArchiveDir: path.join(vaultRoot, ".automacao", "processed_archive"),
    checkpointsDir: path.join(vaultRoot, ".automacao", "checkpoints"),
    tempDir: path.join(vaultRoot, ".automacao", ".tmp"),
    ledgerFile: path.join(vaultRoot, ".automacao", "ledger.jsonl"),
    indexCacheFile: path.join(vaultRoot, ".automacao", "vault-index.json"),
    lockFile: path.join(vaultRoot, ".automacao", "watcher.lock"),
    inboxChatsDir: path.join(vaultRoot, ".automacao", "inbox_chats"),
    profileNoteRelPath: "05_Pessoal_e_Vida/00_Perfil_Mestre_Jefherson.md",
    apiKeys: ["key-1", "key-2"],
    model: "gemini-2.5-flash",
    modelPrimary: "gemini-2.5-flash",
    modelHeavy: "gemini-2.5-pro",
    modelFast: "gemini-2.5-flash-lite",
    heavyInputThresholdChars: 12_000,
    modelFallbacks: [
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-3.6-flash",
      "gemini-3.5-flash-lite",
      "gemini-2.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-2.0-flash",
    ],
    debounceMs: 60_000,
    inboxBrutoDebounceMs: 5_000,
    subFolderDebounceMs: 90_000,
    emptyNoteDebounceMs: 60_000,
    emptyCleanupMs: 15 * 60_000,
    pollIntervalMs: 5_000,
    activeScanIntervalMs: 30_000,
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("config & vault helpers V4", () => {
  it("coleta e deduplica chaves sem placeholders", () => {
    const keys = collectApiKeys({
      GEMINI_API_KEYS: "k1, k2, cole_sua_chave_aqui",
      GEMINI_API_KEY_1: "k1",
      GEMINI_API_KEY_2: "k3",
      GEMINI_API_KEY: "k4",
    });
    assert.deepEqual(keys, ["k1", "k2", "k3", "k4"]);
  });

  it("monta cadeia de fallback de modelos deduplicada (Gemini 2.5 & Gemini 3 Oficial)", () => {
    const models = collectModelFallbacks(
      "gemini-2.5-flash",
      "gemini-2.5-flash, gemini-2.5-pro, gemini-2.5-flash-lite, gemini-3.6-flash",
    );
    assert.deepEqual(models, [
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-2.5-flash-lite",
      "gemini-3.6-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-2.0-flash",
    ]);

    assert.equal(buildTieredModelChain({ tier: "heavy" })[0], "gemini-2.5-pro");
    assert.equal(buildTieredModelChain({ tier: "primary" })[0], "gemini-2.5-flash");
    assert.equal(buildTieredModelChain({ tier: "fast" })[0], "gemini-2.5-flash-lite");
  });

  it("extrai datas historicas do padrao Samsung Notes _YYMMDD_HHMMSS.txt", () => {
    const fallback = new Date(2026, 10, 14, 3, 14, 0);
    assert.equal(
      extractHistoricalDateFromFilename("Notes_250222_235555.txt", fallback),
      "22/02/2025 23:55",
    );
    assert.equal(
      extractHistoricalDateFromFilename("gym_251016_015851.txt", fallback),
      "16/10/2025 01:58",
    );
    assert.equal(
      extractHistoricalDateFromFilename("Casa Hurbana_260423_203544.txt", fallback),
      "23/04/2026 20:35",
    );
    assert.equal(
      extractHistoricalDateFromFilename("Nota_Sem_Data.md", fallback),
      "14/11/2026 03:14",
    );
  });

  it("detecta notas vazias (0KB, espacos ou YAML sem corpo)", () => {
    assert.equal(isEffectivelyEmptyNote(""), true);
    assert.equal(isEffectivelyEmptyNote("   \n\t\r\n "), true);
    assert.equal(
      isEffectivelyEmptyNote("---\ntitle: \"Nota Vazia\"\ntags:\n  - teste\n---\n\n  "),
      true,
    );
    assert.equal(
      isEffectivelyEmptyNote("---\ntitle: \"Com Texto\"\n---\nConteudo real."),
      false,
    );
    assert.equal(
      isEffectivelyEmptyNote("---\nTexto entre linhas horizontais\n---"),
      false,
    );
  });

  it("aceita .md e .txt na raiz e ignora arquivos de sistema/temporarios", () => {
    assert.equal(shouldIgnoreRootFile("GEMINI.md"), true);
    assert.equal(shouldIgnoreRootFile("AGENTS.md"), true);
    assert.equal(shouldIgnoreRootFile("~$nota.md"), true);
    assert.equal(shouldIgnoreRootFile("Sem título.md"), false);
    assert.equal(shouldIgnoreRootFile("SamsungNote_Export.txt"), false);
  });

  it("identifica Sem titulo*.md|txt e sanitiza nomes invalidos", () => {
    assert.equal(isUntitledFile("Sem título 2.md"), true);
    assert.equal(isUntitledFile("Sem titulo 1.txt"), true);
    assert.equal(
      sanitizeFilename('Ideia: Arquitetura / Microserviços?*"<>| '),
      "Ideia Arquitetura Microserviços.md",
    );
    assert.equal(normalizeKebabTag("#NextJS App"), "nextjs-app");
  });

  it("permite subpastas semanticas dentro dos 5 pilares com fallback seguro", () => {
    const allowed = ["02_Projetos_e_Negocios/Sistemas_e_SaaS", "05_Pessoal_e_Vida"];
    assert.equal(
      resolveTargetFolder("02_Projetos_e_Negocios/Novo_Projeto", "projetos_negocios", allowed),
      "02_Projetos_e_Negocios/Novo_Projeto",
    );
    assert.equal(
      resolveTargetFolder("Pasta_Invalida/Teste", "faculdade_estudos", allowed),
      "03_Faculdade_e_Estudos",
    );
  });

  it("limpa marcadores RTF de Sticky Notes e converte .NET ticks", () => {
    const cleaned = cleanStickyNoteText(
      "\\id=abc-123 \\b Titulo:\\b0 \n\\id=def-456\\strike Antigo\\strike0 Novo",
    );
    assert.match(cleaned, /\*\*Titulo:\*\*/);
    assert.match(cleaned, /~~Antigo~~ Novo/);
    assert.equal(cleaned.includes("\\id="), false);

    const parsedDate = dotNetTicksToDate("639153333480676857");
    assert.ok(parsedDate instanceof Date);
    assert.equal(parsedDate.getUTCFullYear(), 2026);
  });
});

describe("Cache Incremental & Top-K Relevance", () => {
  it("reutiliza cache em vault-index.json para notas inalteradas", async () => {
    const vaultRoot = await createTempVault();
    const cacheFile = path.join(vaultRoot, ".automacao", "vault-index.json");

    const first = await collectVaultContext(vaultRoot, cacheFile);
    assert.equal(first.cacheStats.cacheHits, 0);
    assert.equal(first.cacheStats.cacheMisses, 3);

    const second = await collectVaultContext(vaultRoot, cacheFile);
    assert.equal(second.cacheStats.cacheHits, 3);
    assert.equal(second.cacheStats.cacheMisses, 0);
  });

  it("filtra Top-K priorizando notas relevantes e recentes", () => {
    const summaries = Array.from({ length: 40 }, (_, i) => ({
      relativePath: `05_Pessoal_e_Vida/Nota_${i}.md`,
      name: `Nota_${i}`,
      title: i === 33 ? "Otimizacao Rust Tauri Windows" : `Assunto Generico ${i}`,
      aliases: i === 33 ? ["System Optimizer"] : [],
      tags: i === 33 ? ["rust", "tauri", "windows"] : ["geral"],
      headings: i === 33 ? ["Deteccao de Hardware"] : ["Resumo"],
      mtimeMs: 1_000_000 + i * 100,
      size: 200,
    }));

    const top = selectTopRelevantSummaries({
      rawContent: "Melhoria de performance no app Rust Tauri de otimizacao Windows",
      originalFilename: "ideia optimizer.md",
      summaries,
      limit: 20,
      recentCount: 5,
      threshold: 25,
    });

    assert.equal(top.length, 20);
    assert.ok(top.some((n) => n.name === "Nota_33"));
    assert.ok(top.some((n) => n.name === "Nota_39"));
  });
});

describe("KeyPool failover & Tiered Model Routing (V6.0)", () => {
  it("rotaciona para Key #2 no erro 429 e faz fallback de modelo no erro 404/403", async () => {
    const vaultRoot = await createTempVault();
    const ctx = await collectVaultContext(vaultRoot);
    const logs: string[] = [];
    const logger = createMemoryLogger(logs);

    const attempts: Array<{ key: string; model: string }> = [];
    const ai = createGeminiOrganizer({
      apiKeys: ["key-1", "key-2"],
      modelPrimary: "gemini-2.5-flash",
      modelHeavy: "gemini-2.5-pro",
      modelFast: "gemini-2.5-flash-lite",
      modelFallbacks: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.6-flash"],
      logger,
      customRunner: async (apiKey, model) => {
        attempts.push({ key: apiKey, model });
        if (apiKey === "key-1") {
          throw new Error("429 RESOURCE_EXHAUSTED: Quota exceeded");
        }
        if (model === "gemini-2.5-flash") {
          throw new Error("404 models/gemini-2.5-flash is not found");
        }
        return JSON.stringify({
          operations: [
            {
              action: "CREATE_NEW",
              target_path: "05_Pessoal_e_Vida",
              suggested_filename: "Nota Teste.md",
              frontmatter: {
                title: "Nota Teste",
                aliases: ["Teste"],
                tags: ["teste", "nota"],
                created: "2026-11-14 03:00",
                updated: "2026-11-14 03:00",
                category: "pessoal_vida",
                status: "ativo",
              },
              content_markdown: "## Conteudo\n- Item validado.\n",
            },
          ],
        });
      },
    });

    const result = await ai.organizeNote({
      originalFilename: "Sem título.md",
      rawContent: "Item de teste",
      createdStr: "2026-11-14 03:00",
      updatedStr: "2026-11-14 03:00",
      vaultContext: ctx,
    });

    assert.equal(result.operations.length, 1);
    assert.equal(result.operations[0]?.action, "CREATE_NEW");
    assert.deepEqual(attempts, [
      { key: "key-1", model: "gemini-2.5-flash" },
      { key: "key-1", model: "gemini-2.5-flash-lite" },
      { key: "key-1", model: "gemini-3.6-flash" },
      { key: "key-2", model: "gemini-2.5-flash" },
      { key: "key-2", model: "gemini-2.5-flash-lite" },
    ]);
    assert.ok(logs.some((l) => l.includes("Key #2 activated")));
    assert.ok(logs.some((l) => l.includes("MODEL_FALLBACK")));
    assert.ok(logs.some((l) => l.includes("[OK] Processed") && l.includes("model=gemini-2.5-flash-lite (Key #2)")));
  });

  it("roteia entradas >12k chars para gemini-2.5-pro, raiz padrao para gemini-2.5-flash, subpastas para gemini-2.5-flash-lite e faz fallback para gemini-3.6-flash / gemini-3.5-flash-lite", async () => {
    const vaultRoot = await createTempVault();
    const ctx = await collectVaultContext(vaultRoot);
    const logs: string[] = [];
    const logger = createMemoryLogger(logs);

    const calledModels: string[] = [];
    const ai = createGeminiOrganizer({
      apiKeys: ["key-1"],
      modelPrimary: "gemini-2.5-flash",
      modelHeavy: "gemini-2.5-pro",
      modelFast: "gemini-2.5-flash-lite",
      heavyInputThresholdChars: 12_000,
      modelFallbacks: [
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-2.5-pro",
        "gemini-3.6-flash",
        "gemini-3.5-flash-lite",
      ],
      logger,
      customRunner: async (_apiKey, model, prompt) => {
        calledModels.push(model);
        if (prompt.includes("TRIGGER_FALLBACK_35_LITE") && model !== "gemini-3.5-flash-lite") {
          if (model === "gemini-2.5-flash" || model === "gemini-2.5-flash-lite" || model === "gemini-2.5-pro") {
            throw new Error(`403 permission_denied for ${model}`);
          }
          if (model === "gemini-3.6-flash") {
            throw new Error("429 quota exceeded on gemini-3.6-flash");
          }
        }
        if (prompt.includes("Nota editada pelo usuario")) {
          return JSON.stringify({
            updated_markdown: "---\ntitle: Teste\n---\n- Atualizado *(📅 14/11/2026 04:50)*\n",
          });
        }
        return JSON.stringify({
          operations: [
            {
              action: "SKIP_DUPLICATE",
              target_path: "05_Pessoal_e_Vida/00_Perfil_Mestre_Jefherson.md",
              duplicate_reason: "Teste de roteamento",
            },
          ],
        });
      },
    });

    await ai.organizeNote({
      originalFilename: "Pesado.md",
      rawContent: "x".repeat(12_050),
      createdStr: "2026-11-14 04:50",
      updatedStr: "2026-11-14 04:50",
      vaultContext: ctx,
    });
    assert.equal(calledModels.at(-1), "gemini-2.5-pro");

    await ai.organizeNote({
      originalFilename: "Padrao.md",
      rawContent: "Nota normal na raiz",
      createdStr: "2026-11-14 04:50",
      updatedStr: "2026-11-14 04:50",
      vaultContext: ctx,
    });
    assert.equal(calledModels.at(-1), "gemini-2.5-flash");

    await ai.refineExistingNote!({
      relativePath: "05_Pessoal_e_Vida/00_Perfil_Mestre_Jefherson.md",
      currentContent: "conteudo",
      updatedStr: "2026-11-14 04:50",
      historicalDateStr: "14/11/2026 04:50",
      vaultContext: ctx,
    });
    assert.equal(calledModels.at(-1), "gemini-2.5-flash-lite");

    await ai.organizeNote({
      originalFilename: "Fallback.md",
      rawContent: "TRIGGER_FALLBACK_35_LITE",
      createdStr: "2026-11-14 04:50",
      updatedStr: "2026-11-14 04:50",
      vaultContext: ctx,
    });
    assert.equal(calledModels.at(-1), "gemini-3.5-flash-lite");
  });
});

describe("Multi-Topic Splitter, .txt Ingestion & Processed Archive (V4)", () => {
  it("fatie um arquivo .txt multi-assunto em operations[], atualiza secao + perfil mestre e arquiva original", async () => {
    const vaultRoot = await createTempVault();
    const config = buildTestConfig(vaultRoot);
    const logs: string[] = [];
    const logger = createMemoryLogger(logs);

    const txtPath = path.join(vaultRoot, "SamsungNotes_Multi.txt");
    await fs.writeFile(
      txtPath,
      "DraftClub OVR novo limite 91 + comecei a ouvir Lo-Fi alem de Rap.",
      "utf8",
    );
    const nowMs = Date.now();
    await fs.utimes(txtPath, nowMs / 1000, (nowMs - 90_000) / 1000);

    const mockAi: NoteOrganizerAI = {
      async organizeNote() {
        return {
          operations: [
            {
              action: "APPEND_TO_EXISTING",
              target_path: "02_Projetos_e_Negocios/Sistemas_e_SaaS/Ideias Projeto DraftClub.md",
              section_heading: "Sistema de OVR",
              content_markdown: "- Teto maximo ajustado para 91.",
              new_tags: ["ovr-91"],
            },
            {
              action: "UPDATE_SECTION_IN_EXISTING",
              target_path: "05_Pessoal_e_Vida/00_Perfil_Mestre_Jefherson.md",
              section_heading: "Rotina, Lazer e Patrimônio",
              content_markdown: "- **Música:** Rap, Hip Hop, Trap americano e Lo-Fi para programar.",
              changelog_entry: "Adicionado Lo-Fi as preferencias musicais.",
            },
          ],
        };
      },
    };

    const results = await scanVaultRoot({
      config,
      ai: mockAi,
      logger,
      processingFiles: new Set(),
      lastObservedActivity: new Map(),
      retryState: new Map(),
      nowMs,
    });

    assert.equal(results[0]?.action, "multi_processed");
    assert.equal(results[0]?.operationsCount, 2);
    assert.equal(results[0]?.profileUpdated, true);
    await assert.rejects(() => fs.access(txtPath));

    const archiveFiles = await fs.readdir(config.processedArchiveDir);
    assert.equal(archiveFiles.length, 1);

    const draftClubContent = await fs.readFile(
      path.join(vaultRoot, "02_Projetos_e_Negocios/Sistemas_e_SaaS/Ideias Projeto DraftClub.md"),
      "utf8",
    );
    assert.match(draftClubContent, /Teto maximo ajustado para 91\./);
    assert.ok(
      draftClubContent.indexOf("Teto maximo ajustado para 91.") <
      draftClubContent.indexOf("## Conexões Relacionadas"),
    );

    const profileContent = await fs.readFile(
      path.join(vaultRoot, config.profileNoteRelPath),
      "utf8",
    );
    assert.match(profileContent, /Lo-Fi para programar\./);
    assert.match(profileContent, /Adicionado Lo-Fi as preferencias musicais\./);
  });

  it("faz retry automatico com exponential backoff apos falha offline temporaria", async () => {
    const vaultRoot = await createTempVault();
    const config = buildTestConfig(vaultRoot);
    const logs: string[] = [];
    const logger = createMemoryLogger(logs);
    const retryState = new Map<string, RetryEntry>();

    const notePath = path.join(vaultRoot, "Nota Offline.md");
    await fs.writeFile(notePath, "Anotacao feita no celular sem internet.", "utf8");
    const t0 = Date.now();
    await fs.utimes(notePath, t0 / 1000, (t0 - 120_000) / 1000);

    let failNetwork = true;
    const mockAi: NoteOrganizerAI = {
      async organizeNote() {
        if (failNetwork) {
          throw new Error("fetch failed: ENOTFOUND generativelanguage.googleapis.com");
        }
        return {
          operations: [
            {
              action: "CREATE_NEW",
              target_path: "05_Pessoal_e_Vida",
              suggested_filename: "Nota Offline Organizada.md",
              frontmatter: {
                title: "Nota Offline Organizada",
                aliases: ["Nota Offline"],
                tags: ["offline", "drivesync"],
                created: "2026-11-14 01:55",
                updated: "2026-11-14 01:55",
                category: "pessoal_vida",
                status: "ativo",
              },
              content_markdown: "## Nota\n- Anotacao feita no celular sem internet.\n",
            },
          ],
        };
      },
    };

    const r1 = await scanVaultRoot({
      config,
      ai: mockAi,
      logger,
      processingFiles: new Set(),
      lastObservedActivity: new Map(),
      retryState,
      nowMs: t0,
    });
    assert.equal(r1[0]?.action, "retry_queued");

    const r2 = await scanVaultRoot({
      config,
      ai: mockAi,
      logger,
      processingFiles: new Set(),
      lastObservedActivity: new Map(),
      retryState,
      nowMs: t0 + 30_000,
    });
    assert.equal(r2.length, 0);

    failNetwork = false;
    const r3 = await scanVaultRoot({
      config,
      ai: mockAi,
      logger,
      processingFiles: new Set(),
      lastObservedActivity: new Map(),
      retryState,
      nowMs: t0 + 65_000,
    });
    assert.equal(r3[0]?.action, "organized");
    assert.equal(retryState.has("Nota Offline.md"), false);
  });

  it("aplica applyProfileUpdate preservando Verdade Ativa e Changelog", async () => {
    const vaultRoot = await createTempVault();
    const profilePath = path.join(vaultRoot, "05_Pessoal_e_Vida/00_Perfil_Mestre_Jefherson.md");
    const content = await fs.readFile(profilePath, "utf8");
    const directUpdated = applyProfileUpdate({
      profileContent: content,
      sectionToUpdate: "Rotina, Lazer e Patrimônio",
      updatedFactMarkdown: "- **Suplementacao:** Creatina 5g/dia.",
      changelogEntry: "Iniciado uso diario de creatina.",
      updatedAt: new Date("2026-11-14T03:00:00Z"),
    });
    assert.match(directUpdated, /- \*\*Suplementacao:\*\* Creatina 5g\/dia\./);
    assert.match(directUpdated, /Iniciado uso diario de creatina\./);
  });

  it("garante instancia unica via PID lockfile e recupera lock stale", async () => {
    const vaultRoot = await createTempVault();
    const lockPath = path.join(vaultRoot, ".automacao", "watcher.lock");

    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 99999, startedAt: new Date().toISOString() }),
      "utf8",
    );
    const blocked = await acquireLock(lockPath, (pid) => pid === 99999);
    assert.equal(blocked.acquired, false);
    if (!blocked.acquired) {
      assert.equal(blocked.existingPid, 99999);
    }

    const recovered = await acquireLock(lockPath, () => false);
    assert.equal(recovered.acquired, true);

    await releaseLock(lockPath);
    await assert.rejects(() => fs.access(lockPath));
  });
});

describe("V5 Subfolder Watch, SHA-256 Anti-Loop & Empty Note Trash + Wikilinks", () => {
  it("move nota com YAML-only para trash apos 60s e remove [[Wikilinks]] quebrados", async () => {
    const vaultRoot = await createTempVault();
    const config = buildTestConfig(vaultRoot);
    const logs: string[] = [];
    const logger = createMemoryLogger(logs);

    const emptyRel = "01_Pessoas/Nota Fantasma.md";
    const emptyAbs = path.join(vaultRoot, emptyRel);
    await fs.writeFile(
      emptyAbs,
      "---\ntitle: \"Nota Fantasma\"\n---\n\n",
      "utf8",
    );
    const t0 = Date.now();
    await fs.utimes(emptyAbs, t0 / 1000, (t0 - 65_000) / 1000);

    const draftClubPath = path.join(
      vaultRoot,
      "02_Projetos_e_Negocios/Sistemas_e_SaaS/Ideias Projeto DraftClub.md",
    );
    const beforeDraft = await fs.readFile(draftClubPath, "utf8");
    const withBrokenLinks = `${beforeDraft}\n- [[Nota Fantasma]]\nContato via [[Nota Fantasma|Fantasma]] hoje.\n`;
    await fs.writeFile(draftClubPath, withBrokenLinks, "utf8");
    await recordBotWriteHash({
      indexCachePath: config.indexCacheFile,
      relPath: "02_Projetos_e_Negocios/Sistemas_e_SaaS/Ideias Projeto DraftClub.md",
      content: withBrokenLinks,
    });

    const results = await scanVaultRoot({
      config,
      ai: null,
      logger,
      processingFiles: new Set(),
      lastObservedActivity: new Map(),
      retryState: new Map(),
      nowMs: t0,
    });

    assert.ok(results.some((r) => r.action === "deleted_empty" && r.sourceFile === emptyRel));
    await assert.rejects(() => fs.access(emptyAbs));

    const trashFiles = await fs.readdir(config.trashDir);
    assert.equal(trashFiles.length, 1);

    const cleanedDraft = await fs.readFile(draftClubPath, "utf8");
    assert.equal(cleanedDraft.includes("[[Nota Fantasma"), false);
    assert.match(cleanedDraft, /Contato via Fantasma hoje\./);
  });

  it("respeita guarda SHA-256 anti-loop e carimba data 📅 quando usuario edita subpasta", async () => {
    const vaultRoot = await createTempVault();
    const config = buildTestConfig(vaultRoot);
    const logs: string[] = [];
    const logger = createMemoryLogger(logs);

    const targetRel = "02_Projetos_e_Negocios/Sistemas_e_SaaS/Ideias Projeto DraftClub.md";
    const targetAbs = path.join(vaultRoot, targetRel);
    const initialContent = await fs.readFile(targetAbs, "utf8");
    const t0 = Date.now();
    await fs.utimes(targetAbs, t0 / 1000, (t0 - 120_000) / 1000);
    const stInit = await fs.stat(targetAbs);

    await recordBotWriteHash({
      indexCachePath: config.indexCacheFile,
      relPath: targetRel,
      content: initialContent,
      mtimeMs: stInit.mtimeMs,
      size: stInit.size,
    });

    const resUnchanged = await scanVaultRoot({
      config,
      ai: null,
      logger,
      processingFiles: new Set(),
      lastObservedActivity: new Map(),
      retryState: new Map(),
      nowMs: t0,
    });
    assert.equal(resUnchanged.some((r) => r.sourceFile === targetRel), false);

    const editedContent = initialContent.replace(
      "- Teto minimo 79 e maximo 89.",
      "- Teto minimo 79 e maximo 89.\n- Novo modo carreira cooperativo.",
    );
    await fs.writeFile(targetAbs, editedContent, "utf8");
    await fs.utimes(targetAbs, t0 / 1000, (t0 - 100_000) / 1000);

    const resEdited = await scanVaultRoot({
      config,
      ai: null,
      logger,
      processingFiles: new Set(),
      lastObservedActivity: new Map(),
      retryState: new Map(),
      nowMs: t0,
    });
    assert.ok(resEdited.some((r) => r.action === "reorganized_edit" && r.sourceFile === targetRel));

    const updatedDisk = await fs.readFile(targetAbs, "utf8");
    assert.match(updatedDisk, /📅/);

    const cachedRaw = JSON.parse(await fs.readFile(config.indexCacheFile, "utf8")) as {
      entries: Record<string, { lastBotWriteHash?: string }>;
    };
    assert.equal(cachedRaw.entries[targetRel]?.lastBotWriteHash, computeContentHash(updatedDisk));
  });

  it("executa Read-Before-Write consolidando multiplas ops, respeitando NO_OP e fallback anti-truncamento", async () => {
    const vaultRoot = await createTempVault();
    const config = buildTestConfig(vaultRoot);
    const logs: string[] = [];
    const logger = createMemoryLogger(logs);

    const targetRel = "02_Projetos_e_Negocios/Sistemas_e_SaaS/Ideias Projeto DraftClub.md";
    const targetAbs = path.join(vaultRoot, targetRel);
    const originalDisk = await fs.readFile(targetAbs, "utf8");

    const inboxA = path.join(vaultRoot, "nota_merge_ok.txt");
    await fs.writeFile(inboxA, "Atualizar DraftClub: teto sobe para 90 e liga semanal.", "utf8");
    const t0 = Date.now();
    await fs.utimes(inboxA, t0 / 1000, (t0 - 120_000) / 1000);

    let seenExistingOnMerge = "";
    let seenOpsCount = 0;
    let mergeMode: "UPDATE" | "NO_OP" | "TRUNCATE" = "UPDATE";

    const fakeAi: NoteOrganizerAI = {
      async organizeNote() {
        return {
          operations: [
            {
              action: "UPDATE_SECTION_IN_EXISTING",
              target_path: targetRel,
              section_heading: "Sistema de OVR",
              content_markdown: "- Teto revisado para 90.",
            },
            {
              action: "APPEND_TO_EXISTING",
              target_path: targetRel,
              section_heading: "Liga Semanal",
              content_markdown: "- Torneio aos sabados.",
            },
          ],
        };
      },
      async mergeWithExistingNote({ existingContent, incomingOps }) {
        seenExistingOnMerge = existingContent;
        seenOpsCount = incomingOps.length;
        if (mergeMode === "NO_OP") {
          return { action: "NO_OP", reason: "Informacao ja documentada na nota." };
        }
        if (mergeMode === "TRUNCATE") {
          return { action: "UPDATE", updated_markdown: "# Curto demais" };
        }
        return {
          action: "UPDATE",
          updated_markdown: existingContent.replace(
            "- Teto minimo 79 e maximo 89.",
            "- Teto minimo 79 e maximo 90.\n\n## Liga Semanal\n- Torneio aos sabados.",
          ),
        };
      },
    };

    const resUpdate = await scanVaultRoot({
      config,
      ai: fakeAi,
      logger,
      processingFiles: new Set(),
      lastObservedActivity: new Map(),
      retryState: new Map(),
      nowMs: t0,
    });
    assert.ok(resUpdate.some((r) => r.action === "multi_processed"));
    assert.ok(seenExistingOnMerge.includes("Teto minimo 79 e maximo 89."));
    assert.equal(seenOpsCount, 2);

    const diskAfterUpdate = await fs.readFile(targetAbs, "utf8");
    assert.ok(diskAfterUpdate.includes("maximo 90."));
    assert.ok(diskAfterUpdate.includes("Torneio aos sabados."));

    // Caso 2: NO_OP nao deve reescrever o arquivo
    mergeMode = "NO_OP";
    const inboxB = path.join(vaultRoot, "nota_noop.txt");
    await fs.writeFile(inboxB, "Repeticao DraftClub.", "utf8");
    await fs.utimes(inboxB, t0 / 1000, (t0 - 120_000) / 1000);
    await scanVaultRoot({
      config,
      ai: fakeAi,
      logger,
      processingFiles: new Set(),
      lastObservedActivity: new Map(),
      retryState: new Map(),
      nowMs: t0,
    });
    const diskAfterNoOp = await fs.readFile(targetAbs, "utf8");
    assert.equal(diskAfterNoOp, diskAfterUpdate);

    // Caso 3: Guarda anti-truncamento preserva original e usa fallback append
    mergeMode = "TRUNCATE";
    const inboxC = path.join(vaultRoot, "nota_truncate.txt");
    await fs.writeFile(inboxC, "Nova regra segura DraftClub.", "utf8");
    await fs.utimes(inboxC, t0 / 1000, (t0 - 120_000) / 1000);
    await scanVaultRoot({
      config,
      ai: fakeAi,
      logger,
      processingFiles: new Set(),
      lastObservedActivity: new Map(),
      retryState: new Map(),
      nowMs: t0,
    });
    const diskAfterTruncateGuard = await fs.readFile(targetAbs, "utf8");
    assert.equal(diskAfterTruncateGuard.includes("# Curto demais"), false);
    assert.ok(diskAfterTruncateGuard.includes('title: "Ideias Projeto DraftClub - Sistema de OVR"'));
    assert.ok(diskAfterTruncateGuard.includes("Teto revisado para 90."));
    assert.ok(diskAfterTruncateGuard.includes("Torneio aos sabados."));
    assert.ok(originalDisk.length > 0);
  });

  it("roteia CHAT_DUMP para gemini-2.5-pro e evita carimbos 📅 ou erros em .gdoc virtual", async () => {
    const vaultRoot = await createTempVault();
    const ctx = await collectVaultContext(vaultRoot);
    const logs: string[] = [];
    const logger = createMemoryLogger(logs);
    const usedModels: string[] = [];

    const organizer = createGeminiOrganizer({
      apiKeys: ["KEY_PRIMARY_OK"],
      modelPrimary: "gemini-2.5-flash",
      modelHeavy: "gemini-2.5-pro",
      modelFast: "gemini-2.5-flash-lite",
      modelFallbacks: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"],
      heavyInputThresholdChars: 12_000,
      logger,
      customRunner: async (_apiKey, model) => {
        usedModels.push(model);
        return JSON.stringify({
          operations: [
            {
              action: "SKIP_DUPLICATE",
              target_path: "05_Pessoal_e_Vida/00_Perfil_Mestre_Jefherson.md",
              duplicate_reason: "DNA já registrado.",
            },
          ],
        });
      },
    });

    await organizer.organizeNote({
      rawContent: "You said: Nao quero codigo prolixo.\nGemini said: Entendido.",
      originalFilename: "chat_curto.md",
      createdStr: "2026-11-14 15:00",
      updatedStr: "2026-11-14 15:00",
      historicalDateStr: "14/11/2026 15:00",
      isChatDump: true,
      vaultContext: ctx,
    });
    assert.equal(usedModels[0], "gemini-2.5-pro");

    // ensureInlineDateStamp nao duplica data ja presente no texto nem em H1
    assert.equal(
      ensureInlineDateStamp("# Titulo\n- Evento em 12/11/2026 confirmado.", "12/11/2026 18:37"),
      "# Titulo\n- Evento em 12/11/2026 confirmado.",
    );
    assert.equal(
      ensureInlineDateStamp("- Nova informacao adicionada.", "14/11/2026 16:00"),
      "- Nova informacao adicionada. *(📅 14/11/2026 16:00)*",
    );

    // findMatchingNoteSummary resolve caminho exato e stem unico
    assert.equal(findMatchingNoteSummary("Ideias Projeto DraftClub.md", ctx.summaries)?.relativePath, "02_Projetos_e_Negocios/Sistemas_e_SaaS/Ideias Projeto DraftClub.md");

    // tryReadGdocExport trata diretorio/atalho virtual (EISDIR) como drive_virtual_shortcut
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gdoc-dir-test-"));
    tempDirs.push(tempDir);
    const fakeVirtualGdocDir = path.join(tempDir, "Chat Gemini.gdoc");
    await fs.mkdir(fakeVirtualGdocDir);
    const gdocRes = await tryReadGdocExport(fakeVirtualGdocDir);
    assert.deepEqual(gdocRes, { ok: false, reason: "drive_virtual_shortcut" });
  });

  it("V5.3 Chunked Map-Reduce, cache limit:0 em zeroQuotaModels e alias markdown_body", async () => {
    // 1. splitLargeTextIntoChunks respeita limite e fatiamento em blocos
    const paragraph = "## Bloco Técnico\n" + "Detalhe SQL PostgreSQL e Open Finance.\n".repeat(25);
    const hugeRaw = Array.from({ length: 42 }, (_, idx) => `${paragraph}\n<!-- part-${idx} -->\n`).join("\n");
    assert.ok(hugeRaw.length > CHUNK_TRIGGER_CHARS);

    const chunks = splitLargeTextIntoChunks(hugeRaw, 20_000);
    assert.ok(chunks.length >= 2);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 20_000);
      assert.ok(chunk.trim().length > 0);
    }

    // 2. consolidateChunkOperations mescla CREATE_NEW no mesmo alvo e descarta SKIP_DUPLICATE redundante
    const consolidated = consolidateChunkOperations([
      {
        action: "CREATE_NEW",
        target_path: "02_Projetos_e_Negocios/Sistemas_e_SaaS/Kitsune Test.md",
        content_markdown: "## Parte A\nTexto inicial.",
      },
      {
        action: "SKIP_DUPLICATE",
        target_path: "05_Pessoal_e_Vida/00_Perfil_Mestre_Jefherson.md",
        content_markdown: "Duplicado.",
        duplicate_reason: "Repetido.",
      },
      {
        action: "CREATE_NEW",
        target_path: "02_Projetos_e_Negocios/Sistemas_e_SaaS/Kitsune Test.md",
        content_markdown: "## Parte B\nTexto complementar.",
      },
    ]);
    assert.equal(consolidated.length, 1);
    const firstConsolidated = consolidated[0];
    assert.ok(firstConsolidated);
    assert.equal(firstConsolidated.action, "CREATE_NEW");
    assert.ok(firstConsolidated.content_markdown);
    assert.ok(firstConsolidated.content_markdown.includes("## Parte A"));
    assert.ok(firstConsolidated.content_markdown.includes("## Parte B"));

    // 3. organizeNote (> 32k chars): limit:0 em gemini-2.5-pro coloca modelo em unavailableKeyModels e normaliza markdown_body
    const vaultRoot = await createTempVault();
    const ctx = await collectVaultContext(vaultRoot);
    const logs: string[] = [];
    const logger = createMemoryLogger(logs);
    const callModels: string[] = [];
    let chunkIndex = 0;

    const organizer = createGeminiOrganizer({
      apiKeys: ["KEY_FREE_ZERO_ARGON"],
      modelPrimary: "gemini-2.5-flash",
      modelHeavy: "gemini-2.5-pro",
      modelFast: "gemini-2.5-flash-lite",
      modelFallbacks: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"],
      heavyInputThresholdChars: 12_000,
      logger,
      customRunner: async (_apiKey, model) => {
        callModels.push(model);
        if (model === "gemini-2.5-pro") {
          throw new Error(
            "429 Rate limit exceeded for model gemini-2.5-pro (limit: 0 input tokens per minute on Free Tier)",
          );
        }
        chunkIndex += 1;
        if (chunkIndex === 1) {
          return JSON.stringify({
            operations: [
              {
                action: "CREATE_NEW",
                target_folder: "02_Projetos_e_Negocios",
                target_path: "02_Projetos_e_Negocios/Sistemas_e_SaaS/Kitsune Consolidation.md",
                filename_suggestion: "Kitsune Consolidation.md",
                title: "Kitsune Consolidation",
                markdown_body: "## Arquitetura Proxy\nBypass GET /v2/items via webhook.",
              },
            ],
          });
        }
        return JSON.stringify({
          operations: [
            {
              action: "CREATE_NEW",
              target_folder: "02_Projetos_e_Negocios",
              target_path: "02_Projetos_e_Negocios/Sistemas_e_SaaS/Kitsune Consolidation.md",
              filename_suggestion: "Kitsune Consolidation.md",
              title: "Kitsune Consolidation",
              content_markdown: "## Motor Matemático\nCDI, Fisher e reconciliador OFX.",
            },
          ],
        });
      },
    });

    const result = await organizer.organizeNote({
      rawContent: hugeRaw,
      originalFilename: "kitsune_gigante.md",
      createdStr: "2026-11-14 16:00",
      updatedStr: "2026-11-14 16:00",
      historicalDateStr: "14/11/2026 16:00",
      isChatDump: true,
      vaultContext: ctx,
    });

    // Chave #1 so deve tentar gemini-2.5-pro 1 unica vez; nos chunks seguintes pula direto para gemini-2.5-flash
    assert.equal(callModels.filter((m) => m === "gemini-2.5-pro").length, 1);
    assert.ok(callModels.filter((m) => m === "gemini-2.5-flash").length >= 2);

    const kitsuneOp = result.operations.find((op) =>
      op.target_path.endsWith("Kitsune Consolidation.md"),
    );
    assert.ok(kitsuneOp?.content_markdown);
    assert.ok(kitsuneOp.content_markdown.includes("Bypass GET /v2/items"));
    assert.ok(kitsuneOp.content_markdown.includes("CDI, Fisher e reconciliador OFX"));
  });
});

describe("V6.0 Cortex Vault Engine — Confiabilidade, Wiki-Fold e Lint", () => {
  it("normaliza caminhos NFD para NFC e detecta duplicatas via findSimilarExistingNote", () => {
    const nfdPath = "02_Projetos_e_Negocios\\Ana\u0301lise\\Recuperac\u0327a\u0303o.md";
    const normalized = normalizeVaultPath(nfdPath);
    assert.equal(normalized, normalizeNFC("02_Projetos_e_Negocios/Análise/Recuperação.md"));
    assert.ok(!normalized.includes("\\"));

    const existing = [
      {
        relativePath: "02_Projetos_e_Negocios/Sistemas_e_SaaS/Kitsune Finance.md",
        title: "Kitsune Finance",
        folder: "02_Projetos_e_Negocios/Sistemas_e_SaaS",
        category: "projetos",
        aliases: ["Open Finance Kitsune"],
        tags: ["fintech", "belvo", "ofx"],
        headings: ["Arquitetura Proxy", "Motor Matemático"],
      },
    ];

    const hit = findSimilarExistingNote(
      {
        title: "Open Finance Kitsune",
        folder: "02_Projetos_e_Negocios/Sistemas_e_SaaS",
        category: "projetos",
        tags: ["belvo"],
        content: "Arquitetura Proxy e Motor Matemático OFX",
      },
      existing,
    );
    assert.ok(hit);
    assert.equal(hit.entry.relativePath, existing[0]!.relativePath);
    assert.ok(hit.score >= 0.62);

    const allowed = [
      "01_Pessoas",
      "02_Projetos_e_Negocios",
      "03_Faculdade_e_Estudos/ADS_UNISUL",
    ];
    assert.equal(resolveTargetFolder("01_Pessoas/Falcão.md", "pessoas", allowed), "01_Pessoas");
    assert.equal(
      resolveTargetFolder(
        "03_Faculdade_e_Estudos/ADS_UNISUL/NotebookLM - Gravação.md",
        "faculdade_estudos",
        allowed,
      ),
      "03_Faculdade_e_Estudos/ADS_UNISUL",
    );
  });

  it("valida escrita com validateNoteBeforeWrite (fecha code fence aberto e barra truncamento)", () => {
    const longPrev = `---\ntitle: "Projeto"\n---\n\n${"Linha tecnica detalhada com regras de negocio. ".repeat(80)}`;
    const truncated = validateNoteBeforeWrite({
      targetPath: "02_Projetos_e_Negocios/Projeto.md",
      incomingMarkdown: "---\ntitle: \"Projeto\"\n---\n\nResumo curto demais.",
      previousMarkdown: longPrev,
    });
    assert.equal(truncated.valid, false);
    assert.ok(truncated.errors.some((e) => e.includes("anti-truncamento")));

    const openFence = validateNoteBeforeWrite({
      targetPath: "02_Projetos_e_Negocios/Snippet.md",
      incomingMarkdown: "---\ntitle: \"Snippet\"\n---\n\n## Codigo\n\n```ts\nconst x = 1;",
    });
    assert.equal(openFence.valid, true);
    assert.ok(openFence.sanitizedMarkdown.trimEnd().endsWith("```"));
  });

  it("executa rollback e commit transacionais gravando ledger.jsonl", async () => {
    const vaultRoot = await createTempVault();
    const targetExisting = "02_Projetos_e_Negocios/Nota_Existente.md";
    const targetCreated = "02_Projetos_e_Negocios/Nota_Nova.md";
    const writeLocal = async (rel: string, content: string): Promise<void> => {
      const full = path.join(vaultRoot, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf8");
    };
    await writeLocal(targetExisting, "VERSAO_ORIGINAL\n");

    const txMgr = new TransactionManager({
      vaultRoot,
      snapshotsDir: path.join(vaultRoot, ".automacao", "checkpoints", "snapshots"),
      ledgerFile: path.join(vaultRoot, ".automacao", "ledger.jsonl"),
      tempDir: path.join(vaultRoot, ".automacao", ".tmp"),
    });

    const tx1 = await txMgr.begin("00_Inbox_Bruto/teste1.md", [targetExisting, targetCreated], {
      modelUsed: "gemini-2.5-flash",
      keyNumber: 1,
    });
    await writeLocal(targetExisting, "VERSAO_CORROMPIDA\n");
    await writeLocal(targetCreated, "NOVA_QUE_DEVE_SUMIR\n");
    txMgr.recordTargetWrite(tx1, targetExisting, "UPDATE", "VERSAO_CORROMPIDA\n");
    txMgr.recordTargetWrite(tx1, targetCreated, "CREATE_NEW", "NOVA_QUE_DEVE_SUMIR\n");
    await txMgr.rollback(tx1, "Falha simulada");

    const restored = await fs.readFile(path.join(vaultRoot, targetExisting), "utf8");
    assert.equal(restored, "VERSAO_ORIGINAL\n");
    await assert.rejects(() => fs.stat(path.join(vaultRoot, targetCreated)));

    const tx2 = await txMgr.begin("00_Inbox_Bruto/teste2.md", [targetExisting], {
      modelUsed: "gemini-2.5-pro",
      keyNumber: 2,
    });
    await writeLocal(targetExisting, "VERSAO_FINAL_COMMITTED\n");
    txMgr.recordTargetWrite(tx2, targetExisting, "UPDATE", "VERSAO_FINAL_COMMITTED\n");
    await txMgr.commit(tx2, { notesCreated: 0, notesUpdated: 1 });

    const ledger = await txMgr.readLedger(10);
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0]?.status, "rolled_back");
    assert.equal(ledger[1]?.status, "committed");
    assert.equal(ledger[1]?.modelUsed, "gemini-2.5-pro");
    assert.equal(ledger[1]?.keyNumber, 2);
  });

  it("remove bypass deterministico (>35k chars) e aplica Section-Aware Wiki-Fold na API mockada", async () => {
    const logs: string[] = [];
    const logger = createMemoryLogger(logs);
    let aiCalls = 0;

    const fillerA = "Detalhe arquitetural preservado A. ".repeat(900);
    const fillerC = "Backlog preservado C. ".repeat(500);
    const hugeExisting = [
      "---",
      'title: "Kitsune Finance"',
      "tags: [projetos, fintech]",
      "---",
      "",
      "## Arquitetura Geral",
      "",
      fillerA,
      "",
      "## Motor Matemático",
      "",
      "Versao antiga do motor.",
      "",
      "## Pendências",
      "",
      fillerC,
      "",
    ].join("\n");
    assert.ok(hugeExisting.length > 35_000);

    const organizer = createGeminiOrganizer({
      apiKeys: ["KEY_WIKI_FOLD"],
      modelPrimary: "gemini-2.5-flash",
      modelHeavy: "gemini-2.5-pro",
      modelFast: "gemini-2.5-flash-lite",
      modelFallbacks: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
      logger,
      customRunner: async () => {
        aiCalls += 1;
        return JSON.stringify({
          action: "UPDATE",
          reason: "Wiki-Fold cirurgico na secao Motor Matemático",
          section_edits: [
            {
              mode: "REPLACE_SECTION",
              target_heading: "Motor Matemático",
              markdown: "Equação de Fisher, TIR e reconciliador OFX atualizados via Wiki-Fold.",
            },
          ],
          new_tags: ["wiki-fold", "ofx"],
        });
      },
    });

    assert.ok(organizer.mergeWithExistingNote);
    const merged = await organizer.mergeWithExistingNote({
      relativePath: "02_Projetos_e_Negocios/Sistemas_e_SaaS/Kitsune Finance.md",
      existingContent: hugeExisting,
      incomingOps: [
        {
          action: "APPEND_TO_EXISTING",
          target_path: "02_Projetos_e_Negocios/Sistemas_e_SaaS/Kitsune Finance.md",
          suggested_filename: "Kitsune Finance.md",
          content_markdown: "## Motor Matemático\nNova regra OFX e Fisher para cálculos financeiros.",
          new_tags: ["ofx"],
        },
      ],
      originalFilename: "00_Inbox_Bruto/atualizacao_motor.md",
      historicalDateStr: "14/11/2026 18:00",
      updatedStr: "2026-11-14 18:00",
    });

    assert.equal(aiCalls, 1);
    assert.equal(merged.action, "UPDATE");
    assert.ok(merged.updated_markdown);
    assert.ok(merged.updated_markdown.includes("Detalhe arquitetural preservado A."));
    assert.ok(
      merged.updated_markdown.includes(
        "Equação de Fisher, TIR e reconciliador OFX atualizados via Wiki-Fold.",
      ),
    );
    assert.ok(merged.updated_markdown.includes("Backlog preservado C."));
  });

  it("runActiveHygieneAndLint repara wikilinks quebrados e gera MOC Global e Dashboard Principal", async () => {
    const vaultRoot = await createTempVault();
    const writeLocal = async (rel: string, content: string): Promise<void> => {
      const full = path.join(vaultRoot, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf8");
    };

    await writeLocal(
      "02_Projetos_e_Negocios/Sistemas_e_SaaS/Projeto Alpha.md",
      [
        "---",
        'title: "Projeto Alpha"',
        "aliases: [Alpha Core]",
        "tags: [saas]",
        "updated: 2026-11-14",
        "category: projetos",
        "---",
        "",
        "Integração com [[Pessoa Teste]] e [[Alpha Core]].",
        "",
      ].join("\n"),
    );
    await writeLocal(
      "01_Pessoas/Pessoa Teste.md",
      [
        "---",
        'title: "Pessoa Teste"',
        "tags: [pessoa]",
        "updated: 2026-11-14",
        "category: pessoas",
        "---",
        "",
        "Contato do projeto.",
        "",
      ].join("\n"),
    );
    await writeLocal(
      "02_Projetos_e_Negocios/Nota Link Quebrado.md",
      [
        "---",
        'title: "Nota Link Quebrado"',
        "tags: [projetos]",
        "---",
        "",
        "Referência antiga: [[Alpha Core]] e [[02_Projetos_e_Negocios/Sistemas_e_SaaS/Projeto Alpha]].",
        "",
      ].join("\n"),
    );

    const report = await runActiveHygieneAndLint({
      vaultRoot,
      rootFolders: [
        "01_Pessoas",
        "02_Projetos_e_Negocios",
        "03_Faculdade_e_Estudos",
        "04_Padroes_e_Prompts",
        "05_Pessoal_e_Vida",
        "06_Referencia_e_Conhecimento",
      ],
    });

    assert.ok(report.totalNotes >= 3);
    assert.equal(report.mocUpdated, true);
    assert.equal(report.dashboardUpdated, true);

    const mocRaw = await fs.readFile(path.join(vaultRoot, "00_Indice_Global_MOC.md"), "utf8");
    const dashRaw = await fs.readFile(path.join(vaultRoot, "00_Dashboard_Principal.md"), "utf8");
    assert.ok(mocRaw.includes("[[02_Projetos_e_Negocios/Sistemas_e_SaaS/Projeto Alpha|Projeto Alpha]]"));
    assert.ok(dashRaw.includes("Total de Notas"));
  });

  it("coage frontmatter com aliases vazios e mais de 10 tags sem descartar resposta da API", async () => {
    const vaultRoot = await createTempVault();
    const ctx = await collectVaultContext(vaultRoot);
    const logs: string[] = [];
    const logger = createMemoryLogger(logs);

    const organizer = createGeminiOrganizer({
      apiKeys: ["KEY_COERCE"],
      modelPrimary: "gemini-2.5-flash",
      modelHeavy: "gemini-2.5-pro",
      modelFast: "gemini-2.5-flash-lite",
      modelFallbacks: ["gemini-2.5-flash"],
      logger,
      customRunner: async () =>
        JSON.stringify({
          operations: [
            {
              action: "CREATE_NEW",
              target_path: "02_Projetos_e_Negocios/Projeto Beno.md",
              suggested_filename: "Projeto Beno.md",
              content_markdown: "## Escopo\nDados do projeto com frontmatter fora do limite estrito.",
              frontmatter: {
                title: "Projeto Beno",
                aliases: [],
                tags: Array.from({ length: 12 }, (_, idx) => `tag-${idx + 1}`),
                created: "2026-11-14 18:00",
                updated: "2026-11-14 18:00",
                category: "projetos_negocios",
                status: "ativo",
              },
            },
          ],
        }),
    });

    const result = await organizer.organizeNote({
      rawContent: "Conteudo teste para coerção de frontmatter.",
      originalFilename: "00_Inbox_Bruto/Projeto Beno.md",
      createdStr: "2026-11-14 18:00",
      updatedStr: "2026-11-14 18:00",
      historicalDateStr: "14/11/2026 18:00",
      isChatDump: true,
      vaultContext: ctx,
    });

    assert.equal(result.operations.length, 1);
    const fm = result.operations[0]?.frontmatter;
    assert.ok(fm);
    assert.deepEqual(fm.aliases, ["Projeto Beno"]);
    assert.equal(fm.tags.length, 10);
  });
});
