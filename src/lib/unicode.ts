/**
 * Normalizacao Unicode NFC para compatibilidade cruzada entre Windows NTFS,
 * Google Drive for Desktop e Android DriveSync (`obsidian-livesync`).
 */

/** Normaliza qualquer string para Unicode Canonical Composition (NFC). */
export function normalizeNFC(input: string): string {
  return input.normalize("NFC");
}

/** Normaliza caminho relativo de cofre: barras POSIX, sem barras nas pontas, em NFC. */
export function normalizeVaultPath(relPath: string): string {
  return relPath
    .normalize("NFC")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((segment) => segment.normalize("NFC"))
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
}

/** Normaliza o alvo de um wikilink `[[Target]]` para NFC. */
export function normalizeWikilinkTarget(target: string): string {
  return target.normalize("NFC").replace(/\\/g, "/").trim();
}

/** Chave canonica case-insensitive em NFC para deduplicacao de caminhos e titulos. */
export function portableIdentityKey(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}
