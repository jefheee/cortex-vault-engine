import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTOMACAO_DIR = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(AUTOMACAO_DIR, ".env") });

export const ROOT_FOLDERS = [
  "01_Pessoas",
  "02_Projetos_e_Negocios",
  "03_Faculdade_e_Estudos",
  "04_Padroes_e_Prompts",
  "05_Pessoal_e_Vida",
] as const;

export type RootFolder = (typeof ROOT_FOLDERS)[number];

export type Category =
  | "pessoas"
  | "projetos_negocios"
  | "faculdade_estudos"
  | "padroes_prompts"
  | "pessoal_vida";

export type NoteStatus = "rascunho" | "ativo" | "referencia" | "arquivado";

export const CATEGORY_TO_FOLDER: Record<Category, RootFolder> = {
  pessoas: "01_Pessoas",
  projetos_negocios: "02_Projetos_e_Negocios",
  faculdade_estudos: "03_Faculdade_e_Estudos",
  padroes_prompts: "04_Padroes_e_Prompts",
  pessoal_vida: "05_Pessoal_e_Vida",
};

export const GEMINI_MODEL_PRIMARY_DEFAULT = "gemini-2.5-flash";
export const GEMINI_MODEL_HEAVY_DEFAULT = "gemini-2.5-pro";
export const GEMINI_MODEL_FAST_DEFAULT = "gemini-2.5-flash-lite";
export const HEAVY_INPUT_THRESHOLD_CHARS = 12_000;

export const FALLBACK_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.0-flash",
] as const;

export const DEFAULT_MODEL_FALLBACKS = FALLBACK_MODELS;

export const IGNORED_ROOT_FILES = new Set([
  "gemini.md",
  ".gemini.md",
  "agents.md",
  "readme.md",
  "00_indice_global_moc.md",
  "00_dashboard_principal.md",
  "00_catalogo_geral.base",
  "recentes.base",
]);

export interface AppConfig {
  automacaoDir: string;
  vaultRoot: string;
  logFile: string;
  trashDir: string;
  processedArchiveDir: string;
  checkpointsDir: string;
  tempDir: string;
  ledgerFile: string;
  indexCacheFile: string;
  lockFile: string;
  inboxChatsDir: string;
  profileNoteRelPath: string;
  apiKeys: string[];
  model: string;
  modelPrimary: string;
  modelHeavy: string;
  modelFast: string;
  heavyInputThresholdChars: number;
  modelFallbacks: string[];
  debounceMs: number;
  inboxBrutoDebounceMs: number;
  subFolderDebounceMs: number;
  emptyNoteDebounceMs: number;
  emptyCleanupMs: number;
  pollIntervalMs: number;
  activeScanIntervalMs: number;
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isRealApiKey(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  return !lower.startsWith("cole_sua_chave") && !lower.startsWith("cole_chave");
}

/** Coleta e deduplica chaves de API a partir de GEMINI_API_KEYS, GEMINI_API_KEY_1..10 e GEMINI_API_KEY. */
export function collectApiKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  const rawCandidates: string[] = [];

  if (env.GEMINI_API_KEYS) {
    for (const part of env.GEMINI_API_KEYS.split(",")) {
      rawCandidates.push(part);
    }
  }

  for (let i = 1; i <= 10; i++) {
    const numbered = env[`GEMINI_API_KEY_${i}`];
    if (numbered) {
      rawCandidates.push(numbered);
    }
  }

  if (env.GEMINI_API_KEY) {
    rawCandidates.push(env.GEMINI_API_KEY);
  }

  const seen = new Set<string>();
  const validKeys: string[] = [];
  for (const raw of rawCandidates) {
    const trimmed = raw.trim();
    if (isRealApiKey(trimmed) && !seen.has(trimmed)) {
      seen.add(trimmed);
      validKeys.push(trimmed);
    }
  }
  return validKeys;
}

/** Constroi lista deduplicada de modelos para fallback automatico a partir do modelo principal. */
export function collectModelFallbacks(
  primaryModel: string,
  rawFallbacks?: string,
): string[] {
  const candidates: string[] = [primaryModel];
  if (rawFallbacks) {
    for (const item of rawFallbacks.split(",")) {
      candidates.push(item);
    }
  }
  for (const fallback of FALLBACK_MODELS) {
    candidates.push(fallback);
  }

  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of candidates) {
    const trimmed = item.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      models.push(trimmed);
    }
  }
  return models;
}

export type ModelTier = "primary" | "heavy" | "fast";

