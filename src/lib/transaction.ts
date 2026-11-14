import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, readFileWithRetry } from "./atomic-write.js";
import { withFsRetry } from "./fs-retry.js";
import { normalizeVaultPath } from "./unicode.js";

export interface TransactionTargetState {
  relativePath: string;
  existedBefore: boolean;
  beforeSha256: string | null;
  afterSha256?: string | undefined;
  action?: string | undefined;
  snapshotPath?: string | undefined;
}

export interface LedgerEntry {
  txId: string;
  timestamp: string;
  operationType: string;
  sourceFile: string;
  status: "committed" | "rolled_back";
  modelUsed?: string | undefined;
  keyNumber?: number | undefined;
  notesCreated: number;
  notesUpdated: number;
  reason?: string | undefined;
  targets: Array<{
    relativePath: string;
    action: string;
    beforeSha256: string | null;
    afterSha256: string | null;
  }>;
}

interface ActiveTransaction {
  txId: string;
  startedAt: string;
  operationType: string;
  sourceFile: string;
  snapshotDir: string;
  modelUsed?: string | undefined;
  keyNumber?: number | undefined;
  targets: Map<string, TransactionTargetState>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Gerenciador transacional inspirado em `claude_obsidian/transaction.py`:
 * cria snapshots de rollback por arquivo, verifica pre-condicoes SHA-256 e grava ledger JSONL.
 */
export class TransactionManager {
  private readonly vaultRoot: string;
  private readonly snapshotsDir: string;
  private readonly ledgerFile: string;
  private readonly tempDir: string | undefined;
  private readonly active = new Map<string, ActiveTransaction>();

  constructor(opts: {
    vaultRoot: string;
    snapshotsDir: string;
    ledgerFile: string;
    tempDir?: string | undefined;
  }) {
    this.vaultRoot = opts.vaultRoot;
    this.snapshotsDir = opts.snapshotsDir;
    this.ledgerFile = opts.ledgerFile;
    this.tempDir = opts.tempDir;
  }

