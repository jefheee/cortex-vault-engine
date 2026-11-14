import { parseNoteFrontmatter } from "./frontmatter.js";
import { normalizeNFC } from "./unicode.js";
import { extractWikilinks, normalizeMarkdownWikilinks } from "./wikilinks.js";

export interface ValidateWriteInput {
  targetPath: string;
  incomingMarkdown: string;
  previousMarkdown?: string | undefined;
}

export interface ValidateWriteResult {
  valid: boolean;
  sanitizedMarkdown: string;
  warnings: string[];
  errors: string[];
}

function countUnclosedFences(markdown: string): number {
  let inFence = false;
  let fenceMarker = "";
  let unclosedCount = 0;

  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!inFence) {
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        inFence = true;
        fenceMarker = trimmed.slice(0, 3);
      }
    } else if (trimmed.startsWith(fenceMarker)) {
      inFence = false;
      fenceMarker = "";
    }
  }

  if (inFence) {
    unclosedCount = 1;
  }
  return unclosedCount;
}

/**
 * Valida integridade estrutural, YAML frontmatter, blocos de codigo, NFC e
 * protecao anti-truncamento antes da escrita atomica em disco (`obsidian-mind`).
 */
export function validateNoteBeforeWrite(input: ValidateWriteInput): ValidateWriteResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let sanitized = normalizeMarkdownWikilinks(
    normalizeNFC(input.incomingMarkdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")),
  ).trimEnd();

  if (!sanitized) {
    return {
      valid: false,
      sanitizedMarkdown: "",
      warnings,
      errors: ["Conteudo Markdown vazio apos normalizacao."],
    };
  }

  if (!sanitized.endsWith("\n")) {
    sanitized += "\n";
  }

  const parsed = parseNoteFrontmatter(sanitized);
  if (!parsed.hasFrontmatter) {
    if (input.previousMarkdown && parseNoteFrontmatter(input.previousMarkdown).hasFrontmatter) {
      errors.push("Frontmatter YAML existente foi removido na operacao de merge.");
    } else {
      warnings.push("Nota sem bloco de frontmatter YAML valido.");
    }
  } else {
    if (!parsed.properties.title) {
      warnings.push("Propriedade YAML 'title' ausente.");
    }
    if (!parsed.properties.tags || (Array.isArray(parsed.properties.tags) && parsed.properties.tags.length === 0)) {
      warnings.push("Propriedade YAML 'tags' ausente ou vazia.");
    }
  }

  if (parsed.body.trim().length === 0) {
    errors.push("Corpo da nota esta vazio apos remover o frontmatter YAML.");
  }

  if (countUnclosedFences(sanitized) > 0) {
    warnings.push("Bloco de codigo cercado (``` / ~~~) possivelmente aberto; fechamento automatico aplicado.");
    sanitized = `${sanitized.trimEnd()}\n\`\`\`\n`;
  }

  if (input.previousMarkdown) {
    const prevClean = input.previousMarkdown.trim();
    if (prevClean.length > 120 && sanitized.trim().length < prevClean.length * 0.45) {
      errors.push(
        `Protecao anti-truncamento acionada (${sanitized.trim().length}c < 45% de ${prevClean.length}c).`,
      );
    }
  }

  const links = extractWikilinks(sanitized);
  if (sanitized.length > 400 && links.length === 0) {
    warnings.push("Nota extensa sem [[Wikilinks]] internos; Active Hygiene garantira conexao no MOC.");
  }

  return {
    valid: errors.length === 0,
    sanitizedMarkdown: sanitized,
    warnings,
    errors,
  };
}