/** Constroi a cadeia ordenada de modelos para o nivel de roteamento solicitado. */
export function buildTieredModelChain(params: {
  tier: ModelTier;
  modelPrimary?: string;
  modelHeavy?: string;
  modelFast?: string;
  modelFallbacks?: readonly string[];
}): string[] {
  const primary = params.modelPrimary?.trim() || GEMINI_MODEL_PRIMARY_DEFAULT;
  const heavy = params.modelHeavy?.trim() || GEMINI_MODEL_HEAVY_DEFAULT;
  const fast = params.modelFast?.trim() || GEMINI_MODEL_FAST_DEFAULT;
  const baseFallbacks =
    params.modelFallbacks && params.modelFallbacks.length > 0
      ? params.modelFallbacks
      : FALLBACK_MODELS;

  const priorityHead =
    params.tier === "heavy"
      ? [heavy, primary, fast]
      : params.tier === "fast"
        ? [fast, primary]
        : [primary, fast];

  const seen = new Set<string>();
  const chain: string[] = [];
  for (const m of [...priorityHead, ...baseFallbacks]) {
    const trimmed = m.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      chain.push(trimmed);
    }
  }
  return chain;
}

export function loadConfig(): AppConfig {
  const vaultRoot = process.env.VAULT_ROOT?.trim()
    ? path.resolve(process.env.VAULT_ROOT.trim())
    : path.resolve(AUTOMACAO_DIR, "..");

  const debounceSeconds = parsePositiveNumber(process.env.DEBOUNCE_SECONDS, 45);
  const inboxBrutoDebounceSeconds = parsePositiveNumber(
    process.env.INBOX_BRUTO_DEBOUNCE_SECONDS,
    5,
  );
  const activeScanIntervalSeconds = parsePositiveNumber(
    process.env.ACTIVE_SCAN_INTERVAL_SECONDS,
    30,
  );
  const emptyCleanupMinutes = parsePositiveNumber(
    process.env.EMPTY_CLEANUP_MINUTES,
    15,
  );

  const modelPrimary =
    process.env.GEMINI_MODEL_PRIMARY?.trim() ||
    process.env.GEMINI_MODEL?.trim() ||
    GEMINI_MODEL_PRIMARY_DEFAULT;
  const modelHeavy =
    process.env.GEMINI_MODEL_HEAVY?.trim() || GEMINI_MODEL_HEAVY_DEFAULT;
  const modelFast =
    process.env.GEMINI_MODEL_FAST?.trim() || GEMINI_MODEL_FAST_DEFAULT;
  const heavyInputThresholdChars = parsePositiveNumber(
    process.env.HEAVY_INPUT_THRESHOLD_CHARS,
    HEAVY_INPUT_THRESHOLD_CHARS,
  );

  const modelFallbacks = collectModelFallbacks(
    modelPrimary,
    process.env.GEMINI_MODEL_FALLBACKS,
  );

  return {
    automacaoDir: AUTOMACAO_DIR,
    vaultRoot,
    logFile: path.join(AUTOMACAO_DIR, "organizer.log"),
    trashDir: path.join(AUTOMACAO_DIR, "trash"),
    processedArchiveDir: path.join(AUTOMACAO_DIR, "processed_archive"),
    checkpointsDir: path.join(AUTOMACAO_DIR, "checkpoints"),
    tempDir: path.join(AUTOMACAO_DIR, ".tmp"),
    ledgerFile: path.join(AUTOMACAO_DIR, "ledger.jsonl"),
    indexCacheFile: path.join(AUTOMACAO_DIR, "vault-index.json"),
    lockFile: path.join(AUTOMACAO_DIR, "watcher.lock"),
    inboxChatsDir: path.join(AUTOMACAO_DIR, "inbox_chats"),
    profileNoteRelPath: "05_Pessoal_e_Vida/00_Perfil_Mestre_Jefherson.md",
    apiKeys: collectApiKeys(process.env),
    model: modelPrimary,
    modelPrimary,
    modelHeavy,
    modelFast,
    heavyInputThresholdChars,
    modelFallbacks,
    debounceMs: debounceSeconds * 1000,
    inboxBrutoDebounceMs: inboxBrutoDebounceSeconds * 1000,
    subFolderDebounceMs: 90_000,
    emptyNoteDebounceMs: 60_000,
    emptyCleanupMs: emptyCleanupMinutes * 60 * 1000,
    pollIntervalMs: 5_000,
    activeScanIntervalMs: activeScanIntervalSeconds * 1000,
  };
}
