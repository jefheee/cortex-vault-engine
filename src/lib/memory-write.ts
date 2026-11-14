import path from "node:path";
import { mergePropertyList, parseNoteFrontmatter, serializeNoteFrontmatter } from "./frontmatter.js";
import { normalizeNFC } from "./unicode.js";
import { validateNoteBeforeWrite, type ValidateWriteResult } from "./validate-write.js";

export const MEMORY_SOURCE = "cortex-vault-engine";

const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const SLUG_MAX = 96;

/**
 * Normaliza slug/nome de nota preservando NFC e protegendo contra nomes reservados do Windows.
 */
export function sanitizeMemorySlug(rawName: string): string {
  let clean = normalizeNFC(rawName)
    .replace(/\.md$/i, "")
    .replace(/[<>:"/\\|?*#^\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) {
    clean = `Nota_Sem_Titulo_${Date.now()}`;
  }

  if (clean.length > SLUG_MAX) {
    clean = clean.slice(0, SLUG_MAX).trim();
  }

  if (WINDOWS_RESERVED.test(clean)) {
    clean = `${clean}_Nota`;
  }

  return clean;
}

export interface PrepareCanonicalWriteInput {
  targetPath: string;
  markdown: string;
  previousMarkdown?: string | undefined;
  sourceChat?: string | undefined;
  relatedLinks?: readonly string[] | undefined;
  status?: string | undefined;
}

/**
 * Injeta metadados canonicos do Cortex Engine e executa validacao estrutural antes da escrita atomica.
 */
export function prepareCanonicalNoteWrite(input: PrepareCanonicalWriteInput): ValidateWriteResult {
  const parsed = parseNoteFrontmatter(normalizeNFC(input.markdown));
  const props: Record<string, unknown> = { ...parsed.properties };

  if (!props.title) {
    props.title = path.basename(input.targetPath, path.extname(input.targetPath));
  }
  const today = new Date().toISOString().slice(0, 10);
  if (!props.created) {
    props.created = today;
  }
  props.updated = today;

  if (!props.status && input.status) {
    props.status = input.status;
  }
  if (!props.source) {
    props.source = MEMORY_SOURCE;
  }
  if (input.sourceChat && !props.source_chat) {
    props.source_chat = normalizeNFC(input.sourceChat);
  }
  if (input.relatedLinks && input.relatedLinks.length > 0) {
    props.related = mergePropertyList(props.related, input.relatedLinks, false, 20);
  }

  const withFrontmatter = serializeNoteFrontmatter(props, parsed.body);
  return validateNoteBeforeWrite({
    targetPath: input.targetPath,
    incomingMarkdown: withFrontmatter,
    previousMarkdown: input.previousMarkdown,
  });
}
