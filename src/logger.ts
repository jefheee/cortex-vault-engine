import fs from "node:fs/promises";
import path from "node:path";

export type LogLevel = "INFO" | "WARN" | "ERROR";

export interface Logger {
  info(message: string): Promise<void>;
  warn(message: string): Promise<void>;
  error(message: string): Promise<void>;
}

/** Formata data/hora local para registros legiveis em organizer.log. */
export function formatLogTimestamp(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** Cria um logger que grava simultaneamente no arquivo de log e no console. */
export function createLogger(logFilePath: string): Logger {
  let writeQueue: Promise<void> = Promise.resolve();

  const write = (level: LogLevel, message: string): Promise<void> => {
    const line = `[${formatLogTimestamp()}] [${level}] ${message}`;
    if (level === "ERROR") {
      console.error(line);
    } else if (level === "WARN") {
      console.warn(line);
    } else {
      console.log(line);
    }

    writeQueue = writeQueue
      .then(async () => {
        await fs.mkdir(path.dirname(logFilePath), { recursive: true });
        await fs.appendFile(logFilePath, `${line}\n`, "utf8");
      })
      .catch((err: unknown) => {
        console.error(`[LOGGER_FAIL] ${String(err)}`);
      });

    return writeQueue;
  };

  return {
    info: (message: string) => write("INFO", message),
    warn: (message: string) => write("WARN", message),
    error: (message: string) => write("ERROR", message),
  };
}
