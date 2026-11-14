import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, readFileWithRetry } from "./atomic-write.js";
import { parseNoteFrontmatter } from "./frontmatter.js";
import { withFsRetry } from "./fs-retry.js";
import { normalizeNFC, normalizeVaultPath, normalizeWikilinkTarget } from "./unicode.js";
import { buildWikilinkResolver, extractWikilinks } from "./wikilinks.js";

export interface LintReport {
  totalNotes: number;
  fixedBrokenLinks: number;
  brokenLinksRemaining: Array<{ file: string; target: string }>;
  orphanNotes: string[];
  emptySectionNotes: string[];
  oversizedNotes: Array<{ file: string; bytes: number }>;
  mocUpdated: boolean;
  dashboardUpdated: boolean;
}

interface ScannedNote {
  relativePath: string;
  absPath: string;
  folder: string;
  title: string;
  aliases: string[];
  tags: string[];
  status: string;
  updated: string;
  category: string;
  bytes: number;
  content: string;
}

const OVERSIZED_BYTES = 35_000;

function stripAccentsLower(value: string): string {
  return normalizeNFC(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function detectEmptySections(markdown: string): boolean {
  const { body } = parseNoteFrontmatter(markdown);
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!/^#{1,4}\s+.+$/.test(line)) continue;

    let j = i + 1;
    let hasContent = false;
    while (j < lines.length) {
      const nextLine = (lines[j] ?? "").trim();
      if (/^#{1,4}\s+.+$/.test(nextLine)) {
        break;
      }
      if (nextLine.length > 0 && !nextLine.startsWith("<!--")) {
        hasContent = true;
        break;
      }
      j++;
    }
    if (!hasContent && j < lines.length) {
      return true;
    }
  }
  return false;
}

async function collectPillarNotes(vaultRoot: string, rootFolders: readonly string[]): Promise<ScannedNote[]> {
  const notes: ScannedNote[] = [];

  async function walk(absDir: string, rootFolder: string): Promise<void> {
    let entries;
    try {
      entries = await withFsRetry(() => fs.readdir(absDir, { withFileTypes: true }), `lint:readdir:${absDir}`);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rootFolder);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;

      const content = await readFileWithRetry(full).catch(() => "");
      if (!content) continue;

      const relPath = normalizeVaultPath(path.relative(vaultRoot, full));
      const parsed = parseNoteFrontmatter(content);
      const basenameNoExt = normalizeNFC(path.basename(entry.name, ".md"));
      const rawTitle = typeof parsed.properties.title === "string" ? parsed.properties.title : basenameNoExt;
      const aliases = Array.isArray(parsed.properties.aliases)
        ? parsed.properties.aliases.map((a) => normalizeNFC(String(a))).filter(Boolean)
        : [];
      const tags = Array.isArray(parsed.properties.tags)
        ? parsed.properties.tags.map((t) => normalizeNFC(String(t))).filter(Boolean)
        : [];
      const status = typeof parsed.properties.status === "string" ? parsed.properties.status : "ativo";
      const updated = typeof parsed.properties.updated === "string" ? parsed.properties.updated : "";
      const category = typeof parsed.properties.category === "string" ? parsed.properties.category : rootFolder;

      notes.push({
        relativePath: relPath,
        absPath: full,
        folder: rootFolder,
        title: normalizeNFC(rawTitle),
        aliases,
        tags,
        status,
        updated,
        category,
        bytes: Buffer.byteLength(content, "utf8"),
        content: normalizeNFC(content),
      });
    }
  }

  for (const folder of rootFolders) {
    await walk(path.join(vaultRoot, folder), folder);
  }

  notes.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "pt-BR"));
  return notes;
}

function buildFuzzyTargetLookup(notes: readonly ScannedNote[]): Map<string, string> {
  const counts = new Map<string, number>();
  const mapping = new Map<string, string>();

  for (const note of notes) {
    const basename = path.basename(note.relativePath, ".md");
    const keys = [stripAccentsLower(basename), stripAccentsLower(note.title)];
    for (const k of keys) {
      if (!k) continue;
      counts.set(k, (counts.get(k) ?? 0) + 1);
      if (!mapping.has(k)) {
        mapping.set(k, normalizeNFC(basename));
      }
    }
  }

  for (const [k, count] of counts.entries()) {
    if (count > 1) {
      mapping.delete(k);
    }
  }

  return mapping;
}