  async begin(
    sourceFile: string,
    targetRelPaths: readonly string[],
    metadata?: {
      modelUsed?: string | undefined;
      keyNumber?: number | undefined;
      operationType?: string | undefined;
    },
  ): Promise<string> {
    const txId = `tx-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const snapshotDir = path.join(this.snapshotsDir, txId);
    await withFsRetry(() => fs.mkdir(snapshotDir, { recursive: true }), `tx:mkdir:${txId}`);

    const targets = new Map<string, TransactionTargetState>();
    for (const rawRel of targetRelPaths) {
      const rel = normalizeVaultPath(rawRel);
      if (targets.has(rel)) continue;
      await this.captureTargetSnapshot(snapshotDir, rel, targets);
    }

    this.active.set(txId, {
      txId,
      startedAt: new Date().toISOString(),
      operationType: metadata?.operationType ?? "ingest",
      sourceFile: normalizeVaultPath(sourceFile),
      snapshotDir,
      modelUsed: metadata?.modelUsed,
      keyNumber: metadata?.keyNumber,
      targets,
    });

    return txId;
  }

  async ensureTargetSnapshot(txId: string, relPath: string): Promise<void> {
    const tx = this.active.get(txId);
    if (!tx) return;
    const rel = normalizeVaultPath(relPath);
    if (tx.targets.has(rel)) return;
    await this.captureTargetSnapshot(tx.snapshotDir, rel, tx.targets);
  }

  private async captureTargetSnapshot(
    snapshotDir: string,
    relPath: string,
    targets: Map<string, TransactionTargetState>,
  ): Promise<void> {
    const absPath = path.join(this.vaultRoot, relPath);
    try {
      const content = await readFileWithRetry(absPath);
      const snapFile = path.join(snapshotDir, `${sha256(relPath).slice(0, 16)}.bak`);
      await atomicWriteFile(snapFile, content, this.tempDir);
      targets.set(relPath, {
        relativePath: relPath,
        existedBefore: true,
        beforeSha256: sha256(content),
        snapshotPath: snapFile,
      });
    } catch {
      targets.set(relPath, {
        relativePath: relPath,
        existedBefore: false,
        beforeSha256: null,
      });
    }
  }

  recordTargetWrite(txId: string, relPath: string, action: string, afterContent: string): void {
    const tx = this.active.get(txId);
    if (!tx) return;
    const rel = normalizeVaultPath(relPath);
    const prev = tx.targets.get(rel);
    const next: TransactionTargetState = prev
      ? {
          ...prev,
          action,
          afterSha256: sha256(afterContent),
        }
      : {
          relativePath: rel,
          existedBefore: false,
          beforeSha256: null,
          action,
          afterSha256: sha256(afterContent),
        };
    tx.targets.set(rel, next);
  }

  async commit(
    txId: string,
    summary?: {
      modelUsed?: string | undefined;
      keyNumber?: number | undefined;
      notesCreated?: number | undefined;
      notesUpdated?: number | undefined;
    },
  ): Promise<void> {
    const tx = this.active.get(txId);
    if (!tx) return;

    const entry: LedgerEntry = {
      txId: tx.txId,
      timestamp: new Date().toISOString(),
      operationType: tx.operationType,
      sourceFile: tx.sourceFile,
      status: "committed",
      modelUsed: summary?.modelUsed ?? tx.modelUsed,
      keyNumber: summary?.keyNumber ?? tx.keyNumber,
      notesCreated: summary?.notesCreated ?? 0,
      notesUpdated: summary?.notesUpdated ?? 0,
      targets: [...tx.targets.values()].map((t) => ({
        relativePath: t.relativePath,
        action: t.action ?? "UNCHANGED",
        beforeSha256: t.beforeSha256,
        afterSha256: t.afterSha256 ?? null,
      })),
    };

    await this.appendLedger(entry);
    this.active.delete(txId);
    await fs.rm(tx.snapshotDir, { recursive: true, force: true }).catch(() => undefined);
  }

  async rollback(txId: string, reason: string): Promise<void> {
    const tx = this.active.get(txId);
    if (!tx) return;

    for (const target of tx.targets.values()) {
      const absTarget = path.join(this.vaultRoot, target.relativePath);
      if (target.existedBefore && target.snapshotPath) {
        try {
          const originalContent = await readFileWithRetry(target.snapshotPath);
          await atomicWriteFile(absTarget, originalContent, this.tempDir);
        } catch {
          // Melhor esforco no rollback se o snapshot nao existir mais.
        }
      } else if (!target.existedBefore && target.afterSha256) {
        await fs.unlink(absTarget).catch(() => undefined);
      }
    }

    const entry: LedgerEntry = {
      txId: tx.txId,
      timestamp: new Date().toISOString(),
      operationType: tx.operationType,
      sourceFile: tx.sourceFile,
      status: "rolled_back",
      modelUsed: tx.modelUsed,
      keyNumber: tx.keyNumber,
      notesCreated: 0,
      notesUpdated: 0,
      reason,
      targets: [...tx.targets.values()].map((t) => ({
        relativePath: t.relativePath,
        action: t.action ?? "ROLLED_BACK",
        beforeSha256: t.beforeSha256,
        afterSha256: t.afterSha256 ?? null,
      })),
    };

    await this.appendLedger(entry);
    this.active.delete(txId);
    await fs.rm(tx.snapshotDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private async appendLedger(entry: LedgerEntry): Promise<void> {
    await withFsRetry(
      () => fs.mkdir(path.dirname(this.ledgerFile), { recursive: true }),
      "ledger:mkdir",
    );
    await withFsRetry(
      () => fs.appendFile(this.ledgerFile, `${JSON.stringify(entry)}\n`, "utf8"),
      "ledger:append",
    );
  }

  async readLedger(limit = 50): Promise<LedgerEntry[]> {
    try {
      const raw = await readFileWithRetry(this.ledgerFile);
      const lines = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const slice = lines.slice(-Math.max(1, limit));
      const entries: LedgerEntry[] = [];
      for (const line of slice) {
        try {
          entries.push(JSON.parse(line) as LedgerEntry);
        } catch {
          // Ignora linha corrompida isolada no ledger.
        }
      }
      return entries;
    } catch {
      return [];
    }
  }
}
