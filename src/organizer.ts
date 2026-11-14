import fs from "node:fs/promises";
import path from "node:path";
import { ROOT_FOLDERS, type AppConfig } from "./config.js";
import {
  AllKeysExhaustedError,
  TransientNetworkError,
  isTransientNetworkError,
  type NoteOrganizerAI,
} from "./gemini.js";
import { atomicWriteFile, readFileWithRetry } from "./lib/atomic-write.js";
import { withFsRetry } from "./lib/fs-retry.js";
import { runActiveHygieneAndLint } from "./lib/lint-engine.js";
import { findSimilarExistingNote } from "./lib/memory-similarity.js";
import { recordSupersedeMetadata } from "./lib/memory-supersede.js";
import { TransactionManager } from "./lib/transaction.js";
import { normalizeNFC, normalizeVaultPath } from "./lib/unicode.js";
import { validateNoteBeforeWrite } from "./lib/validate-write.js";
import type { Logger } from "./logger.js";
import {
  applyProfileUpdate,
  archiveProcessedFile,
  collectVaultContext,
  computeContentHash,
  ensureInlineDateStamp,
  extractHistoricalDateFromFilename,
  extractHistoricalDateObjFromFilename,
  findMatchingNoteSummary,
  formatDateTime,
  formatDisplayDateTime,
  isEffectivelyEmptyNote,
  mergeIntoExistingNote,
  moveEmptyNoteToTrash,
  recordBotWriteHash,
  resolveTargetFolder,
  resolveUniqueDestination,
  sanitizeFilename,
  serializeMarkdownNote,
  shouldIgnoreRootFile,
  shouldIgnoreSubfolderFile,
  stampUserEditedNoteFallback,
  stripNoteExtension,
  tryReadGdocExport,
  updateSectionInExistingNote,
  type ExistingNoteSummary,
  type OrganizeOperation,
  type VaultIndexCache,
} from "./vault.js";

export interface RetryEntry {
  attempts: number;
  nextRetryAtMs: number;
  lastError: string;
  fileMtimeMs: number;
}

export interface ProcessResult {
  action:
    | "organized"
    | "appended"
    | "multi_processed"
    | "reorganized_edit"
    | "skipped_duplicate"
    | "deleted_empty"
    | "retry_queued"
    | "skipped";
  sourceFile: string;
  destinationFiles: string[];
  operationsCount?: number | undefined;
  profileUpdated?: boolean | undefined;
  reason?: string | undefined;
}

const CHAT_DUMP_MARKERS = [
  /voc[eê]\s+disse\s*:/i,
  /(?:o\s+)?gemini\s+disse\s*:/i,
  /\byou\s+said\b\s*:/i,
  /\bgemini\s+said\b\s*:/i,
  /conversa\s+com\s+(?:o\s+)?gemini/i,
  /exportado\s+(?:do|pelo)\s+gemini/i,
  /^prompt\s*:/im,
  /^resposta\s*:/im,
  /\bchatgpt\b/i,
];

function looksLikeChatDump(text: string): boolean {
  return CHAT_DUMP_MARKERS.some((pattern) => pattern.test(text));
}

async function readIndexCacheEntries(cachePath: string): Promise<VaultIndexCache["entries"]> {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<VaultIndexCache>;
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
      return parsed.entries;
    }
  } catch {
    // Sem cache previo
  }
  return {};
}

async function persistBotHashForFile(
  config: AppConfig,
  relPath: string,
  absPath: string,
  content: string,
): Promise<void> {
  const st = await fs.stat(absPath).catch(() => null);
  await recordBotWriteHash({
    indexCachePath: config.indexCacheFile,
    relPath,
    content,
    mtimeMs: st?.mtimeMs,
    size: st?.size,
  }).catch(() => undefined);
}

function isTransientOrQuotaError(err: unknown): boolean {
  return (
    err instanceof TransientNetworkError ||
    err instanceof AllKeysExhaustedError ||
    isTransientNetworkError(err)
  );
}

/** Calcula exponential backoff: baseMs, 2*baseMs, ..., limitado a 15 minutos. */
export function computeBackoffMs(attempts: number, baseMs: number = 60_000): number {
  const safeAttempts = Math.max(1, attempts);
  return Math.min(baseMs * Math.pow(2, safeAttempts - 1), 15 * 60_000);
}