function repairWikilinksInMarkdown(
  markdown: string,
  sourceRelPath: string,
  resolver: (target: string, sourceRelPath: string) => boolean,
  fuzzyLookup: ReadonlyMap<string, string>,
): { content: string; fixedCount: number } {
  let fixedCount = 0;
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let fenceMarker = "";

  const nextLines = lines.map((line) => {
    const trimmed = line.trimStart();
    if (inFence) {
      if (trimmed.startsWith(fenceMarker)) {
        inFence = false;
      }
      return line;
    }
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = true;
      fenceMarker = trimmed.slice(0, 3);
      return line;
    }

    return line.replace(/(!)?\[\[([^\[\]\n]+?)\]\]/g, (full, embed: string | undefined, inner: string) => {
      if (embed) return full;

      const pipeIdx = inner.indexOf("|");
      const targetPart = (pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner).trim();
      const aliasPart = pipeIdx >= 0 ? inner.slice(pipeIdx + 1).trim() : undefined;

      const hashIdx = targetPart.indexOf("#");
      const rawTarget = (hashIdx >= 0 ? targetPart.slice(0, hashIdx) : targetPart).trim();
      const headingPart = hashIdx >= 0 ? targetPart.slice(hashIdx + 1).trim() : undefined;

      if (!rawTarget || resolver(rawTarget, sourceRelPath)) {
        return full;
      }

      const rawBase = normalizeWikilinkTarget(rawTarget).split("/").pop() ?? "";
      const candidate = fuzzyLookup.get(stripAccentsLower(rawBase));
      if (!candidate || candidate === rawTarget) {
        return full;
      }

      fixedCount += 1;
      const nextTarget = headingPart ? `${candidate}#${headingPart}` : candidate;
      const nextInner = aliasPart ? `${nextTarget}|${aliasPart}` : nextTarget;
      return `[[${nextInner}]]`;
    });
  });

  return {
    content: nextLines.join("\n"),
    fixedCount,
  };
}

