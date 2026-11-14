import { normalizeNFC } from "./unicode.js";

/**
 * Deteccao lexica de notas similares/duplicadas para evitar proliferacao de arquivos
 * com o mesmo assunto antes de um `CREATE_NEW` (`obsidian-mind/memory-similarity.ts`).
 */
export interface ComparableNote {
  readonly title: string;
  readonly body: string;
  readonly folder?: string | undefined;
  readonly category?: string | undefined;
  readonly aliases?: readonly string[] | undefined;
  readonly tags?: readonly string[] | undefined;
}

export interface SimilarNoteHit<T> {
  readonly entry: T;
  readonly score: number;
}

const STOP = new Set([
  // English
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "when", "while", "for", "to", "of",
  "in", "on", "at", "by", "from", "with", "is", "are", "was", "were", "be", "been", "being", "it",
  "its", "this", "that", "these", "those", "as", "so", "not", "no", "do", "does", "did", "can",
  "could", "will", "would", "should", "may", "might", "must", "have", "has", "had", "you", "your",
  "we", "our", "they", "their", "just", "also", "only", "more", "most", "some",
  // Portuguese
  "o", "a", "os", "as", "um", "uma", "uns", "umas", "de", "do", "da", "dos", "das", "em", "no",
  "na", "nos", "nas", "por", "para", "pra", "com", "sem", "sob", "sobre", "entre", "ate", "e", "ou",
  "mas", "se", "que", "como", "quando", "onde", "porque", "pois", "entao", "ja", "nao", "sim", "ser",
  "estar", "ter", "haver", "foi", "sao", "era", "esta", "estao", "isso", "isto", "aquilo", "esse",
  "essa", "este", "esta", "muito", "mais", "menos", "bem", "mal", "nota", "resumo", "chat", "geral",
  "projeto", "sistema", "plano", "planejamento", "guia", "analise",
]);

function stripDiacritics(value: string): string {
  return normalizeNFC(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Plural folding leve (PT/EN) mantendo siglas e identificadores tecnicos intactos.
 */
export function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && /(?:s|x|z|ch|sh)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("oes")) return `${token.slice(0, -3)}ao`;
  if (token.length > 4 && token.endsWith("aes")) return `${token.slice(0, -3)}ao`;
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    const candidate = token.slice(0, -1);
    if (/[aeiou]/.test(candidate)) return candidate;
  }
  return token;
}

/**
 * Normaliza texto para conjunto de tokens comparaveis preservando numeros e `_`.
 */
export function tokenize(text: unknown): string[] {
  return stripDiacritics(String(text ?? ""))
    .toLowerCase()
    .replace(/[`*~>#[\]()]/g, " ")
    .replace(/[^a-z0-9._/-]+/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[._/-]+|[._/-]+$/g, ""))
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

export function jaccard(aTokens: readonly string[], bTokens: readonly string[]): number {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) {
    if (b.has(t)) shared++;
  }
  return shared / (a.size + b.size - shared);
}

/** Similaridade ponderada entre titulo/aliases (55%) e corpo/tags (45%). */
export function similarity(a: ComparableNote, b: ComparableNote): number {
  const aTitleText = [a.title, ...(a.aliases ?? [])].join(" ");
  const bTitleText = [b.title, ...(b.aliases ?? [])].join(" ");
  const titleScore = jaccard(tokenize(aTitleText), tokenize(bTitleText));

  const aBodyText = [a.body, ...(a.tags ?? [])].join(" ");
  const bBodyText = [b.body, ...(b.tags ?? [])].join(" ");
  const bodyScore = jaccard(tokenize(aBodyText), tokenize(bBodyText));

  return 0.55 * titleScore + 0.45 * bodyScore;
}

export const DUPLICATE_NOTE_THRESHOLD = 0.62;

/**
 * Procura nota existente equivalente no cofre para mesclar/fazer Wiki-Fold em vez de duplicar.
 */
export function findSimilarExistingNote<
  T extends {
    relativePath: string;
    title: string;
    folder?: string | undefined;
    category?: string | undefined;
    aliases?: readonly string[] | undefined;
    tags?: readonly string[] | undefined;
    headings?: readonly string[] | undefined;
  },
>(
  candidate: {
    title: string;
    category?: string | undefined;
    folder?: string | undefined;
    tags?: readonly string[] | undefined;
    content?: string | undefined;
  },
  existing: readonly T[],
  threshold = DUPLICATE_NOTE_THRESHOLD,
): SimilarNoteHit<T> | undefined {
  const candidateTitleTokens = tokenize(candidate.title);
  const candidateNormTitle = stripDiacritics(normalizeNFC(candidate.title)).toLowerCase().trim();
  const candidateBody = [candidate.content ?? "", ...(candidate.tags ?? [])].join(" ");

  let best: SimilarNoteHit<T> | undefined;

  for (const entry of existing) {
    const entryNormTitle = stripDiacritics(normalizeNFC(entry.title)).toLowerCase().trim();
    const aliasMatch = (entry.aliases ?? []).some(
      (al) => stripDiacritics(normalizeNFC(al)).toLowerCase().trim() === candidateNormTitle,
    );
    if (candidateNormTitle && (entryNormTitle === candidateNormTitle || aliasMatch)) {
      return { entry, score: 1 };
    }

    const sameCategory =
      Boolean(candidate.category && entry.category) && candidate.category === entry.category;
    const sameTopFolder =
      Boolean(candidate.folder) &&
      normalizeNFC(entry.relativePath).toLowerCase().startsWith(normalizeNFC(candidate.folder!).toLowerCase());

    const entryComparable: ComparableNote = {
      title: entry.title,
      aliases: entry.aliases,
      tags: entry.tags,
      body: [...(entry.headings ?? []), ...(entry.tags ?? []), entry.title].join(" "),
      folder: entry.folder ?? entry.relativePath.split("/").slice(0, -1).join("/"),
      category: entry.category,
    };

    const titleScore = jaccard(
      candidateTitleTokens,
      tokenize([entry.title, ...(entry.aliases ?? [])].join(" ")),
    );
    const fullScore = similarity(
      {
        title: candidate.title,
        tags: candidate.tags,
        body: candidateBody,
        folder: candidate.folder,
        category: candidate.category,
      },
      entryComparable,
    );

    const boosted = Math.max(fullScore, titleScore * 0.92) + (sameCategory || sameTopFolder ? 0.05 : 0);
    const capped = Math.min(1, boosted);

    if (capped >= threshold && (!best || capped > best.score)) {
      best = { entry, score: capped };
    }
  }

  return best;
}