async function executeOperation(params: {
  op: OrganizeOperation;
  originalFilename: string;
  createdAt: Date;
  historicalDisplayDate: string;
  now: Date;
  config: AppConfig;
  logger: Logger;
  summaries: ExistingNoteSummary[];
  allowedFolders: readonly string[];
  txManager?: TransactionManager | undefined;
  txId?: string | undefined;
}): Promise<{ kind: string; destination?: string; profileUpdated: boolean }> {
  const {
    op,
    originalFilename,
    createdAt,
    historicalDisplayDate,
    now,
    config,
    logger,
    summaries,
    allowedFolders,
    txManager,
    txId,
  } = params;

  const tempDir = config.tempDir ?? path.join(config.automacaoDir, ".tmp");
  const stampedMarkdown = op.content_markdown
    ? ensureInlineDateStamp(op.content_markdown, historicalDisplayDate)
    : undefined;

  if (op.action === "SKIP_DUPLICATE") {
    await logger.info(
      `SKIP_DUPLICATE (${originalFilename}): ja coberto em "${op.target_path}" (${
        op.duplicate_reason ?? "sem motivo detalhado"
      })`,
    );
    return { kind: "skipped_duplicate", destination: op.target_path, profileUpdated: false };
  }

  if (op.action === "APPEND_TO_EXISTING" || op.action === "UPDATE_SECTION_IN_EXISTING") {
    const matched = findMatchingNoteSummary(op.target_path, summaries);
    const isProfile =
      op.target_path.replace(/\\/g, "/").toLowerCase() === config.profileNoteRelPath.toLowerCase() ||
      matched?.relativePath.toLowerCase() === config.profileNoteRelPath.toLowerCase();

    if (isProfile && stampedMarkdown) {
      const profileRel = normalizeVaultPath(config.profileNoteRelPath);
      const profileAbsPath = path.join(config.vaultRoot, profileRel);
      try {
        const currentProfile = await readFileWithRetry(profileAbsPath);
        const evolvedRaw = applyProfileUpdate({
          profileContent: currentProfile,
          sectionToUpdate: op.section_heading ?? "Rotina, Lazer e Patrimônio",
          updatedFactMarkdown: stampedMarkdown,
          changelogEntry:
            op.changelog_entry ?? `Atualização automática via ${originalFilename}`,
          updatedAt: now,
        });
        const superseded = recordSupersedeMetadata(evolvedRaw, {
          sourceChat: originalFilename,
          updatedAt: formatDateTime(now),
        });
        const validated = validateNoteBeforeWrite({
          targetPath: profileRel,
          incomingMarkdown: superseded,
          previousMarkdown: currentProfile,
        });
        if (!validated.valid) {
          throw new Error(validated.errors.join("; "));
        }
        if (txManager && txId) {
          await txManager.ensureTargetSnapshot(txId, profileRel);
        }
        await atomicWriteFile(profileAbsPath, validated.sanitizedMarkdown, tempDir);
        txManager?.recordTargetWrite(txId ?? "", profileRel, "PROFILE_EVOLVED", validated.sanitizedMarkdown);
        await persistBotHashForFile(config, profileRel, profileAbsPath, validated.sanitizedMarkdown);
        await logger.info(
          `PROFILE_EVOLVED (${originalFilename}): seção "${
            op.section_heading ?? "Geral"
          }" atualizada.`,
        );
        return { kind: "profile", destination: profileRel, profileUpdated: true };
      } catch (err: unknown) {
        await logger.warn(
          `PROFILE_UPDATE_FALLBACK (${originalFilename}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (matched && stampedMarkdown) {
      const targetRel = normalizeVaultPath(matched.relativePath);
      const targetAbsPath = path.join(config.vaultRoot, targetRel);
      const existingContent = await readFileWithRetry(targetAbsPath);
      const updatedContent =
        op.action === "UPDATE_SECTION_IN_EXISTING" && op.section_heading
          ? updateSectionInExistingNote({
              existingContent,
              sectionHeading: op.section_heading,
              replacementMarkdown: stampedMarkdown,
              newTags: op.new_tags,
              newAliases: op.new_aliases,
              updatedAt: now,
            })
          : mergeIntoExistingNote({
              existingContent,
              appendSectionMarkdown: stampedMarkdown,
              sectionHeading: op.section_heading,
              newTags: op.new_tags,
              newAliases: op.new_aliases,
              updatedAt: now,
            });

      const superseded = recordSupersedeMetadata(updatedContent, {
        sourceChat: originalFilename,
        updatedAt: formatDateTime(now),
      });
      const validated = validateNoteBeforeWrite({
        targetPath: targetRel,
        incomingMarkdown: superseded,
        previousMarkdown: existingContent,
      });
      if (!validated.valid) {
        throw new Error(`Validacao falhou para "${targetRel}": ${validated.errors.join("; ")}`);
      }
      if (txManager && txId) {
        await txManager.ensureTargetSnapshot(txId, targetRel);
      }
      await atomicWriteFile(targetAbsPath, validated.sanitizedMarkdown, tempDir);
      txManager?.recordTargetWrite(txId ?? "", targetRel, op.action, validated.sanitizedMarkdown);
      await persistBotHashForFile(config, targetRel, targetAbsPath, validated.sanitizedMarkdown);
      await logger.info(
        `${op.action} (${originalFilename}): "${targetRel}"${
          op.section_heading ? ` [seção: ${op.section_heading}]` : ""
        }`,
      );
      return { kind: "appended", destination: targetRel, profileUpdated: false };
    }

    await logger.warn(
      `${op.action}_FALLBACK (${originalFilename}): Nota alvo "${op.target_path}" nao encontrada. Criando nova nota.`,
    );
  }

  const baseName = stripNoteExtension(originalFilename);
  const fm = op.frontmatter ?? {
    title: baseName,
    aliases: [baseName],
    tags: ["nota"],
    created: formatDateTime(createdAt),
    updated: formatDateTime(now),
    category: "pessoal_vida" as const,
    status: "ativo" as const,
  };

  const targetFolderRel = resolveTargetFolder(op.target_path, fm.category, allowedFolders);
  const targetFolderAbs = path.join(config.vaultRoot, targetFolderRel);
  await withFsRetry(() => fs.mkdir(targetFolderAbs, { recursive: true }), `mkdir:${targetFolderRel}`);

  const cleanFilename = sanitizeFilename(op.suggested_filename ?? `${fm.title}.md`);
  const destAbsPath = await resolveUniqueDestination(targetFolderAbs, cleanFilename);
  const finalMarkdownRaw = serializeMarkdownNote(
    fm,
    stampedMarkdown ?? op.content_markdown ?? "",
    createdAt,
    now,
  );
  const destRel = normalizeVaultPath(path.relative(config.vaultRoot, destAbsPath));
  const withProvenance = recordSupersedeMetadata(finalMarkdownRaw, {
    sourceChat: originalFilename,
    updatedAt: formatDateTime(now),
  });
  const validated = validateNoteBeforeWrite({
    targetPath: destRel,
    incomingMarkdown: withProvenance,
  });
  if (!validated.valid) {
    throw new Error(`Validacao falhou para nova nota "${destRel}": ${validated.errors.join("; ")}`);
  }

  if (txManager && txId) {
    await txManager.ensureTargetSnapshot(txId, destRel);
  }
  await atomicWriteFile(destAbsPath, validated.sanitizedMarkdown, tempDir);
  txManager?.recordTargetWrite(txId ?? "", destRel, "CREATE_NEW", validated.sanitizedMarkdown);

  await persistBotHashForFile(config, destRel, destAbsPath, validated.sanitizedMarkdown);
  summaries.push({
    relativePath: destRel,
    name: normalizeNFC(path.basename(destRel, ".md")),
    title: normalizeNFC(fm.title),
    aliases: fm.aliases,
    tags: fm.tags,
    headings: [],
    mtimeMs: Date.now(),
    size: Buffer.byteLength(validated.sanitizedMarkdown, "utf8"),
  });

  await logger.info(`CREATE_NEW (${originalFilename}): "${destRel}"`);
  return { kind: "created", destination: destRel, profileUpdated: false };
}

function isSafeMergedContent(existingContent: string, candidateMarkdown: string): boolean {
  if (!candidateMarkdown || isEffectivelyEmptyNote(candidateMarkdown)) {
    return false;
  }
  const normalizedExisting = existingContent.trim();
  const normalizedCandidate = candidateMarkdown.trim();
  if (normalizedExisting.length > 120 && normalizedCandidate.length < normalizedExisting.length * 0.45) {
    return false;
  }
  if (/^---\r?\n/.test(normalizedExisting) && !/^---\r?\n/.test(normalizedCandidate)) {
    return false;
  }
  return true;
}

async function applyOperationsWithReadBeforeWrite(params: {
  operations: readonly OrganizeOperation[];
  originalFilename: string;
  createdAt: Date;
  historicalDisplayDate: string;
  now: Date;
  config: AppConfig;
  ai: NoteOrganizerAI | null;
  logger: Logger;
  summaries: ExistingNoteSummary[];
  allowedFolders: readonly string[];
  txManager?: TransactionManager | undefined;
  txId?: string | undefined;
}): Promise<{
  destinations: string[];
  createdCount: number;
  appendedCount: number;
  skippedCount: number;
  profileUpdated: boolean;
}> {
  const {
    operations,
    originalFilename,
    createdAt,
    historicalDisplayDate,
    now,
    config,
    ai,
    logger,
    summaries,
    allowedFolders,
    txManager,
    txId,
  } = params;

  const tempDir = config.tempDir ?? path.join(config.automacaoDir, ".tmp");
  const destinations: string[] = [];
  let createdCount = 0;
  let appendedCount = 0;
  let skippedCount = 0;
  let profileUpdated = false;

  const immediateOps: OrganizeOperation[] = [];
  const groupedExistingOps = new Map<string, { matched: ExistingNoteSummary; ops: OrganizeOperation[] }>();

  for (const op of operations) {
    if (op.action === "APPEND_TO_EXISTING" || op.action === "UPDATE_SECTION_IN_EXISTING") {
      const matched = findMatchingNoteSummary(op.target_path, summaries);
      const isMetaIndexOrProfile =
        matched !== undefined && path.basename(matched.relativePath).startsWith("00_");
      if (
        matched &&
        !isMetaIndexOrProfile &&
        op.content_markdown &&
        op.content_markdown.trim().length > 0
      ) {
        const group = groupedExistingOps.get(matched.relativePath);
        if (group) {
          group.ops.push(op);
        } else {
          groupedExistingOps.set(matched.relativePath, { matched, ops: [op] });
        }
        continue;
      }
    }

    if (op.action === "CREATE_NEW" && op.content_markdown && op.content_markdown.trim().length > 0) {
      const nonIndexSummaries = summaries.filter(
        (s) => !path.basename(s.relativePath).startsWith("00_"),
      );
      const exactMatch = findMatchingNoteSummary(
        op.suggested_filename ?? op.target_path,
        nonIndexSummaries,
      );
      const similarityHit = exactMatch
        ? { entry: exactMatch, score: 1 }
        : findSimilarExistingNote(
            {
              title: op.frontmatter?.title ?? stripNoteExtension(op.suggested_filename ?? op.target_path),
              category: op.frontmatter?.category,
              folder: op.target_path,
              tags: op.frontmatter?.tags ?? op.new_tags,
              content: op.content_markdown,
            },
            nonIndexSummaries,
            0.68,
          );

      if (similarityHit) {
        const matched = similarityHit.entry;
        const redirectedOp: OrganizeOperation = {
          ...op,
          action: "APPEND_TO_EXISTING",
          target_path: matched.relativePath,
        };
        await logger.info(
          `SIMILARITY_MERGE_REDIRECT (${originalFilename}): "${op.target_path}" -> "${matched.relativePath}" (score=${similarityHit.score.toFixed(2)})`,
        );
        const group = groupedExistingOps.get(matched.relativePath);
        if (group) {
          group.ops.push(redirectedOp);
        } else {
          groupedExistingOps.set(matched.relativePath, { matched, ops: [redirectedOp] });
        }
        continue;
      }
    }

    immediateOps.push(op);
  }

  // 1. Executa SKIP_DUPLICATE, CREATE_NEW e fallbacks antes dos merges para garantir links validos
  for (const op of immediateOps) {
    const outcome = await executeOperation({
      op,
      originalFilename,
      createdAt,
      historicalDisplayDate,
      now,
      config,
      logger,
      summaries,
      allowedFolders,
      txManager,
      txId,
    });
    if (outcome.destination) {
      destinations.push(outcome.destination);
    }
    if (outcome.profileUpdated) {
      profileUpdated = true;
    }
    if (outcome.kind === "created") createdCount += 1;
    else if (outcome.kind === "appended" || outcome.kind === "profile") appendedCount += 1;
    else if (outcome.kind === "skipped_duplicate") skippedCount += 1;
  }

  // 2. Read-Before-Write / Section-Aware Wiki-Fold agrupado por nota existente alvo (sem bypass de IA)
  for (const { matched, ops } of groupedExistingOps.values()) {
    const targetRel = normalizeVaultPath(matched.relativePath);
    const isProfile =
      targetRel.toLowerCase() === config.profileNoteRelPath.toLowerCase();

    if (ai?.mergeWithExistingNote) {
      const targetAbsPath = path.join(config.vaultRoot, targetRel);
      try {
        const existingContent = await readFileWithRetry(targetAbsPath);
        const mergeResult = await ai.mergeWithExistingNote({
          relativePath: targetRel,
          existingContent,
          incomingOps: ops,
          originalFilename,
          historicalDateStr: historicalDisplayDate,
          updatedStr: formatDateTime(now),
        });

        if (mergeResult.action === "NO_OP") {
          await logger.info(
            `READ_BEFORE_WRITE_SKIP (${originalFilename}): "${targetRel}" (${
              mergeResult.reason ?? "fatos ja presentes na nota"
            })`,
          );
          destinations.push(targetRel);
          skippedCount += ops.length;
          continue;
        }

        const candidateRaw = `${(mergeResult.updated_markdown ?? "").trimEnd()}\n`;
        const rawSafe = isSafeMergedContent(existingContent, candidateRaw);
        const supersededCandidate = rawSafe
          ? recordSupersedeMetadata(candidateRaw, {
              sourceChat: originalFilename,
              updatedAt: formatDateTime(now),
            })
          : candidateRaw;
        const validated = validateNoteBeforeWrite({
          targetPath: targetRel,
          incomingMarkdown: supersededCandidate,
          previousMarkdown: existingContent,
        });

        if (rawSafe && validated.valid && isSafeMergedContent(existingContent, validated.sanitizedMarkdown)) {
          if (txManager && txId) {
            await txManager.ensureTargetSnapshot(txId, targetRel);
          }
          await atomicWriteFile(targetAbsPath, validated.sanitizedMarkdown, tempDir);
          txManager?.recordTargetWrite(txId ?? "", targetRel, "WIKI_FOLD_MERGE", validated.sanitizedMarkdown);
          await persistBotHashForFile(config, targetRel, targetAbsPath, validated.sanitizedMarkdown);
          await logger.info(
            `WIKI_FOLD_MERGE (${originalFilename}): "${targetRel}" (${ops.length} op(s) consolidadas via Gemini API)`,
          );
          destinations.push(targetRel);
          appendedCount += 1;
          if (isProfile) {
            profileUpdated = true;
          }
          continue;
        }

        await logger.warn(
          `READ_BEFORE_WRITE_GUARD (${originalFilename}): merge rejeitado para "${targetRel}" (${validated.errors.join(
            "; ",
          )}). Aplicando fallback seguro por secao.`,
        );
      } catch (err: unknown) {
        if (isTransientOrQuotaError(err)) {
          throw err;
        }
        await logger.warn(
          `READ_BEFORE_WRITE_FALLBACK (${originalFilename} -> ${targetRel}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Fallback deterministico apenas quando mock unitario nao fornece `mergeWithExistingNote` ou apos guarda anti-truncamento
    for (const op of ops) {
      const outcome = await executeOperation({
        op,
        originalFilename,
        createdAt,
        historicalDisplayDate,
        now,
        config,
        logger,
        summaries,
        allowedFolders,
        txManager,
        txId,
      });
      if (outcome.destination) {
        destinations.push(outcome.destination);
      }
      if (outcome.profileUpdated) {
        profileUpdated = true;
      }
      if (outcome.kind === "created") createdCount += 1;
      else if (outcome.kind === "appended" || outcome.kind === "profile") appendedCount += 1;
      else if (outcome.kind === "skipped_duplicate") skippedCount += 1;
    }
  }

  return {
    destinations: Array.from(new Set(destinations)),
    createdCount,
    appendedCount,
    skippedCount,
    profileUpdated,
  };
}

/**
 * Executa organizacao multi-assunto V6.0 (Cortex Engine):
 * Chunked Map-Reduce -> Wiki-Fold transacional -> Active Hygiene/MOC -> Arquiva & remove original.
 */
export async function processInboxMarkdownFile(params: {
  filename: string;
  sourceDir?: string | undefined;
  isChatDump?: boolean | undefined;
  overrideContent?: string | undefined;
  config: AppConfig;
  ai: NoteOrganizerAI;
  logger: Logger;
  now?: Date | undefined;
}): Promise<ProcessResult> {
  const { filename, config, ai, logger } = params;
  const sourceDir = params.sourceDir ?? config.vaultRoot;
  const now = params.now ?? new Date();
  const sourcePath = path.join(sourceDir, filename);

  const stat = await withFsRetry(() => fs.stat(sourcePath), `inbox:stat:${filename}`);
  if (!stat.isFile()) {
    return { action: "skipped", sourceFile: filename, destinationFiles: [], reason: "not_a_file" };
  }

  const rawContent = params.overrideContent ?? (await readFileWithRetry(sourcePath));
  if (isEffectivelyEmptyNote(rawContent)) {
    return {
      action: "skipped",
      sourceFile: filename,
      destinationFiles: [],
      reason: "empty_content",
    };
  }

  const fallbackMtime =
    stat.birthtimeMs > 0 && stat.birthtimeMs < stat.mtimeMs ? stat.birthtime : stat.mtime;
  const createdAt = extractHistoricalDateObjFromFilename(filename, fallbackMtime);
  const historicalDisplayDate = extractHistoricalDateFromFilename(filename, fallbackMtime);
  const isChatDump = (params.isChatDump ?? false) || looksLikeChatDump(rawContent);

  const vaultContext = await collectVaultContext(config.vaultRoot, config.indexCacheFile);
  const mutableSummaries = [...vaultContext.summaries];
  const aiPayload = await ai.organizeNote({
    originalFilename: filename,
    rawContent,
    createdStr: formatDateTime(createdAt),
    updatedStr: formatDateTime(now),
    historicalDateStr: historicalDisplayDate,
    vaultContext,
    isChatDump,
  });

  const checkpointsDir = config.checkpointsDir ?? path.join(config.automacaoDir, "checkpoints");
  const ledgerFile = config.ledgerFile ?? path.join(config.automacaoDir, "ledger.jsonl");
  const tempDir = config.tempDir ?? path.join(config.automacaoDir, ".tmp");

  const txManager = new TransactionManager({
    vaultRoot: config.vaultRoot,
    snapshotsDir: path.join(checkpointsDir, "snapshots"),
    ledgerFile,
    tempDir,
  });

  const execMeta = ai.getLastExecutionMeta?.();
  const txId = await txManager.begin(
    path.relative(config.vaultRoot, sourcePath),
    [],
    {
      operationType: isChatDump ? "ingest-chat" : "ingest-note",
      modelUsed: execMeta?.modelUsed,
      keyNumber: execMeta?.keyNumber,
    },
  );

  let destinations: string[];
  let createdCount: number;
  let appendedCount: number;
  let skippedCount: number;
  let profileUpdated: boolean;

  try {
    const applied = await applyOperationsWithReadBeforeWrite({
      operations: aiPayload.operations,
      originalFilename: filename,
      createdAt,
      historicalDisplayDate,
      now,
      config,
      ai,
      logger,
      summaries: mutableSummaries,
      allowedFolders: vaultContext.folders,
      txManager,
      txId,
    });
    destinations = applied.destinations;
    createdCount = applied.createdCount;
    appendedCount = applied.appendedCount;
    skippedCount = applied.skippedCount;
    profileUpdated = applied.profileUpdated;

    const finalMeta = ai.getLastExecutionMeta?.() ?? execMeta;
    await txManager.commit(txId, {
      modelUsed: finalMeta?.modelUsed,
      keyNumber: finalMeta?.keyNumber,
      notesCreated: createdCount,
      notesUpdated: appendedCount,
    });
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    await txManager.rollback(txId, reason).catch(() => undefined);
    throw err;
  }

  const archivePath = await archiveProcessedFile({
    sourcePath,
    originalFilename: filename,
    archiveDir: config.processedArchiveDir,
    now,
    maxEntries: 200,
  });
  await withFsRetry(() => fs.unlink(sourcePath), `inbox:unlink:${filename}`);

  if (createdCount > 0 || appendedCount > 0) {
    try {
      await runActiveHygieneAndLint({
        vaultRoot: config.vaultRoot,
        rootFolders: ROOT_FOLDERS,
        tempDir,
        recordBotWrite: (absPath, content) => {
          const rel = normalizeVaultPath(path.relative(config.vaultRoot, absPath));
          void persistBotHashForFile(config, rel, absPath, content).catch(() => undefined);
        },
      });
    } catch (lintErr: unknown) {
      await logger.warn(
        `ACTIVE_HYGIENE_WARN (${filename}): ${
          lintErr instanceof Error ? lintErr.message : String(lintErr)
        }`,
      );
    }
  }

  await logger.info(
    `ARCHIVE_CLEANUP (${filename}): arquivado em "${path.basename(archivePath)}" | data original: ${historicalDisplayDate} | operacoes: ${aiPayload.operations.length}`,
  );

  const action: ProcessResult["action"] =
    aiPayload.operations.length > 1
      ? "multi_processed"
      : createdCount > 0
        ? "organized"
        : appendedCount > 0
          ? "appended"
          : skippedCount > 0
            ? "skipped_duplicate"
            : "organized";

  return {
    action,
    sourceFile: filename,
    destinationFiles: destinations,
    operationsCount: aiPayload.operations.length,
    profileUpdated,
  };
}

/**
 * Varre a raiz, `.automacao/inbox_chats/`, `00_Inbox_Bruto/` (.md, .txt, .gdoc) e subpastas V5 (`01_Pessoas`..`05_Pessoal_e_Vida`).
 * Aplica exclusao instantanea de notas vazias (60s -> trash + limpeza de [[Wikilinks]]),
 * guarda anti-loop SHA-256 nas edicoes de subpastas (90s) e Retry Queue com backoff.
 */
export async function scanVaultRoot(params: {
  config: AppConfig;
  ai: NoteOrganizerAI | null;
  logger: Logger;
  processingFiles: Set<string>;
  lastObservedActivity: Map<string, number>;
  retryState: Map<string, RetryEntry>;
  nowMs?: number;
}): Promise<ProcessResult[]> {
  const { config, ai, logger, processingFiles, lastObservedActivity, retryState } = params;
  const nowMs = params.nowMs ?? Date.now();
  const results: ProcessResult[] = [];
  const activeTrackingKeys = new Set<string>();

  const scanDirectories: Array<{ dir: string; prefix: string; isChatDump: boolean }> = [
    { dir: config.vaultRoot, prefix: "", isChatDump: false },
    { dir: config.inboxChatsDir, prefix: "inbox_chats/", isChatDump: true },
    { dir: path.join(config.vaultRoot, "00_Inbox_Bruto"), prefix: "00_Inbox_Bruto/", isChatDump: true },
  ];

  for (const target of scanDirectories) {
    let entries;
    try {
      entries = await withFsRetry(
        () => fs.readdir(target.dir, { withFileTypes: true }),
        `scan:readdir:${target.prefix || "root"}`,
      );
    } catch {
      continue;
    }

    const candidates: Array<{
      entryName: string;
      trackingKey: string;
      absPath: string;
      stat: { size: number; mtimeMs: number };
    }> = [];

    for (const entry of entries) {
      if (!entry.isFile() || shouldIgnoreRootFile(entry.name)) {
        continue;
      }

      const normEntryName = normalizeNFC(entry.name);
      const trackingKey = normalizeNFC(`${target.prefix}${normEntryName}`);
      activeTrackingKeys.add(trackingKey);
      if (processingFiles.has(trackingKey)) {
        continue;
      }

      const absPath = path.join(target.dir, entry.name);
      try {
        const stat = await withFsRetry(() => fs.stat(absPath), `scan:stat:${trackingKey}`);
        candidates.push({ entryName: entry.name, trackingKey, absPath, stat });
      } catch {
        continue;
      }
    }

    // Drena notas menores antes de dumps gigantes (>100KB) para evitar bloqueio da fila
    candidates.sort((a, b) => a.stat.size - b.stat.size);

    const targetDebounceMs =
      target.prefix === "00_Inbox_Bruto/"
        ? (config.inboxBrutoDebounceMs ?? config.debounceMs)
        : config.debounceMs;

    for (const { entryName, trackingKey, absPath, stat } of candidates) {
      const watchedAt = lastObservedActivity.get(trackingKey) ?? 0;
      const lastModifiedMs = Math.max(stat.mtimeMs, watchedAt);
      const idleMs = nowMs - lastModifiedMs;
      const isGdoc = entryName.toLowerCase().endsWith(".gdoc");

      if (!isGdoc) {
        let contentForEmptyCheck = "";
        let readFailed = false;
        if (stat.size > 0) {
          try {
            contentForEmptyCheck = await readFileWithRetry(absPath);
          } catch {
            readFailed = true;
          }
        }

        if (!readFailed && (stat.size === 0 || isEffectivelyEmptyNote(contentForEmptyCheck))) {
          if (idleMs >= config.emptyNoteDebounceMs) {
            processingFiles.add(trackingKey);
            try {
              const trashed = await moveEmptyNoteToTrash({
                absPath,
                relPath: trackingKey,
                vaultRoot: config.vaultRoot,
                trashDir: config.trashDir,
                indexCachePath: config.indexCacheFile,
                now: new Date(nowMs),
              });
              lastObservedActivity.delete(trackingKey);
              retryState.delete(trackingKey);
              await logger.info(
                `EMPTY_NOTE_TRASHED: "${trackingKey}" movido para trash (${path.basename(
                  trashed.trashPath,
                )}). Links limpos em ${trashed.cleanedLinksIn.length} nota(s).`,
              );
              results.push({
                action: "deleted_empty",
                sourceFile: trackingKey,
                destinationFiles: trashed.cleanedLinksIn,
              });
            } catch (err: unknown) {
              await logger.error(
                `CLEANUP_ERROR (${trackingKey}): ${err instanceof Error ? err.message : String(err)}`,
              );
            } finally {
              processingFiles.delete(trackingKey);
            }
          }
          continue;
        }
      }

      if (idleMs < targetDebounceMs) {
        continue;
      }

      const existingRetry = retryState.get(trackingKey);
      if (existingRetry) {
        if (stat.mtimeMs > existingRetry.fileMtimeMs) {
          retryState.delete(trackingKey);
        } else if (nowMs < existingRetry.nextRetryAtMs) {
          continue;
        }
      }

      if (!ai) {
        continue;
      }

      processingFiles.add(trackingKey);
      try {
        let overrideContent: string | undefined;
        if (isGdoc) {
          const gdocRes = await tryReadGdocExport(absPath);
          if (!gdocRes.ok) {
            const isPermanentOrPrivate =
              gdocRes.reason === "drive_virtual_shortcut" ||
              gdocRes.reason.startsWith("http_401") ||
              gdocRes.reason.startsWith("http_403") ||
              gdocRes.reason.startsWith("http_404") ||
              gdocRes.reason === "missing_doc_id" ||
              gdocRes.reason === "invalid_gdoc_json" ||
              gdocRes.reason.startsWith("read_error:");
            if (isPermanentOrPrivate) {
              retryState.set(trackingKey, {
                attempts: 1,
                nextRetryAtMs: nowMs + 60 * 60_000,
                lastError: gdocRes.reason,
                fileMtimeMs: stat.mtimeMs,
              });
              await logger.warn(
                `GDOC_AWAITING_BRIDGE (${trackingKey}): "${gdocRes.reason}". Converta via cloud_drive_organizer.gs (Apps Script Bridge -> 00_Inbox_Bruto/*.md).`,
              );
              continue;
            }
            throw new TransientNetworkError(`GDOC_FETCH_FAILED: ${gdocRes.reason}`);
          }
          overrideContent = gdocRes.text;
        }

        const result = await processInboxMarkdownFile({
          filename: entryName,
          sourceDir: target.dir,
          isChatDump: target.isChatDump,
          overrideContent,
          config,
          ai,
          logger,
          now: new Date(nowMs),
        });
        if (
          result.action === "organized" ||
          result.action === "appended" ||
          result.action === "multi_processed" ||
          result.action === "skipped_duplicate"
        ) {
          lastObservedActivity.delete(trackingKey);
          retryState.delete(trackingKey);
        }
        results.push(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const attempts = (existingRetry?.attempts ?? 0) + 1;
        const backoffMs = computeBackoffMs(attempts, config.debounceMs);
        retryState.set(trackingKey, {
          attempts,
          nextRetryAtMs: nowMs + backoffMs,
          lastError: message,
          fileMtimeMs: stat.mtimeMs,
        });

        if (isTransientOrQuotaError(err)) {
          await logger.warn(
            `RETRY_QUEUED (${trackingKey}): tentativa #${attempts} falhou (${message}). ` +
              `Nova tentativa em ${Math.round(backoffMs / 1000)}s.`,
          );
        } else {
          await logger.error(
            `ORGANIZE_ERROR (${trackingKey}): ${message}. Reagendado em ${Math.round(backoffMs / 1000)}s.`,
          );
        }

        results.push({
          action: "retry_queued",
          sourceFile: trackingKey,
          destinationFiles: [],
          reason: message,
        });
      } finally {
        processingFiles.delete(trackingKey);
      }
    }
  }

  // Varredura de subpastas (01_Pessoas .. 05_Pessoal_e_Vida) para exclusao de vazias & auto-reorg com SHA-256
  const cachedEntries = await readIndexCacheEntries(config.indexCacheFile);
  const subfolderFiles: Array<{ relPath: string; absPath: string }> = [];

  async function walkSubfolder(absDir: string, relDir: string): Promise<void> {
    let dirEntries;
    try {
      dirEntries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dEntry of dirEntries) {
      if (dEntry.name.startsWith(".")) {
        continue;
      }
      const nextAbs = path.join(absDir, dEntry.name);
      const nextRel = `${relDir}/${dEntry.name}`;
      if (dEntry.isDirectory()) {
        await walkSubfolder(nextAbs, nextRel);
      } else if (dEntry.isFile() && !shouldIgnoreSubfolderFile(nextRel)) {
        subfolderFiles.push({ relPath: nextRel, absPath: nextAbs });
      }
    }
  }

  for (const rootFolder of ROOT_FOLDERS) {
    await walkSubfolder(path.join(config.vaultRoot, rootFolder), rootFolder);
  }

  for (const sf of subfolderFiles) {
    activeTrackingKeys.add(sf.relPath);
    if (processingFiles.has(sf.relPath)) {
      continue;
    }

    let st;
    try {
      st = await withFsRetry(() => fs.stat(sf.absPath), `sub:stat:${sf.relPath}`);
    } catch {
      continue;
    }

    const watchedAt = lastObservedActivity.get(sf.relPath) ?? 0;
    const lastModifiedMs = Math.max(st.mtimeMs, watchedAt);
    const idleMs = nowMs - lastModifiedMs;

    if (idleMs < config.emptyNoteDebounceMs) {
      continue;
    }

    let content: string;
    try {
      content = st.size === 0 ? "" : await readFileWithRetry(sf.absPath);
    } catch {
      continue;
    }

    if (st.size === 0 || isEffectivelyEmptyNote(content)) {
      processingFiles.add(sf.relPath);
      try {
        const trashed = await moveEmptyNoteToTrash({
          absPath: sf.absPath,
          relPath: sf.relPath,
          vaultRoot: config.vaultRoot,
          trashDir: config.trashDir,
          indexCachePath: config.indexCacheFile,
          now: new Date(nowMs),
        });
        lastObservedActivity.delete(sf.relPath);
        retryState.delete(sf.relPath);
        await logger.info(
          `EMPTY_SUBFOLDER_NOTE_TRASHED: "${sf.relPath}" movido para trash. Links limpos em ${trashed.cleanedLinksIn.length} nota(s).`,
        );
        results.push({
          action: "deleted_empty",
          sourceFile: sf.relPath,
          destinationFiles: trashed.cleanedLinksIn,
        });
      } catch (err: unknown) {
        await logger.error(
          `EMPTY_SUBFOLDER_CLEANUP_ERROR (${sf.relPath}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } finally {
        processingFiles.delete(sf.relPath);
      }
      continue;
    }

    if (idleMs < config.subFolderDebounceMs) {
      continue;
    }

    const currentHash = computeContentHash(content);
    const cached = cachedEntries[sf.relPath];
    if (cached?.lastBotWriteHash === currentHash) {
      continue;
    }

    // Se cache anterior da V4 bate exato em mtimeMs e size mas ainda nao tinha hash, semeia hash silenciosamente
    if (
      cached &&
      !cached.lastBotWriteHash &&
      cached.mtimeMs === st.mtimeMs &&
      cached.size === st.size
    ) {
      await recordBotWriteHash({
        indexCachePath: config.indexCacheFile,
        relPath: sf.relPath,
        content,
        mtimeMs: st.mtimeMs,
        size: st.size,
      }).catch(() => undefined);
      continue;
    }

    const existingRetry = retryState.get(sf.relPath);
    if (existingRetry) {
      if (st.mtimeMs > existingRetry.fileMtimeMs) {
        retryState.delete(sf.relPath);
      } else if (nowMs < existingRetry.nextRetryAtMs) {
        continue;
      }
    }

    processingFiles.add(sf.relPath);
    try {
      const editedAt = new Date(nowMs);
      const updatedStr = formatDateTime(editedAt);
      const historicalDisplayDate = formatDisplayDateTime(editedAt);
      const destinations = [sf.relPath];
      let finalContent = content;

      const tempDir = config.tempDir ?? path.join(config.automacaoDir, ".tmp");
      if (ai?.refineExistingNote) {
        const vaultContext = await collectVaultContext(config.vaultRoot, config.indexCacheFile);
        const mutableSummaries = [...vaultContext.summaries];
        const refined = await ai.refineExistingNote({
          relativePath: sf.relPath,
          currentContent: content,
          updatedStr,
          historicalDateStr: historicalDisplayDate,
          vaultContext,
        });
        finalContent = refined.updated_markdown.trimEnd() + "\n";
        await atomicWriteFile(sf.absPath, finalContent, tempDir);
        await persistBotHashForFile(config, sf.relPath, sf.absPath, finalContent);

        if (refined.extracted_operations && refined.extracted_operations.length > 0) {
          const extraOutcome = await applyOperationsWithReadBeforeWrite({
            operations: refined.extracted_operations,
            originalFilename: path.basename(sf.relPath),
            createdAt: editedAt,
            historicalDisplayDate,
            now: editedAt,
            config,
            ai,
            logger,
            summaries: mutableSummaries,
            allowedFolders: vaultContext.folders,
          });
          destinations.push(...extraOutcome.destinations);
        }
      } else {
        finalContent = stampUserEditedNoteFallback(content, editedAt);
        await atomicWriteFile(sf.absPath, finalContent, tempDir);
        await persistBotHashForFile(config, sf.relPath, sf.absPath, finalContent);
      }

      lastObservedActivity.delete(sf.relPath);
      retryState.delete(sf.relPath);
      await logger.info(
        `SUBFOLDER_REORGANIZED: "${sf.relPath}" atualizado (updated + 📅 ${historicalDisplayDate}).`,
      );
      results.push({
        action: "reorganized_edit",
        sourceFile: sf.relPath,
        destinationFiles: destinations,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = (existingRetry?.attempts ?? 0) + 1;
      const backoffMs = computeBackoffMs(attempts, config.debounceMs);
      retryState.set(sf.relPath, {
        attempts,
        nextRetryAtMs: nowMs + backoffMs,
        lastError: message,
        fileMtimeMs: st.mtimeMs,
      });
      await logger.warn(
        `SUBFOLDER_REORG_RETRY (${sf.relPath}): tentativa #${attempts} falhou (${message}). Nova tentativa em ${Math.round(
          backoffMs / 1000,
        )}s.`,
      );
      results.push({
        action: "retry_queued",
        sourceFile: sf.relPath,
        destinationFiles: [],
        reason: message,
      });
    } finally {
      processingFiles.delete(sf.relPath);
    }
  }

  for (const trackedKey of lastObservedActivity.keys()) {
    if (!activeTrackingKeys.has(trackedKey)) {
      lastObservedActivity.delete(trackedKey);
    }
  }
  for (const queuedKey of retryState.keys()) {
    if (!activeTrackingKeys.has(queuedKey)) {
      retryState.delete(queuedKey);
    }
  }

  return results;
}