function renderGlobalMocMarkdown(notes: readonly ScannedNote[], reportSummary: { orphanCount: number; brokenCount: number }): string {
  const byFolder = new Map<string, ScannedNote[]>();
  for (const n of notes) {
    const list = byFolder.get(n.folder) ?? [];
    list.push(n);
    byFolder.set(n.folder, list);
  }

  const lines: string[] = [
    "---",
    'title: "00 Indice Global MOC"',
    "type: moc",
    "category: meta",
    "status: ativo",
    "tags:",
    "  - moc",
    "  - indice-global",
    "  - cortex-vault-engine",
    `notes_indexed: ${notes.length}`,
    "---",
    "",
    "# Indice Global do Segundo Cerebro (MOC)",
    "",
    "> [!abstract] Mapa Vivo de Conhecimento (Graph Backbone)",
    `> Este Map of Content conecta automaticamente todas as **${notes.length} notas** dos 5 pilares do cofre para garantir **zero notas orfas** no Graph View do Obsidian.`,
    `> Links rapidos: [[00_Dashboard_Principal|Dashboard Principal]] | [[00_Catalogo_Geral.base|Base Catalogo Geral]] | [[Recentes.base|Base Recentes]]`,
    "",
    `> [!info] Auditoria do Ciclo Atual`,
    `> - Orfas antes do MOC: **${reportSummary.orphanCount}** (todas conectadas por este indice)`,
    `> - Wikilinks pendentes de revisao: **${reportSummary.brokenCount}**`,
    "",
  ];

  const sortedFolders = [...byFolder.keys()].sort((a, b) => a.localeCompare(b, "pt-BR"));
  for (const folder of sortedFolders) {
    const list = (byFolder.get(folder) ?? []).slice().sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));
    lines.push(`## ${folder} (${list.length})`, "");
    for (const note of list) {
      const targetNoExt = note.relativePath.replace(/\.md$/i, "");
      const metaBits: string[] = [];
      if (note.updated) metaBits.push(`atualizado: ${note.updated}`);
      if (note.tags.length > 0) metaBits.push(note.tags.slice(0, 3).map((t) => `#${t}`).join(" "));
      const suffix = metaBits.length > 0 ? ` — _${metaBits.join(" | ")}_` : "";
      lines.push(`- [[${targetNoExt}|${note.title}]]${suffix}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderDashboardMarkdown(
  notes: readonly ScannedNote[],
  report: Omit<LintReport, "mocUpdated" | "dashboardUpdated">,
): string {
  const recent = notes
    .filter((n) => Boolean(n.updated))
    .slice()
    .sort((a, b) => b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title, "pt-BR"))
    .slice(0, 15);

  const byFolderCounts = new Map<string, number>();
  for (const n of notes) {
    byFolderCounts.set(n.folder, (byFolderCounts.get(n.folder) ?? 0) + 1);
  }

  const lines: string[] = [
    "---",
    'title: "00 Dashboard Principal"',
    "type: dashboard",
    "category: meta",
    "status: ativo",
    "tags:",
    "  - dashboard",
    "  - cortex-vault-engine",
    "  - segundo-cerebro",
    "---",
    "",
    "# Dashboard Principal — Cortex Vault Engine V6.0",
    "",
    "> [!abstract] Central de Comando do Cofre",
    "> Navegacao rapida: [[00_Indice_Global_MOC|Indice Global MOC]] | [[00_Catalogo_Geral.base|Catalogo em Tabela (.base)]] | [[Recentes.base|Notas Recentes (.base)]] | [[05_Pessoal_e_Vida/00_Perfil_Mestre_Jefherson|Perfil Mestre]]",
    "",
    "## Visao Geral por Pilar",
    "",
    "| Pilar | Total de Notas |",
    "|---|---|",
    ...[...byFolderCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], "pt-BR"))
      .map(([folder, count]) => `| **${folder}** | ${count} |`),
    `| **TOTAL CATALOGADO** | **${notes.length}** |`,
    "",
    "## Arquitetura do Fluxo Cortex V6.0",
    "",
    "```mermaid",
    "flowchart LR",
    '  Inbox["00_Inbox_Bruto (.md)"] --> Watch["Chokidar Polling + Active Scan"]',
    '  Watch --> Queue["Serial Promise Queue"]',
    '  Queue --> Gemini["Gemini Map-Reduce + Wiki-Fold"]',
    '  Gemini --> Tx["Atomic Write + Tx Ledger"]',
    '  Tx --> Pillars["5 Pilares + MOCs + .base"]',
    "```",
    "",
    "## Ultimas Notas Atualizadas",
    "",
  ];

  if (recent.length === 0) {
    lines.push("- Nenhuma nota com data `updated` registrada ainda.");
  } else {
    for (const note of recent) {
      const targetNoExt = note.relativePath.replace(/\.md$/i, "");
      lines.push(`- [[${targetNoExt}|${note.title}]] (${note.updated}) — \`${note.folder}\``);
    }
  }

  lines.push("", "## Higiene Ativa e Linting do Cofre", "");
  lines.push(`- Links quebrados reparados neste ciclo: **${report.fixedBrokenLinks}**`);
  lines.push(`- Links quebrados ainda pendentes: **${report.brokenLinksRemaining.length}**`);
  lines.push(`- Notas extensas (>35 KB) candidatas a split/fold futuro: **${report.oversizedNotes.length}**`);

  if (report.oversizedNotes.length > 0) {
    lines.push("", "> [!warning] Notas Extensas Monitoradas");
    for (const ov of report.oversizedNotes.slice(0, 10)) {
      lines.push(`> - [[${ov.file.replace(/\.md$/i, "")}]] (${Math.round(ov.bytes / 1024)} KB)`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

async function writeIfBodyChanged(
  absPath: string,
  nextContent: string,
  tempDir?: string,
  recordBotWrite?: (absPath: string, content: string) => void,
): Promise<boolean> {
  const existing = await readFileWithRetry(absPath).catch(() => "");
  if (normalizeNFC(existing) === normalizeNFC(nextContent)) {
    return false;
  }
  await atomicWriteFile(absPath, nextContent, tempDir);
  recordBotWrite?.(absPath, nextContent);
  return true;
}

/**
 * Executa varredura de higiene ativa (broken links, orfas, secoes vazias, oversized)
 * e mantem `00_Indice_Global_MOC.md` + `00_Dashboard_Principal.md` sincronizados sem criar orfas.
 */
export async function runActiveHygieneAndLint(opts: {
  vaultRoot: string;
  rootFolders: readonly string[];
  tempDir?: string | undefined;
  recordBotWrite?: ((absPath: string, content: string) => void) | undefined;
}): Promise<LintReport> {
  const notes = await collectPillarNotes(opts.vaultRoot, opts.rootFolders);
  const allPaths = notes.map((n) => n.relativePath);
  const aliasesByFile = new Map<string, readonly string[]>(
    notes.map((n) => [n.relativePath, [n.title, ...n.aliases]]),
  );
  const resolver = buildWikilinkResolver(allPaths, aliasesByFile);
  const fuzzyLookup = buildFuzzyTargetLookup(notes);

  let fixedBrokenLinks = 0;
  const brokenLinksRemaining: Array<{ file: string; target: string }> = [];
  const emptySectionNotes: string[] = [];
  const oversizedNotes: Array<{ file: string; bytes: number }> = [];
  const incomingLinks = new Map<string, number>();

  for (const note of notes) {
    incomingLinks.set(note.relativePath.toLowerCase(), 0);
  }

  for (const note of notes) {
    const repaired = repairWikilinksInMarkdown(note.content, note.relativePath, resolver, fuzzyLookup);
    if (repaired.fixedCount > 0 && repaired.content !== note.content) {
      await atomicWriteFile(note.absPath, repaired.content, opts.tempDir);
      opts.recordBotWrite?.(note.absPath, repaired.content);
      note.content = repaired.content;
      fixedBrokenLinks += repaired.fixedCount;
    }

    if (detectEmptySections(note.content)) {
      emptySectionNotes.push(note.relativePath);
    }
    if (note.bytes > OVERSIZED_BYTES) {
      oversizedNotes.push({ file: note.relativePath, bytes: note.bytes });
    }

    const links = extractWikilinks(note.content);
    for (const link of links) {
      if (!resolver(link.target, note.relativePath)) {
        brokenLinksRemaining.push({ file: note.relativePath, target: link.target });
        continue;
      }

      const normTarget = normalizeWikilinkTarget(link.target).replace(/\.md$/i, "").toLowerCase();
      for (const candidate of notes) {
        const candNoExt = candidate.relativePath.replace(/\.md$/i, "").toLowerCase();
        const candBase = path.basename(candNoExt);
        if (candNoExt === normTarget || candBase === normTarget) {
          if (candidate.relativePath !== note.relativePath) {
            incomingLinks.set(
              candidate.relativePath.toLowerCase(),
              (incomingLinks.get(candidate.relativePath.toLowerCase()) ?? 0) + 1,
            );
          }
          break;
        }
      }
    }
  }

  const orphanNotes = notes
    .filter((n) => (incomingLinks.get(n.relativePath.toLowerCase()) ?? 0) === 0)
    .map((n) => n.relativePath);

  const mocContent = renderGlobalMocMarkdown(notes, {
    orphanCount: orphanNotes.length,
    brokenCount: brokenLinksRemaining.length,
  });
  const dashboardContent = renderDashboardMarkdown(notes, {
    totalNotes: notes.length,
    fixedBrokenLinks,
    brokenLinksRemaining,
    orphanNotes,
    emptySectionNotes,
    oversizedNotes,
  });

  const mocAbs = path.join(opts.vaultRoot, "00_Indice_Global_MOC.md");
  const dashAbs = path.join(opts.vaultRoot, "00_Dashboard_Principal.md");

  const mocUpdated = await writeIfBodyChanged(mocAbs, mocContent, opts.tempDir, opts.recordBotWrite);
  const dashboardUpdated = await writeIfBodyChanged(dashAbs, dashboardContent, opts.tempDir, opts.recordBotWrite);

  return {
    totalNotes: notes.length,
    fixedBrokenLinks,
    brokenLinksRemaining,
    orphanNotes,
    emptySectionNotes,
    oversizedNotes,
    mocUpdated,
    dashboardUpdated,
  };
}
