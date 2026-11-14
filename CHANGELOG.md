# Changelog — Obsidian Auto-Organizer

## [6.0.0] — 2026-11-14 (Cortex Vault Engine)
### Adicionado / Refatorado
- **Cadeia Oficial de Modelos Gemini (`src/config.ts`, `src/gemini.ts`, `cloud_drive_organizer.gs`):** Removidos modelos inexistentes/sem cota (`gemini-4-argon`, `gemini-4-hydrogen`, `gemini-3.8-flash`). Configurados `gemini-2.5-flash` (primary/Map), `gemini-2.5-pro` (heavy/Reduce `> 12.000` chars ou chat dump), `gemini-2.5-flash-lite` (fast/subpastas) e fallback oficial (`gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-2.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-2.0-flash`).
- **Remoção do Bypass Determinístico & Coerção Resiliente (`src/organizer.ts`, `src/gemini.ts`):** Eliminado o `READ_BEFORE_WRITE_DETERMINISTIC`; toda nota (inclusive extensas com `> 32.000` chars) passa obrigatoriamente pela API Gemini via Chunked Map-Reduce com checkpoint por parte e Section-Aware *Wiki-Fold*. Adicionada coerção padrão em `FrontmatterSchema` (`aliases`, `tags`) e limite expandido em `MultiOperationsResponseSchema`.
- **Watcher Dual Polling + Active Scan (`src/watcher.ts`):** Chokidar v4 com `usePolling: true` (`interval: 5000ms`, `awaitWriteFinish: 3000ms`) + loop ativo `setInterval` (`30s` usando `fs.readdir`) + varredura imediata no startup em fila serial (`SerialPromiseQueue`), monitorando raiz, `00_Inbox_Bruto/`, `inbox_chats/` e os 5 pilares.
- **Transplante Modular (`src/lib/` — 12 módulos):** Implementados `unicode.ts` (`NFC`), `fs-retry.ts` (`EBUSY`/`EPERM`/`EACCES`), `atomic-write.ts`, `promiseQueue.ts`, `frontmatter.ts`, `wikilinks.ts`, `validate-write.ts`, `memory-similarity.ts`, `memory-supersede.ts`, `memory-write.ts`, `transaction.ts` (`ledger.jsonl` + rollback) e `lint-engine.ts` (`runActiveHygieneAndLint` atualizando `00_Indice_Global_MOC.md` e `00_Dashboard_Principal.md`).
- **Saneamento de Caminhos (`src/vault.ts`):** `resolveTargetFolder()` e `sanitizeFolderSegment()` removem sufixos `.md`/`.txt`/`.gdoc` de `target_path` e `organizer.ts` prioriza metas `00_*` no fluxo imediato.
- **Bases Nativas & Fronteira Git Segura:** Criados `00_Catalogo_Geral.base` e `Recentes.base` na raiz do cofre; repositório Git inicializado exclusivamente em `.automacao/` protegido por `.gitignore`, `README.md` e `src/security-check.ts` (`npm run security:check`).

### Verificado ("Prova de Fogo")
- Suíte de testes automatizados: **27/27 testes passando** em 6 suítes (`npm test`).
- Auditoria de segurança pré-commit (`npm run security:check`): aprovada (`39` arquivos, zero segredos, `.git` ausente na raiz do cofre).
- Execução real do daemon (`PID 12824`) processou **42/42 arquivos** acumulados em `00_Inbox_Bruto/` via API Gemini (`Key #1` e `Key #2`, incluindo Map-Reduce em notas longas), deixando **0 arquivos pendentes** na caixa de entrada.

## [5.3.0] — 2026-11-14

- **Chunked Map-Reduce para Notas Massivas (`src/gemini.ts`):** Arquivos com mais de `32.000` caracteres (`CHUNK_TRIGGER_CHARS`) agora são fatiados de forma determinística via `splitLargeTextIntoChunks()` (`DEFAULT_CHUNK_MAX_CHARS = 28.000`, respeitando fronteiras de linha/cabeçalho) e consolidados por `consolidateChunkOperations()`, evitando timeouts, estouros de TPM e falhas de JSON gigante.
- **Schema Estrito & Normalização (`src/gemini.ts`):** `buildJsonSchema()` passa a exigir `["action", "target_path", "content_markdown"]`, e `OperationSchema` normaliza eventuais aliases `markdown_body` / `content` para `content_markdown`.
- **Cache de Cota Zero (`src/gemini.ts`):** `runPromptWithFallback()` detecta respostas `429` com `limit: 0` por par `${keyNumber}:${model}` em `zeroQuotaModels` e pula imediatamente o modelo sem cota nas chamadas seguintes quando houver fallback válido na cadeia.
- **Bypass Determinístico Read-Before-Write (`src/organizer.ts`):** Entradas/notas existentes extensas (`incomingChars > 24_000 || existingContent.length > 35_000`) registram `READ_BEFORE_WRITE_DETERMINISTIC` e aplicam append/atualização determinística por seção em vez de arriscar truncamento via `mergeWithExistingNote()`.
- **Ponte Google Docs -> Markdown (`cloud_drive_organizer.gs`):** Janela móvel de 48h (`ROOT_LOOKBACK_HOURS = 48`) na raiz do `Meu Drive` sem filtro restritivo de texto de chat nem baseline bloqueante, execução imediata de `syncGeminiDocsToObsidianInbox()` dentro de `setupObsidianGeminiBridge()` e movimentação limpa dos Docs exportados para `Meu Drive/Gemini_Exports_Processados/`.

