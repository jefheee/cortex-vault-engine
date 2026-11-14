import fs from "node:fs/promises";
import path from "node:path";
import { withFsRetry } from "./fs-retry.js";
import { normalizeNFC } from "./unicode.js";

let tempSeq = 0;

/**
 * Escrita atomica via arquivo temporario em `.automacao/.tmp/` + `rename` com retry (`obsidian-mind`).
 * Garante que Google Drive Desktop e Android DriveSync nunca leiam notas truncadas no meio de um write.
 */
export async function atomicWriteFile(
  targetPath: string,
  content: string,
  tempDir?: string,
): Promise<void> {
  const normalizedTarget = normalizeNFC(targetPath);
  const normalizedContent = normalizeNFC(content.replace(/\r\n/g, "\n"));
  const targetDir = path.dirname(normalizedTarget);
  const stagingDir = tempDir ? normalizeNFC(tempDir) : path.join(targetDir, ".tmp");

  await withFsRetry(() => fs.mkdir(targetDir, { recursive: true }), `mkdir:${targetDir}`);
  await withFsRetry(() => fs.mkdir(stagingDir, { recursive: true }), `mkdir:${stagingDir}`);

  const tempFile = path.join(
    stagingDir,
    `.tmp-${process.pid}-${Date.now()}-${++tempSeq}.md`,
  );

  try {
    await withFsRetry(async () => {
      const handle = await fs.open(tempFile, "w", 0o666);
      try {
        await handle.writeFile(normalizedContent, "utf8");
        await handle.sync().catch(() => undefined);
      } finally {
        await handle.close();
      }
    }, `write_tmp:${path.basename(normalizedTarget)}`);

    await withFsRetry(async () => {
      try {
        await fs.rename(tempFile, normalizedTarget);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EXDEV") {
          const sameFolderTmp = path.join(
            targetDir,
            `.tmp-swap-${process.pid}-${++tempSeq}.tmp`,
          );
          await fs.copyFile(tempFile, sameFolderTmp);
          await fs.rename(sameFolderTmp, normalizedTarget);
          return;
        }
        throw err;
      }
    }, `rename:${normalizedTarget}`);
  } finally {
    await fs.rm(tempFile, { force: true }).catch(() => undefined);
  }
}

/** Le arquivo UTF-8 aplicando retry contra locks do Google Drive e normalizando texto em NFC. */
export async function readFileWithRetry(filePath: string): Promise<string> {
  const raw = await withFsRetry(
    () => fs.readFile(normalizeNFC(filePath), "utf8"),
    `read:${path.basename(filePath)}`,
  );
  return normalizeNFC(raw);
}
