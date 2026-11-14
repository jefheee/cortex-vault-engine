/**
 * Retry exponencial contra locks transitorios do Google Drive Desktop / NTFS
 * (`EBUSY`, `EPERM`, `EACCES`, `EAGAIN`, `ENOTEMPTY`), inspirado em `obsidian-livesync`.
 */

const RETRYABLE_FS_CODES = new Set([
  "EBUSY",
  "EPERM",
  "EACCES",
  "EAGAIN",
  "ENOTEMPTY",
  "EMFILE",
  "ENFILE",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTransientFsLockError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" && RETRYABLE_FS_CODES.has(code);
}

/**
 * Executa uma operacao de filesystem com exponential backoff + jitter
 * quando o sincronizador do Google Drive mantem um lock temporario no arquivo.
 */
export async function withFsRetry<T>(
  operation: () => Promise<T>,
  label: string = "fs_op",
  maxAttempts: number = 5,
  baseDelayMs: number = 250,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err: unknown) {
      lastError = err;
      if (!isTransientFsLockError(err) || attempt >= maxAttempts) {
        throw err;
      }
      const jitter = Math.floor(Math.random() * 80);
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1) + jitter;
      await sleep(delayMs);
    }
  }

  throw new Error(`Falha persistente em ${label} apos ${maxAttempts} tentativas: ${String(lastError)}`);
}