## [5.2.0] — 2026-11-14
### Adicionado / Melhorado
- **Read-Before-Write Contextual Merge (`organizer.ts` + `gemini.ts`):** Agrupamento de `APPEND_TO_EXISTING` e `UPDATE_SECTION_IN_EXISTING` por arquivo alvo, leitura integral prévia do disco e fusão via `mergeWithExistingNote()` (suporta `NO_OP` sem redundância e guarda anti-truncamento `isSafeMergedContent()`).
- **Mineração de Chats em 2 Frentes (`CHAT_DUMP`):** Prioriza `gemini-4-argon` em dumps de chat, minerando fatos/projetos + DNA comportamental (regras de prompting, preferências técnicas e anti-padrões rejeitados pelo usuário).
- **Carimbos `📅` Não-Redundantes (`vault.ts`):** `ensureInlineDateStamp()` e `stampUserEditedNoteFallback()` ignoram linhas que já contêm a data `DD/MM/YYYY` ou `📅`, além de `# H1`, tabelas e blocos de código.
- **Blindagem de Boot (`start_hidden.vbs`, `local_bootstrap.vbs`, `install_startup.bat`):** Modo `On Error Resume Next`, guarda WMI contra duplo `watcher.js`, invocação via `wscript.exe //B` e limpeza UAC da tarefa legada `\ObsidianAutoOrganizer`.
- **Ponte Zero-Atrito Gemini -> `.gdoc` -> Obsidian (`cloud_drive_organizer.gs` + `vault.ts`):** Tratamento silencioso de atalhos virtuais `EISDIR` (`GDOC_AWAITING_BRIDGE`) no daemon local e ponte Apps Script `setupObsidianGeminiBridge()` / `syncGeminiDocsToObsidianInbox()` convertendo Google Docs para `.md` em `00_Inbox_Bruto/`.

## [5.1.0] — 2026-11-14
### Alterado
- **Migração Gemini 4 & Gemini 3 Stable:** Removidos completamente os modelos depreciados da família 2.x (`gemini-2.0-flash`, `gemini-2.5-flash`, `gemini-2.5-pro`) de `.env`, `.env.example`, `config.ts`, `gemini.ts`, `cloud_drive_organizer.gs` e `organizer.test.ts`.
- **Tiered Model Routing (`config.ts` / `gemini.ts`):**
  - `GEMINI_MODEL_HEAVY="gemini-4-argon"` para entradas `> 12.000` caracteres.
  - `GEMINI_MODEL_PRIMARY="gemini-4-hydrogen"` para ingestão padrão na raiz e `00_Inbox_Bruto/`.
  - `GEMINI_MODEL_FAST="gemini-3.8-flash"` para `refineExistingNote()` em edições nas subpastas.
  - Cadeia universal de fallback: `gemini-4-hydrogen`, `gemini-3.8-flash`, `gemini-4-argon`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`.
- **Compatibilidade Híbrida (`gemini.ts`):** Chamada resiliente via `client.interactions.create` com fallback transparente para `client.models.generateContent`, além de fallback por modelo em `403`/`404`/`429` e log explícito `[OK] Processed (...) via model=... (Key #...)`.
- **Cloud Script (`cloud_drive_organizer.gs`):** Atualizado `CONFIG.GEMINI_MODELS` para `["gemini-4-hydrogen", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"]`.

## [5.0.0] — 2026-11-14
- Reestruturação de `01_Pessoas/` em fichas individuais + `00_Mapa_de_Pessoas.md`.
- Carimbos inline `📅 DD/MM/YYYY HH:mm`, extração de data histórica `_YYMMDD_HHMMSS.txt`, exclusão automática de notas vazias (`60s` -> `.automacao/trash/`) e monitoramento de subpastas (`90s`) com guarda anti-loop SHA-256.
- Suporte a `00_Inbox_Bruto/`, leitor `.gdoc` e inicialização desacoplada via `Win32_Process.Create`.
