import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type AppConfig } from "./config.js";
import { createGeminiOrganizer } from "./gemini.js";
import { createLogger, type Logger } from "./logger.js";
import { processInboxMarkdownFile } from "./organizer.js";

export interface RawStickyNote {
  id: string;
  text: string;
  createdAtTicks?: string | number | null;
  updatedAtTicks?: string | number | null;
}

export interface StickyImportState {
  version: 1;
  hashes: Record<string, string>;
}

const DEFAULT_STICKY_DB_REL = path.join(
  "Packages",
  "Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe",
  "LocalState",
  "plum.sqlite",
);

export function getDefaultStickyNotesDbPath(): string {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, DEFAULT_STICKY_DB_REL);
}

/** Converte ticks .NET (100ns desde 0001-01-01) usados pelo Sticky Notes em Date UTC. */
export function dotNetTicksToDate(ticks: string | number | null | undefined): Date | null {
  if (ticks === null || ticks === undefined) {
    return null;
  }
  try {
    const big = BigInt(String(ticks).trim());
    if (big <= 0n) {
      return null;
    }
    const epochOffset = 621355968000000000n;
    const ms = Number((big - epochOffset) / 10000n);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/** Remove marcadores RTF/UUID internos (`\\id=...`, `\\b`, `\\strike`, etc.) preservando texto e URLs. */
export function cleanStickyNoteText(rawText: string): string {
  const lines = rawText.replace(/\r\n/g, "\n").split("\n");
  const cleanedLines = lines.map((line) => {
    let s = line.replace(/^\\id=[0-9a-f-]+\s*/i, "");
    s = s.replace(/\\bullet\s*/gi, "- ");
    s = s.replace(/\\strike\s+(.*?)\\strike0\s*/gi, "~~$1~~ ");
    s = s.replace(/\\b\s+(.*?)\\b0\s*/gi, "**$1** ");
    s = s.replace(/\\i\s+(.*?)\\i0\s*/gi, "*$1* ");
    s = s.replace(/\\(?:b0|b|i0|i|strike0|strike|ul0|ul)\b\s*/gi, "");
    return s.trimEnd();
  });

  return cleanedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Extrai notas ativas de `plum.sqlite` via copia temporaria segura + Python `sqlite3`. */
export async function readStickyNotesFromDb(dbPath: string): Promise<RawStickyNote[]> {
  await fs.access(dbPath);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-sticky-"));
  try {
    const tmpDb = path.join(tmpDir, "plum.sqlite");
    await fs.copyFile(dbPath, tmpDb);
    for (const suffix of ["-wal", "-shm"]) {
      await fs.copyFile(`${dbPath}${suffix}`, `${tmpDb}${suffix}`).catch(() => undefined);
    }

    const pyScript = [
      "import json, sqlite3, sys",
      "conn = sqlite3.connect(sys.argv[1])",
      "try:",
      "    cur = conn.cursor()",
      "    rows = cur.execute('SELECT Id, Text, CreatedAt, UpdatedAt FROM Note WHERE DeletedAt IS NULL AND Text IS NOT NULL ORDER BY UpdatedAt DESC').fetchall()",
      "    out = [{'id': r[0], 'text': r[1], 'createdAtTicks': str(r[2]) if r[2] is not None else None, 'updatedAtTicks': str(r[3]) if r[3] is not None else None} for r in rows]",
      "    print(json.dumps(out, ensure_ascii=False))",
      "finally:",
      "    conn.close()",
    ].join("\n");

    const stdout = execFileSync("python", ["-c", pyScript, tmpDb], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as RawStickyNote[];
    return Array.isArray(parsed) ? parsed : [];
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function loadStickyImportState(statePath: string): Promise<StickyImportState> {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StickyImportState>;
    if (parsed.version === 1 && parsed.hashes && typeof parsed.hashes === "object") {
      return { version: 1, hashes: { ...parsed.hashes } };
    }
  } catch {
    // Novo estado
  }
  return { version: 1, hashes: {} };
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export async function runStickyNotesImporter(options?: {
  config?: AppConfig;
  logger?: Logger;
  dbPath?: string;
  organizeImmediately?: boolean;
}): Promise<{ exportedCount: number; outputPath: string | null; organized: boolean }> {
  const config = options?.config ?? loadConfig();
  const logger = options?.logger ?? createLogger(config.logFile);
  const dbPath = options?.dbPath ?? getDefaultStickyNotesDbPath();
  const organizeImmediately = options?.organizeImmediately ?? true;
  const statePath = path.join(config.automacaoDir, "sticky-imported.json");

  const rawNotes = await readStickyNotesFromDb(dbPath);
  const state = await loadStickyImportState(statePath);

  const sections: string[] = [];
  const nextHashes = { ...state.hashes };

  for (const note of rawNotes) {
    const cleaned = cleanStickyNoteText(note.text);
    if (!cleaned) {
      continue;
    }
    const contentHash = sha256(cleaned);
    if (state.hashes[note.id] === contentHash) {
      continue;
    }
    nextHashes[note.id] = contentHash;
    const updated = dotNetTicksToDate(note.updatedAtTicks);
    const dateLabel = updated ? updated.toISOString().slice(0, 10) : "sem-data";
    sections.push(`## Nota Sticky (${dateLabel} · ID ${note.id.slice(0, 8)})\n\n${cleaned}`);
  }

  if (sections.length === 0) {
    await logger.info("STICKY_IMPORT: Nenhuma nota nova ou modificada em plum.sqlite.");
    return { exportedCount: 0, outputPath: null, organized: false };
  }

  const outputFilename = "Importacao_Sticky_Notes.md";
  const outputPath = path.join(config.vaultRoot, outputFilename);
  const markdown = [
    `# Importação Automática — Windows Sticky Notes`,
    "",
    `> Gerado automaticamente a partir de \`plum.sqlite\` (${sections.length} nota(s) pendente(s)).`,
    "",
    sections.join("\n\n---\n\n"),
    "",
  ].join("\n");

  await fs.writeFile(outputPath, markdown, "utf8");
  await fs.writeFile(
    statePath,
    JSON.stringify({ version: 1, hashes: nextHashes }, null, 2),
    "utf8",
  );
  await logger.info(
    `STICKY_IMPORT: ${sections.length} nota(s) exportada(s) para "${outputFilename}".`,
  );

  let organized = false;
  if (organizeImmediately && config.apiKeys.length > 0) {
    const ai = createGeminiOrganizer({
      apiKeys: config.apiKeys,
      model: config.model,
      modelFallbacks: config.modelFallbacks,
      logger,
    });
    const res = await processInboxMarkdownFile({
      filename: outputFilename,
      sourceDir: config.vaultRoot,
      isChatDump: false,
      config,
      ai,
      logger,
    });
    organized =
      res.action === "organized" ||
      res.action === "appended" ||
      res.action === "multi_processed" ||
      res.action === "skipped_duplicate";
  }

  return { exportedCount: sections.length, outputPath, organized };
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  const exportOnly = process.argv.includes("--export-only");
  runStickyNotesImporter({ organizeImmediately: !exportOnly }).catch((err: unknown) => {
    console.error("Erro ao importar Sticky Notes:", err);
    process.exitCode = 1;
  });
}
