import fs from "node:fs/promises";
import path from "node:path";

export interface LockData {
  pid: number;
  startedAt: string;
}

export type LockAcquireResult =
  | { acquired: true }
  | { acquired: false; existingPid: number };

/** Verifica se um PID esta ativo no sistema operacional. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // EPERM indica que o processo existe, embora sem permissao de sinal
    return code === "EPERM";
  }
}

/**
 * Adquire lockfile exclusivo de instancia unica usando PID check.
 * Recupera automaticamente locks orfaos de processos encerrados abruptamente.
 */
export async function acquireLock(
  lockFilePath: string,
  pidChecker: (pid: number) => boolean = isPidAlive,
): Promise<LockAcquireResult> {
  await fs.mkdir(path.dirname(lockFilePath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const payload: LockData = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };
      await fs.writeFile(lockFilePath, JSON.stringify(payload, null, 2), {
        encoding: "utf8",
        flag: "wx",
      });
      return { acquired: true };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") {
        throw err;
      }

      try {
        const raw = await fs.readFile(lockFilePath, "utf8");
        const parsed = JSON.parse(raw) as Partial<LockData>;
        if (typeof parsed.pid === "number" && parsed.pid !== process.pid && pidChecker(parsed.pid)) {
          return { acquired: false, existingPid: parsed.pid };
        }
      } catch {
        // Lockfile corrompido ou ilegivel: trata como stale
      }

      await fs.rm(lockFilePath, { force: true });
    }
  }

  return { acquired: false, existingPid: -1 };
}

/** Libera o lockfile apenas se pertencer ao processo atual. */
export async function releaseLock(lockFilePath: string): Promise<void> {
  try {
    const raw = await fs.readFile(lockFilePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockData>;
    if (parsed.pid === process.pid) {
      await fs.rm(lockFilePath, { force: true });
    }
  } catch {
    // Ignora se ja removido
  }
}
