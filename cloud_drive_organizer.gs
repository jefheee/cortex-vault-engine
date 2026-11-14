/**
 * Obsidian Auto-Organizer V5.3 — Drive -> 00_Inbox_Bruto Bridge + Fallback Nuvem
 * ------------------------------------------------------------------------------
 * PONTE AUTOMATICA PARA CHATS EXPORTADOS DO GEMINI ("Exportar para o Google Docs"):
 * - Le Google Docs direto na sua conta via DocumentApp, grava `.md` em `Obsidian/00_Inbox_Bruto/`
 *   e move o Google Doc original da raiz do Meu Drive para `Meu Drive/Gemini_Exports_Processados/`
 *   para dar feedback visual imediato e evitar duplicacao.
 *
 * FONTES MONITORADAS AUTOMATICAMENTE por `syncGeminiDocsToObsidianInbox()`:
 * 1. `Obsidian/00_Inbox_Bruto/` & `Obsidian/` -> Converte qualquer `.gdoc` em `.md` e envia o `.gdoc` para a lixeira.
 * 2. `Meu Drive/Gemini_Exports/`              -> Converte em `.md` e move para `Gemini_Exports_Processados/`.
 * 3. `Meu Drive/` raiz                        -> Detecta TODOS os Google Docs criados/modificados nas
 *    ultimas 48 horas (sem exigir "Voce disse:"/"Gemini disse:") ainda nao processados, salva `.md`
 *    em `Obsidian/00_Inbox_Bruto/` e move o original para `Gemini_Exports_Processados/`.
 *
 * CONFIGURACAO RAPIDA (COLE, SALVE E CLIQUE EM EXECUTAR EM `setupObsidianGeminiBridge`):
 * 1. Abra https://script.google.com, cole este arquivo inteiro por cima do anterior e Salve.
 * 2. Selecione `setupObsidianGeminiBridge` na barra superior e clique em EXECUTAR:
 *    - Ele instala o gatilho automatico a cada 5 minutos E ja executa a primeira varredura na hora!
 */

const CONFIG = {
  GEMINI_MODELS: [
    "gemini-2.5-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-2.5-flash-lite",
  ],
  BRIDGE_DEBOUNCE_MS: 20 * 1000,
  ROOT_LOOKBACK_HOURS: 48,
  PROCESSED_EXPORTS_FOLDER: "Gemini_Exports_Processados",
  MAX_EXECUTION_MS: 240 * 1000,
  DEBOUNCE_MS: 60 * 1000,
  EMPTY_CLEANUP_MS: 15 * 60 * 1000,
  INBOX_BRUTO_FOLDER: "00_Inbox_Bruto",
  OPTIONAL_EXPORTS_FOLDER: "Gemini_Exports",
  ROOT_FOLDERS: [
    "01_Pessoas",
    "02_Projetos_e_Negocios",
    "03_Faculdade_e_Estudos",
    "04_Padroes_e_Prompts",
    "05_Pessoal_e_Vida",
  ],
  IGNORED_FILES: [
    "gemini.md",
    ".gemini.md",
    "agents.md",
    "readme.md",
    "00_indice_global_moc.md",
    "00_dashboard_principal.md",
    "00_catalogo_geral.base",
    "recentes.base",
  ],
};

/**
 * Configura o gatilho automatico de 5 minutos (`syncGeminiDocsToObsidianInbox`)
 * e ja executa a importacao imediatamente na mesma chamada.
 */
