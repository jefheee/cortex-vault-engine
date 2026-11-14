import fsp from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import { ROOT_FOLDERS, loadConfig } from "./config.js";
import { createGeminiOrganizer, type NoteOrganizerAI } from "./gemini.js";
import { runActiveHygieneAndLint } from "./lib/lint-engine.js";
import { SerialPromiseQueue } from "./lib/promiseQueue.js";
import { normalizeNFC } from "./lib/unicode.js";
import { acquireLock, releaseLock } from "./lock.js";
import { createLogger } from "./logger.js";
import { scanVaultRoot, type RetryEntry } from "./organizer.js";
import { recordBotWriteHash, shouldIgnoreRootFile, shouldIgnoreSubfolderFile } from "./vault.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logFile);

  const lockResult = await acquireLock(config.lockFile);
  if (!lockResult.acquired) {
    await logger.warn(
      `Instancia duplicada detectada (PID ativo: ${lockResult.existingPid}). Encerrando processo atual.`,
    );
    process.exit(0);
  }

  const rawInboxDir = path.join(config.vaultRoot, "00_Inbox_Bruto");
  await fsp.mkdir(config.inboxChatsDir, { recursive: true });
  await fsp.mkdir(config.processedArchiveDir, { recursive: true });
  await fsp.mkdir(config.trashDir, { recursive: true });
  await fsp.mkdir(config.checkpointsDir, { recursive: true });
  await fsp.mkdir(config.tempDir, { recursive: true });
  await fsp.mkdir(rawInboxDir, { recursive: true });
  for (const folder of ROOT_FOLDERS) {
    await fsp.mkdir(path.join(config.vaultRoot, folder), { recursive: true });
  }

  let ai: NoteOrganizerAI | null = null;
  if (config.apiKeys.length > 0) {
    ai = createGeminiOrganizer({
      apiKeys: config.apiKeys,
      modelPrimary: config.modelPrimary,
      modelHeavy: config.modelHeavy,
      modelFast: config.modelFast,
      heavyInputThresholdChars: config.heavyInputThresholdChars,
      modelFallbacks: config.modelFallbacks,
      checkpointsDir: config.checkpointsDir,
      tempDir: config.tempDir,
      logger,
    });
  } else {
    await logger.warn(
      "Nenhuma chave Gemini valida encontrada em .automacao/.env. " +
        "A faxina de notas vazias esta ativa, mas a organizacao via Gemini aguardara uma chave valida.",
    );
  }

  await logger.info(
    `Daemon V6.0 (Cortex Vault Engine) iniciado (PID ${process.pid}) | Cofre: ${config.vaultRoot} | ` +
      `Polling Chokidar (${config.pollIntervalMs}ms) + Active Scan (${config.activeScanIntervalMs / 1000}s) | ` +
      `Tiered Routing: heavy=${config.modelHeavy}, primary=${config.modelPrimary}, fast=${config.modelFast} | ` +
      `Fallbacks: ${config.modelFallbacks.join(" -> ")} | ` +
      `Chaves no Pool: ${config.apiKeys.length} | Debounce Raiz: ${config.debounceMs / 1000}s | ` +
      `Debounce 00_Inbox_Bruto: ${config.inboxBrutoDebounceMs / 1000}s | Debounce Subpastas: ${config.subFolderDebounceMs / 1000}s`,
  );

  // Gera/atualiza MOC global e Dashboard antes da primeira varredura para garantir zero orfas
  try {
    const initialLint = await runActiveHygieneAndLint({
      vaultRoot: config.vaultRoot,
      rootFolders: ROOT_FOLDERS,
      tempDir: config.tempDir,
      recordBotWrite: (absPath, content) => {
        const rel = normalizeNFC(path.relative(config.vaultRoot, absPath).replace(/\\/g, "/"));
        void recordBotWriteHash({
          indexCachePath: config.indexCacheFile,
          relPath: rel,
          content,
        }).catch(() => undefined);
      },
    });
    await logger.info(
      `HYGIENE_STARTUP: ${initialLint.totalNotes} notas indexadas | Links reparados: ${initialLint.fixedBrokenLinks} | ` +
        `Orfas antes MOC: ${initialLint.orphanNotes.length} | Oversized: ${initialLint.oversizedNotes.length}`,
    );
  } catch (err: unknown) {
    await logger.warn(
      `HYGIENE_STARTUP_WARN: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const processingFiles = new Set<string>();
  const lastObservedActivity = new Map<string, number>();
  const retryState = new Map<string, RetryEntry>();
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  const sweepQueue = new SerialPromiseQueue(1_500);

  const runSweep = async (source: string): Promise<void> => {
    try {
      await scanVaultRoot({
        config,
        ai,
        logger,
        processingFiles,
        lastObservedActivity,
        retryState,
      });
    } catch (err: unknown) {
      await logger.error(
        `SWEEP_ERROR (${source}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const enqueueSweep = (source: string): void => {
    void sweepQueue.enqueue(() => runSweep(source), { key: "vault-sweep" });
  };

  const scheduleFileDebounce = (
    trackingPrefix: string,
    filename: string,
    delayMs: number,
    isSubfolder: boolean,
  ): void => {
    const normName = normalizeNFC(filename).replace(/\\/g, "/");
    const trackingKey = `${trackingPrefix}${normName}`;
    if (isSubfolder ? shouldIgnoreSubfolderFile(trackingKey) : shouldIgnoreRootFile(normName)) {
      return;
    }
    lastObservedActivity.set(trackingKey, Date.now());

    const existing = debounceTimers.get(trackingKey);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      debounceTimers.delete(trackingKey);
      enqueueSweep(`debounce:${trackingKey}`);
    }, delayMs + 500);
    debounceTimers.set(trackingKey, timer);
  };

  const watchTargets = [
    config.vaultRoot,
    rawInboxDir,
    config.inboxChatsDir,
    ...ROOT_FOLDERS.map((folder) => path.join(config.vaultRoot, folder)),
  ];

  const normInboxChatsDir = path.resolve(config.inboxChatsDir).toLowerCase();
  const normRawInboxDir = path.resolve(rawInboxDir).toLowerCase();
  const normVaultRoot = path.resolve(config.vaultRoot).toLowerCase();
  const normRootFolders = ROOT_FOLDERS.map((folder) => ({
    folder,
    absLower: path.resolve(config.vaultRoot, folder).toLowerCase(),
  }));

  const routeWatchedPath = (absFilePath: string): void => {
    const resolved = path.resolve(absFilePath);
    const lower = resolved.toLowerCase();

    if (lower.startsWith(normRawInboxDir + path.sep)) {
      const rel = resolved.slice(normRawInboxDir.length + 1);
      if (!rel.includes(path.sep)) {
        scheduleFileDebounce("00_Inbox_Bruto/", rel, config.inboxBrutoDebounceMs, false);
      }
      return;
    }

    if (lower.startsWith(normInboxChatsDir + path.sep)) {
      const rel = resolved.slice(normInboxChatsDir.length + 1);
      if (!rel.includes(path.sep)) {
        scheduleFileDebounce("inbox_chats/", rel, config.debounceMs, false);
      }
      return;
    }

    for (const rootEntry of normRootFolders) {
      if (lower.startsWith(rootEntry.absLower + path.sep)) {
        const rel = resolved.slice(rootEntry.absLower.length + 1);
        scheduleFileDebounce(`${rootEntry.folder}/`, rel, config.subFolderDebounceMs, true);
        return;
      }
    }

    if (path.dirname(lower) === normVaultRoot) {
      scheduleFileDebounce("", path.basename(resolved), config.debounceMs, false);
    }
  };

  const watcher = chokidar.watch(watchTargets, {
    usePolling: true,
    interval: config.pollIntervalMs,
    binaryInterval: config.pollIntervalMs,
    awaitWriteFinish: {
      stabilityThreshold: 3_000,
      pollInterval: 500,
    },
    ignoreInitial: false,
    depth: 3,
    ignored: (watchPath: string) => {
      const norm = watchPath.replace(/\\/g, "/");
      if (
        norm.includes("/.obsidian") ||
        norm.includes("/.git") ||
        norm.includes("/.gemini") ||
        norm.includes("/node_modules")
      ) {
        return true;
      }
      if (
        norm.includes("/.automacao/") &&
        !norm.includes("/.automacao/inbox_chats")
      ) {
        return true;
      }
      return false;
    },
  });

  watcher.on("add", (filePath: string) => {
    routeWatchedPath(filePath);
  });
  watcher.on("change", (filePath: string) => {
    routeWatchedPath(filePath);
  });
  watcher.on("error", (err: unknown) => {
    void logger.error(`CHOKIDAR_WATCH_ERROR: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Loop ativo de seguranca com fs.readdir (garante zero perda mesmo se Google Drive silenciar eventos)
  const activeScanTimer = setInterval(() => {
    enqueueSweep("active-interval-scan");
  }, config.activeScanIntervalMs);

  // Varredura imediata no startup
  enqueueSweep("startup");

  const shutdown = async (signal: string): Promise<void> => {
    await logger.info(`Encerrando daemon (${signal})...`);
    clearInterval(activeScanTimer);
    for (const timer of debounceTimers.values()) {
      clearTimeout(timer);
    }
    await watcher.close().catch(() => undefined);
    await releaseLock(config.lockFile);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