function setupObsidianGeminiBridge() {
  const existing = ScriptApp.getProjectTriggers();
  for (let i = 0; i < existing.length; i++) {
    const fn = existing[i].getHandlerFunction();
    if (fn === "syncGeminiDocsToObsidianInbox" || fn === "runCloudOrganizer") {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }

  ScriptApp.newTrigger("syncGeminiDocsToObsidianInbox")
    .timeBased()
    .everyMinutes(5)
    .create();

  Logger.log("Ponte Drive -> Obsidian/00_Inbox_Bruto V5.3 ativada (gatilho a cada 5 min). Iniciando varredura imediata...");
  syncGeminiDocsToObsidianInbox();
}

function createTrigger5Min() {
  const existing = ScriptApp.getProjectTriggers();
  for (let i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === "runCloudOrganizer") {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  ScriptApp.newTrigger("runCloudOrganizer")
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log("Gatilho de 5 minutos criado para runCloudOrganizer V5.3 (fallback em nuvem).");
}

function getProcessedDocIdSet_(props) {
  try {
    const raw = props.getProperty("PROCESSED_GDOC_IDS");
    const arr = raw ? JSON.parse(raw) : [];
    const set = {};
    for (let i = 0; i < arr.length; i++) {
      set[arr[i]] = true;
    }
    return set;
  } catch (e) {
    return {};
  }
}

function saveProcessedDocId_(props, setObj, docId) {
  setObj[docId] = true;
  const keys = Object.keys(setObj);
  const trimmed = keys.length > 1000 ? keys.slice(keys.length - 1000) : keys;
  props.setProperty("PROCESSED_GDOC_IDS", JSON.stringify(trimmed));
}

function getOrCreateRootSubfolder_(folderName) {
  const root = DriveApp.getRootFolder();
  const iter = root.getFoldersByName(folderName);
  return iter.hasNext() ? iter.next() : root.createFolder(folderName);
}

/** Converte um Google Doc em Markdown estruturado preservando Headings, listas e tabelas. */
function convertGoogleDocToMarkdown_(docId) {
  const doc = DocumentApp.openById(docId);
  const body = doc.getBody();
  const numChildren = body.getNumChildren();
  const lines = [];

  for (let i = 0; i < numChildren; i++) {
    const el = body.getChild(i);
    const type = el.getType();
    if (type === DocumentApp.ElementType.PARAGRAPH) {
      const p = el.asParagraph();
      const text = p.getText().trimEnd();
      if (!text) {
        lines.push("");
        continue;
      }
      const h = p.getHeading();
      if (h === DocumentApp.ParagraphHeading.HEADING1) lines.push("# " + text);
      else if (h === DocumentApp.ParagraphHeading.HEADING2) lines.push("## " + text);
      else if (h === DocumentApp.ParagraphHeading.HEADING3) lines.push("### " + text);
      else if (h === DocumentApp.ParagraphHeading.HEADING4) lines.push("#### " + text);
      else lines.push(text);
    } else if (type === DocumentApp.ElementType.LIST_ITEM) {
      const li = el.asListItem();
      const indent = "  ".repeat(Math.min(li.getNestingLevel(), 4));
      lines.push(indent + "- " + li.getText().trim());
    } else if (type === DocumentApp.ElementType.TABLE) {
      lines.push(el.asTable().getText().trim());
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function resolveVaultAndInboxFolders_(props) {
  const rootFolderId = (props.getProperty("OBSIDIAN_FOLDER_ID") || "").trim();
  const vaultFolder = rootFolderId
    ? DriveApp.getFolderById(rootFolderId)
    : findSingleFolderByName_("Obsidian");
  if (!vaultFolder) {
    throw new Error("Pasta 'Obsidian' nao encontrada. Defina OBSIDIAN_FOLDER_ID.");
  }
  const inboxIter = vaultFolder.getFoldersByName(CONFIG.INBOX_BRUTO_FOLDER);
  const inboxFolder = inboxIter.hasNext()
    ? inboxIter.next()
    : vaultFolder.createFolder(CONFIG.INBOX_BRUTO_FOLDER);
  return { vaultFolder: vaultFolder, inboxFolder: inboxFolder };
}

function exportDocFileToInboxMd_(docFile, inboxFolder, processedExportsFolder, dispositionMode) {
  const name = docFile.getName() || "Conversa_Gemini";
  let mdText = convertGoogleDocToMarkdown_(docFile.getId());
  if (!mdText) {
    return false;
  }
  if (!/^#\s/.test(mdText)) {
    mdText = "# " + name + "\n\n" + mdText;
  }
  const mdName = sanitizeFilename_(name);
  const finalName = resolveUniqueDriveFilename_(inboxFolder, mdName);
  inboxFolder.createFile(finalName, mdText, MimeType.PLAIN_TEXT);

  if (dispositionMode === "move" && processedExportsFolder) {
    docFile.moveTo(processedExportsFolder);
  } else if (dispositionMode === "trash") {
    docFile.setTrashed(true);
  }

  Logger.log('GDOC_TO_INBOX: "' + name + '" -> "00_Inbox_Bruto/' + finalName + '" (' + dispositionMode + ")");
  return true;
}

/**
 * Ponte automatica sem atrito: converte Google Docs de `00_Inbox_Bruto/`, `Obsidian/`,
 * `Gemini_Exports/` e da raiz do `Meu Drive` (ultimas 48h, sem filtro de texto) para `.md`
 * em `00_Inbox_Bruto/`, movendo os Docs processados da raiz para `Gemini_Exports_Processados/`.
 */
function syncGeminiDocsToObsidianInbox() {
  const startedMs = Date.now();
  const props = PropertiesService.getScriptProperties();
  const folders = resolveVaultAndInboxFolders_(props);
  const processedExportsFolder = getOrCreateRootSubfolder_(CONFIG.PROCESSED_EXPORTS_FOLDER);
  const nowMs = Date.now();
  const cutoffMs = nowMs - CONFIG.ROOT_LOOKBACK_HOURS * 60 * 60 * 1000;
  const processedSet = getProcessedDocIdSet_(props);
  let convertedCount = 0;

  // 1. Pastas dentro do cofre (qualquer .gdoc em 00_Inbox_Bruto/ ou Obsidian/ vai para .md + lixeira)
  const vaultSources = [folders.inboxFolder, folders.vaultFolder];
  for (let s = 0; s < vaultSources.length; s++) {
    if (Date.now() - startedMs >= CONFIG.MAX_EXECUTION_MS) {
      Logger.log("MAX_EXECUTION_MS atingido na etapa vaultSources. Continuara no proximo ciclo de 5 min.");
      return;
    }
    const docs = vaultSources[s].getFilesByType(MimeType.GOOGLE_DOCS);
    while (docs.hasNext()) {
      if (Date.now() - startedMs >= CONFIG.MAX_EXECUTION_MS) {
        Logger.log("MAX_EXECUTION_MS atingido. Parcial convertido: " + convertedCount);
        return;
      }
      const docFile = docs.next();
      if (nowMs - docFile.getLastUpdated().getTime() < CONFIG.BRIDGE_DEBOUNCE_MS) {
        continue;
      }
      try {
        if (exportDocFileToInboxMd_(docFile, folders.inboxFolder, null, "trash")) {
          saveProcessedDocId_(props, processedSet, docFile.getId());
          convertedCount += 1;
        }
      } catch (err) {
        Logger.log("GDOC_VAULT_ERROR (" + docFile.getName() + "): " + err.message);
      }
    }
  }

  // 2. Pasta opcional Gemini_Exports/ (converte e move para Gemini_Exports_Processados/)
  const optExports = findSingleFolderByName_(CONFIG.OPTIONAL_EXPORTS_FOLDER);
  if (optExports) {
    const expDocs = optExports.getFilesByType(MimeType.GOOGLE_DOCS);
    while (expDocs.hasNext()) {
      if (Date.now() - startedMs >= CONFIG.MAX_EXECUTION_MS) {
        Logger.log("MAX_EXECUTION_MS atingido em Gemini_Exports. Parcial convertido: " + convertedCount);
        return;
      }
      const docFile = expDocs.next();
      const docId = docFile.getId();
      if (processedSet[docId] || nowMs - docFile.getLastUpdated().getTime() < CONFIG.BRIDGE_DEBOUNCE_MS) {
        continue;
      }
      try {
        if (exportDocFileToInboxMd_(docFile, folders.inboxFolder, processedExportsFolder, "move")) {
          saveProcessedDocId_(props, processedSet, docId);
          convertedCount += 1;
        }
      } catch (err) {
        Logger.log("GDOC_EXPORTS_ERROR (" + docFile.getName() + "): " + err.message);
      }
    }
  }

  // 3. Raiz do Meu Drive: TODOS Google Docs criados/modificados nas ultimas 48h (sem filtro de texto)
  const myDriveDocs = DriveApp.getRootFolder().getFilesByType(MimeType.GOOGLE_DOCS);
  while (myDriveDocs.hasNext()) {
    if (Date.now() - startedMs >= CONFIG.MAX_EXECUTION_MS) {
      Logger.log("MAX_EXECUTION_MS (240s) atingido na raiz do Drive. Restante sera importado no proximo ciclo de 5 min. Convertidos agora: " + convertedCount);
      return;
    }
    const docFile = myDriveDocs.next();
    const docId = docFile.getId();
    if (processedSet[docId]) {
      continue;
    }
    const createdMs = docFile.getDateCreated().getTime();
    const updatedMs = docFile.getLastUpdated().getTime();
    const latestActivityMs = Math.max(createdMs, updatedMs);
    if (latestActivityMs < cutoffMs || nowMs - updatedMs < CONFIG.BRIDGE_DEBOUNCE_MS) {
      continue;
    }
    try {
      if (exportDocFileToInboxMd_(docFile, folders.inboxFolder, processedExportsFolder, "move")) {
        saveProcessedDocId_(props, processedSet, docId);
        convertedCount += 1;
      }
    } catch (err) {
      Logger.log("GDOC_ROOT_SCAN_ERROR (" + docFile.getName() + "): " + err.message);
    }
  }

  Logger.log("syncGeminiDocsToObsidianInbox V5.3 finalizado: " + convertedCount + " Google Doc(s) importados para 00_Inbox_Bruto/.");
}

/**
 * Helper opcional para importar Google Docs dos ultimos N dias na raiz do Meu Drive (sem filtro de texto).
 */
function importarChatsGeminiUltimosDias(dias) {
  const startedMs = Date.now();
  const lookbackDays = typeof dias === "number" && dias > 0 ? dias : 14;
  const cutoffMs = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const props = PropertiesService.getScriptProperties();
  const folders = resolveVaultAndInboxFolders_(props);
  const processedExportsFolder = getOrCreateRootSubfolder_(CONFIG.PROCESSED_EXPORTS_FOLDER);
  const processedSet = getProcessedDocIdSet_(props);
  const docs = DriveApp.getRootFolder().getFilesByType(MimeType.GOOGLE_DOCS);
  let count = 0;

  while (docs.hasNext()) {
    if (Date.now() - startedMs >= CONFIG.MAX_EXECUTION_MS) {
      Logger.log("MAX_EXECUTION_MS atingido em importarChatsGeminiUltimosDias. Parcial: " + count);
      break;
    }
    const docFile = docs.next();
    const docId = docFile.getId();
    const latestActivityMs = Math.max(docFile.getDateCreated().getTime(), docFile.getLastUpdated().getTime());
    if (processedSet[docId] || latestActivityMs < cutoffMs) {
      continue;
    }
    try {
      if (exportDocFileToInboxMd_(docFile, folders.inboxFolder, processedExportsFolder, "move")) {
        saveProcessedDocId_(props, processedSet, docId);
        count += 1;
      }
    } catch (err) {
      Logger.log("IMPORT_BATCH_ERR (" + docFile.getName() + "): " + err.message);
    }
  }
  Logger.log("Importacao em lote concluida: " + count + " Google Doc(s) movidos para Gemini_Exports_Processados e copiados para 00_Inbox_Bruto.");
}

function getApiKeysPool_(props) {
  const raw = props.getProperty("GEMINI_API_KEYS") || props.getProperty("GEMINI_API_KEY") || "";
  const parts = raw.split(",");
  const keys = [];
  for (let i = 0; i < parts.length; i++) {
    const k = parts[i].trim();
    if (k && keys.indexOf(k) === -1) {
      keys.push(k);
    }
  }
  return keys;
}

/**
 * Converte Google Docs colocados manualmente na raiz de Obsidian em `.md` antes do fallback em nuvem.
 */
function ingestGeminiExportedDocs_(vaultFolder, nowMs) {
  const docs = vaultFolder.getFilesByType(MimeType.GOOGLE_DOCS);
  while (docs.hasNext()) {
    const docFile = docs.next();
    const idleMs = nowMs - docFile.getLastUpdated().getTime();
    if (idleMs < CONFIG.DEBOUNCE_MS) {
      continue;
    }
    const name = docFile.getName();
    try {
      const bodyText = convertGoogleDocToMarkdown_(docFile.getId());
      if (!bodyText || !bodyText.trim()) {
        continue;
      }
      const mdName = sanitizeFilename_(name || "Exportacao_Gemini");
      const finalName = resolveUniqueDriveFilename_(vaultFolder, mdName);
      vaultFolder.createFile(finalName, bodyText, MimeType.PLAIN_TEXT);
      docFile.setTrashed(true);
      Logger.log('GDOC_CONVERTED: "' + name + '" -> "' + finalName + '"');
    } catch (err) {
      Logger.log('GDOC_ERROR (' + name + "): " + err.message);
    }
  }
}

function runCloudOrganizer() {
  const props = PropertiesService.getScriptProperties();
  const apiKeys = getApiKeysPool_(props);
  const rootFolderId = (props.getProperty("OBSIDIAN_FOLDER_ID") || "").trim();

  if (apiKeys.length === 0) {
    throw new Error("Propriedade GEMINI_API_KEYS (ou GEMINI_API_KEY) nao configurada.");
  }

  const vaultFolder = rootFolderId
    ? DriveApp.getFolderById(rootFolderId)
    : findSingleFolderByName_("Obsidian");

  if (!vaultFolder) {
    throw new Error("Pasta raiz do Obsidian nao encontrada. Defina OBSIDIAN_FOLDER_ID.");
  }

  const nowMs = Date.now();
  ingestGeminiExportedDocs_(vaultFolder, nowMs);

  const vaultContext = collectDriveVaultContext_(vaultFolder);
  const files = vaultFolder.getFiles();

  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();

    if (shouldIgnoreRootFile_(name)) {
      continue;
    }

    const updatedMs = file.getLastUpdated().getTime();
    const idleMs = nowMs - updatedMs;

    if (file.getSize() === 0) {
      if (isUntitledFile_(name) && idleMs >= CONFIG.EMPTY_CLEANUP_MS) {
        file.setTrashed(true);
        Logger.log('CLEANUP_0KB: "' + name + '" enviado para a lixeira.');
      }
      continue;
    }

    if (idleMs < CONFIG.DEBOUNCE_MS) {
      Logger.log('DEBOUNCE: "' + name + '" modificado recentemente; aguardando 60s.');
      continue;
    }

    const rawContent = file.getBlob().getDataAsString("UTF-8");
    if (!rawContent || !rawContent.trim()) {
      continue;
    }

    try {
      const createdDate = file.getDateCreated();
      const nowDate = new Date(nowMs);
      const response = callGeminiWithFailover_(apiKeys, {
        originalFilename: name,
        rawContent: rawContent,
        createdStr: formatDateTime_(createdDate),
        updatedStr: formatDateTime_(nowDate),
        vaultContext: vaultContext,
      });

      const ops = Array.isArray(response.operations) ? response.operations : [];
      if (ops.length === 0) {
        throw new Error("Resposta Gemini V4 sem operacoes validas.");
      }

      for (let i = 0; i < ops.length; i++) {
        executeDriveOperation_(vaultFolder, vaultContext, ops[i], name, rawContent, createdDate, nowDate);
      }

      file.setTrashed(true);
      Logger.log('PROCESSED_V4: "' + name + '" (' + ops.length + " operacoes executadas)");
    } catch (err) {
      Logger.log('ORGANIZE_ERROR (' + name + "): " + err.message);
    }
  }
}

function executeDriveOperation_(vaultFolder, vaultContext, op, originalName, rawContent, createdDate, nowDate) {
  if (op.action === "SKIP_DUPLICATE") {
    Logger.log('SKIP_DUPLICATE (' + originalName + "): " + (op.target_path || ""));
    return;
  }

  if (op.action === "APPEND_TO_EXISTING" || op.action === "UPDATE_SECTION_IN_EXISTING") {
    const targetFile = vaultContext.fileMap[op.target_path];
    if (targetFile && op.content_markdown) {
      const existingContent = targetFile.getBlob().getDataAsString("UTF-8");
      const merged = mergeIntoExistingDriveNote_(
        existingContent,
        op.content_markdown,
        nowDate
      );
      targetFile.setContent(merged);
      Logger.log(op.action + ': "' + originalName + '" -> "' + op.target_path + '"');
      return;
    }
  }

  const baseName = originalName.replace(/\.(md|txt)$/i, "");
  const fm = op.frontmatter || {
    title: baseName,
    aliases: [baseName],
    tags: ["nota"],
    created: formatDateTime_(createdDate),
    updated: formatDateTime_(nowDate),
    category: "pessoal_vida",
    status: "ativo",
  };
  const targetPath = resolveTargetFolder_(op.target_path, fm.category, vaultContext.folders);
  const destFolder = vaultContext.folderMap[targetPath] || ensureFolderPath_(vaultFolder, targetPath);
  const cleanName = sanitizeFilename_(op.suggested_filename || fm.title);
  const finalName = resolveUniqueDriveFilename_(destFolder, cleanName);
  const finalContent = serializeMarkdownNote_(fm, op.content_markdown || rawContent, createdDate, nowDate);

  destFolder.createFile(finalName, finalContent, MimeType.PLAIN_TEXT);
  Logger.log('CREATE_NEW: "' + originalName + '" -> "' + targetPath + "/" + finalName + '"');
}

function callGeminiWithFailover_(apiKeys, params) {
  let lastErr = null;
  for (let k = 0; k < apiKeys.length; k++) {
    try {
      return callGeminiModelsWithFallback_(apiKeys[k], params);
    } catch (err) {
      lastErr = err;
      const msg = String(err && err.message ? err.message : err);
      const shouldRotateKey =
        msg.indexOf("429") !== -1 ||
        msg.indexOf("500") !== -1 ||
        msg.indexOf("503") !== -1 ||
        msg.indexOf("RESOURCE_EXHAUSTED") !== -1 ||
        msg.indexOf("API_KEY_INVALID") !== -1;

      if (shouldRotateKey && k + 1 < apiKeys.length) {
        Logger.log("Key #" + (k + 1) + " falhou (" + msg + "). Key #" + (k + 2) + " activated");
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("Todas as chaves Gemini falharam.");
}

function callGeminiModelsWithFallback_(apiKey, params) {
  let lastModelErr = null;
  for (let m = 0; m < CONFIG.GEMINI_MODELS.length; m++) {
    const model = CONFIG.GEMINI_MODELS[m];
    try {
      return callGeminiGenerateContent_(apiKey, model, params);
    } catch (err) {
      lastModelErr = err;
      const msg = String(err && err.message ? err.message : err).toLowerCase();
      const isModelIssue =
        msg.indexOf("404") !== -1 ||
        msg.indexOf("403") !== -1 ||
        msg.indexOf("429") !== -1 ||
        msg.indexOf("not found") !== -1;
      if (isModelIssue && m + 1 < CONFIG.GEMINI_MODELS.length) {
        Logger.log('MODEL_FALLBACK: Modelo "' + model + '" indisponivel/limitado. Tentando ' + CONFIG.GEMINI_MODELS[m + 1]);
        continue;
      }
      throw err;
    }
  }
  throw lastModelErr || new Error("Nenhum modelo Gemini disponivel.");
}

function callGeminiGenerateContent_(apiKey, model, params) {
  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent";

  const systemInstruction = [
    "Voce e o Autonomous Evolving Second Brain Engine (V5) do cofre Obsidian.",
    "Fatie textos multi-assunto em operations[] (APPEND_TO_EXISTING, UPDATE_SECTION_IN_EXISTING, CREATE_NEW ou SKIP_DUPLICATE).",
    "NUNCA salve dialogos 'prompt:/resposta:' (CHAT_DISTILLER) nem fragmente em micro-notas.",
    "Pessoas recebem ficha individual em 01_Pessoas/<Nome>.md + 01_Pessoas/00_Mapa_de_Pessoas.md. Todo bloco deve ter carimbo `📅 DD/MM/YYYY HH:mm`.",
    "Os 5 pilares ativos sao: 01_Pessoas, 02_Projetos_e_Negocios, 03_Faculdade_e_Estudos, 04_Padroes_e_Prompts, 05_Pessoal_e_Vida.",
  ].join("\n");

  const prompt = [
    "Arquivo original: " + params.originalFilename,
    "created: " + params.createdStr,
    "updated: " + params.updatedStr,
    "",
    "Pastas existentes:",
    params.vaultContext.folders.map((f) => "- " + f).join("\n"),
    "",
    "Notas existentes (JSON compacto):",
    JSON.stringify(params.vaultContext.summaries),
    "",
    "Conteudo bruto:",
    "<<<NOTA_BRUTA>>>",
    params.rawContent,
    "<<<FIM_NOTA_BRUTA>>>",
  ].join("\n");

  const responseJsonSchema = {
    type: "object",
    properties: {
      operations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["APPEND_TO_EXISTING", "UPDATE_SECTION_IN_EXISTING", "CREATE_NEW", "SKIP_DUPLICATE"],
            },
            target_path: { type: "string" },
            section_heading: { type: "string" },
            content_markdown: { type: "string" },
            suggested_filename: { type: "string" },
            frontmatter: {
              type: "object",
              properties: {
                title: { type: "string" },
                aliases: { type: "array", items: { type: "string" } },
                tags: { type: "array", items: { type: "string" } },
                created: { type: "string" },
                updated: { type: "string" },
                category: {
                  type: "string",
                  enum: ["pessoas", "projetos_negocios", "faculdade_estudos", "padroes_prompts", "pessoal_vida"],
                },
                status: { type: "string", enum: ["rascunho", "ativo", "referencia", "arquivado"] },
              },
              required: ["title", "aliases", "tags", "created", "updated", "category", "status"],
            },
            duplicate_reason: { type: "string" },
          },
          required: ["action", "target_path"],
        },
      },
    },
    required: ["operations"],
  };

  const payload = {
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: responseJsonSchema,
    },
  };

  const response = UrlFetchApp.fetch(endpoint, {
    method: "post",
    contentType: "application/json",
    headers: { "x-goog-api-key": apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  const bodyText = response.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error("Gemini HTTP " + code + ": " + bodyText);
  }

  const parsed = JSON.parse(bodyText);
  const candidates = parsed && Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const firstParts =
    candidates[0] && candidates[0].content && Array.isArray(candidates[0].content.parts)
      ? candidates[0].content.parts
      : [];
  const outputText = firstParts.map((p) => p.text || "").join("");

  if (!outputText) {
    throw new Error("Resposta da Gemini API sem texto em candidates.");
  }
  return JSON.parse(outputText);
}

function collectDriveVaultContext_(vaultFolder) {
  const summaries = [];
  const folderMap = {};
  const fileMap = {};
  const folders = [];

  function walk(folder, relPath) {
    folderMap[relPath] = folder;
    folders.push(relPath);

    const files = folder.getFiles();
    while (files.hasNext()) {
      const f = files.next();
      const name = f.getName();
      if (!name.startsWith(".") && name.toLowerCase().endsWith(".md")) {
        const relFile = relPath + "/" + name;
        fileMap[relFile] = f;
        summaries.push({ path: relFile, title: name.slice(0, -3) });
      }
    }

    const subFolders = folder.getFolders();
    while (subFolders.hasNext()) {
      const sub = subFolders.next();
      if (!sub.getName().startsWith(".")) {
        walk(sub, relPath + "/" + sub.getName());
      }
    }
  }

  for (let i = 0; i < CONFIG.ROOT_FOLDERS.length; i++) {
    const rootName = CONFIG.ROOT_FOLDERS[i];
    const iter = vaultFolder.getFoldersByName(rootName);
    if (iter.hasNext()) {
      walk(iter.next(), rootName);
    } else {
      folders.push(rootName);
    }
  }

  return {
    summaries: summaries,
    folders: folders.sort(),
    folderMap: folderMap,
    fileMap: fileMap,
  };
}

function mergeIntoExistingDriveNote_(existingContent, appendSectionMarkdown, updatedAt) {
  const updatedStr = formatDateTime_(updatedAt);
  let result = existingContent;
  if (/^---\r?\n[\s\S]*?\r?\n---/.test(result)) {
    if (/^updated:\s*.+$/m.test(result)) {
      result = result.replace(/^updated:\s*.+$/m, "updated: " + updatedStr);
    } else {
      result = result.replace(/\r?\n---/, "\nupdated: " + updatedStr + "\n---");
    }
  }
  const footerMatch = result.match(/\r?\n---\r?\n+(?:##\s+(?:🔗\s*)?Conexões Relacionadas|\*\*Links Relacionados:\*\*)/i);
  if (footerMatch && footerMatch.index !== undefined) {
    const before = result.slice(0, footerMatch.index).trimEnd();
    const footer = result.slice(footerMatch.index).trimStart();
    return before + "\n\n" + appendSectionMarkdown.trim() + "\n\n" + footer + "\n";
  }
  return result.trimEnd() + "\n\n" + appendSectionMarkdown.trim() + "\n";
}

function shouldIgnoreRootFile_(filename) {
  const lower = filename.toLowerCase();
  if ((!lower.endsWith(".md") && !lower.endsWith(".txt")) || filename.startsWith(".")) {
    return true;
  }
  if (CONFIG.IGNORED_FILES.indexOf(lower) !== -1) {
    return true;
  }
  return /^(~\$|\.~\$)/.test(filename) || /\.(tmp|part|crdownload)$/i.test(filename);
}

function isUntitledFile_(filename) {
  return /^sem\s+t[ií]tulo(?:\s+\d+)?\.(md|txt)$/i.test(filename.trim());
}

function sanitizeFilename_(rawName) {
  const withoutExt = String(rawName || "").trim().replace(/\.(md|txt)$/i, "");
  const cleaned = withoutExt
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  const base = (cleaned || "Nota Organizada").slice(0, 120).replace(/[. ]+$/g, "").trim();
  return (base || "Nota Organizada") + ".md";
}

function resolveTargetFolder_(requested, category, allowedFolders) {
  const norm = String(requested || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  for (let i = 0; i < allowedFolders.length; i++) {
    if (allowedFolders[i].toLowerCase() === norm.toLowerCase()) {
      return allowedFolders[i];
    }
  }
  const fallback = {
    pessoas: "01_Pessoas",
    projetos_negocios: "02_Projetos_e_Negocios",
    faculdade_estudos: "03_Faculdade_e_Estudos",
    padroes_prompts: "04_Padroes_e_Prompts",
    pessoal_vida: "05_Pessoal_e_Vida",
  };
  return fallback[category] || "05_Pessoal_e_Vida";
}

function resolveUniqueDriveFilename_(folder, filename) {
  const stem = filename.slice(0, -3);
  let candidate = filename;
  let counter = 2;
  while (folder.getFilesByName(candidate).hasNext()) {
    candidate = stem + " (" + counter + ").md";
    counter += 1;
  }
  return candidate;
}

function ensureFolderPath_(rootFolder, relPath) {
  const parts = relPath.split("/");
  let current = rootFolder;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const iter = current.getFoldersByName(part);
    current = iter.hasNext() ? iter.next() : current.createFolder(part);
  }
  return current;
}

function findSingleFolderByName_(name) {
  const iter = DriveApp.getFoldersByName(name);
  return iter.hasNext() ? iter.next() : null;
}

function normalizeTag_(tag) {
  return String(tag || "")
    .trim()
    .replace(/^#+/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function formatDateTime_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm");
}

function escapeYaml_(val) {
  return '"' + String(val || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ") + '"';
}

function serializeMarkdownNote_(fm, formattedBody, createdDate, updatedDate) {
  const aliases = (fm.aliases || []).slice(0, 5);
  const tags = (fm.tags || []).map(normalizeTag_).filter(Boolean).slice(0, 8);
  const finalAliases = aliases.length ? aliases : [fm.title];
  const finalTags = tags.length ? tags : [fm.category, "nota"];

  const lines = [
    "---",
    "title: " + escapeYaml_(fm.title),
    "aliases:",
    finalAliases.map((a) => "  - " + escapeYaml_(a)).join("\n"),
    "tags:",
    finalTags.map((t) => "  - " + t).join("\n"),
    "created: " + formatDateTime_(createdDate),
    "updated: " + formatDateTime_(updatedDate),
    "category: " + fm.category,
    "status: " + fm.status,
    "---",
    "",
    String(formattedBody || "").trim(),
    "",
  ];
  return lines.join("\n");
}
