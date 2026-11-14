# Project State — Cortex Vault Engine (V6.0)

**Atualizado em:** 2026-11-14  
**Versão:** `6.0.0`  
**Cofre Alvo:** `G:\Meu Drive\Obsidian`  
**Repositório Autônomo:** `G:\Meu Drive\Obsidian\.automacao` (fronteira *Product-Vault* blindada — sem `.git` na raiz do cofre)

## Arquitetura Core V6.0 (Cortex Vault Engine)
- **Modelos Oficiais Gemini & Tiered Routing (`src/config.ts`, `src/gemini.ts`):**
  - **Primary (Ingestão / Map):** `gemini-2.5-flash`
  - **Heavy (`> 12.000` chars ou `CHAT_DUMP` / Síntese):** `gemini-2.5-pro` (fallback imediato para `gemini-2.5-flash` -> `gemini-2.5-flash-lite`)
  - **Fast (`refineExistingNote` incremental em subpastas):** `gemini-2.5-flash-lite`
  - **Cadeia Universal de Fallback (`FALLBACK_MODELS`):**
    `["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.0-flash"]`
  - **Execução Híbrida & Coerção Estrita:** Suporta `client.interactions.create` + fallback transparente para `client.models.generateContent`, `KeyPool` multi-chave com rotação automática e cache `zeroQuotaModels`, além de coerção resiliente via `FrontmatterSchema` (`aliases` default `[title]`, `tags` default `["nota"]`) e `MultiOperationsResponseSchema` (`.max(120)`).
- **Pipeline Map-Reduce + Section-Aware Wiki-Fold (Sem Bypass Determinístico):**
  - Entradas extensas (`> 32.000` chars / `CHUNK_TRIGGER_CHARS`) passam obrigatoriamente por `splitLargeTextIntoChunks()` (`DEFAULT_CHUNK_MAX_CHARS = 28.000`), processamento serial por chunk via Gemini API com *checkpointing* em `.automacao/checkpoints/` e consolidação via `consolidateChunkOperations()`.
  - Atualizações em notas existentes enviam os cabeçalhos (`## Seção`) e aplicam fusão cirúrgica via `mergeWithExistingNote()` (*Wiki-Fold* `UPDATE` / `NO_OP`) com guarda anti-truncamento (`isSafeMergedContent()` executada antes da aplicação de metadados `recordSupersedeMetadata()`).
- **Watcher Resiliente ao Google Drive Desktop (`src/watcher.ts`, `src/organizer.ts`):**
  - Monitora explicitamente `G:\Meu Drive\Obsidian`, `00_Inbox_Bruto/`, `.automacao/inbox_chats/` e os 5 pilares (`01_Pessoas`..`05_Pessoal_e_Vida`).
  - Chokidar v4 com `usePolling: true` (`pollIntervalMs = 5000`, `awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 }`) **combinado** com loop ativo `setInterval` (`activeScanIntervalMs = 30000`) executando `fs.readdir` + varredura imediata no startup via `SerialPromiseQueue`.
  - `resolveTargetFolder()` e `sanitizeFolderSegment()` em `src/vault.ts` normalizam nomes de diretórios e removem eventuais sufixos `.md`/`.txt`/`.gdoc` de `target_path`.

## Módulos Transplantados (`src/lib/`)
1. `unicode.ts` — Normalização Unicode `NFC` (`normalizeNFC`, `normalizeVaultPath`, `normalizeWikilinkTarget`, `portableIdentityKey`).
2. `fs-retry.ts` — Retry com backoff exponencial (`withFsRetry`) contra locks `EBUSY`/`EPERM`/`EACCES` do Google Drive Desktop.
3. `atomic-write.ts` — Escrita atômica com arquivo temporário em `.automacao/.tmp/` + rename e leitura segura (`atomicWriteFile`, `readFileWithRetry`).
4. `promiseQueue.ts` — `SerialPromiseQueue` para enfileiramento serial de varreduras e respeito aos limites de RPM/TPM.
5. `frontmatter.ts`, `wikilinks.ts`, `validate-write.ts` — Parser/serializador YAML canonizado, extração/normalização de `[[Wikilinks]]` e validação pré-escrita (`validateNoteBeforeWrite`).
6. `memory-similarity.ts`, `memory-supersede.ts`, `memory-write.ts` — Busca por similaridade Jaccard/stemming (`findSimilarExistingNote`, `DUPLICATE_NOTE_THRESHOLD = 0.62`), rastreio `recordSupersedeMetadata` e preparação canônica (`prepareCanonicalNoteWrite`).
7. `transaction.ts` — `TransactionManager` com histórico `.automacao/ledger.jsonl` e rollback transacional por operação.
8. `lint-engine.ts` — `runActiveHygieneAndLint` para reparo de wikilinks quebrados, auditoria de órfãs e atualização automática de `00_Indice_Global_MOC.md` e `00_Dashboard_Principal.md`.

## Bases Nativas, Ponte Drive & Segurança Git
- **Obsidian Bases (`.base`) na raiz do cofre:** `00_Catalogo_Geral.base` e `Recentes.base`.
- **Ponte Google Docs -> Inbox (`cloud_drive_organizer.gs`):** Alinhada aos modelos oficiais (`gemini-2.5-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-2.5-flash-lite`), janelamento de 48h na raiz do Drive e arquivamento em `Gemini_Exports_Processados/`.
- **Segurança & Repositório (`src/security-check.ts`, `.gitignore`, `README.md`):** Repositório `.git` restrito a `G:\Meu Drive\Obsidian\.automacao`; auditoria `npm run security:check` valida `.gitignore`, ausência de `.git` no cofre pai e bloqueia exposição de credenciais/runtime (`39` arquivos rastreáveis auditados).

## Estado Verificado (Prova de Fogo V6.0)
- `npm run typecheck`: OK (0 erros).
- `npm test`: **27/27 testes passando** em 6 suítes (`test/organizer.test.ts`).
- `npm run security:check`: OK (`0` segredos ou artefatos sensíveis expostos, `.git` ausente na raiz do cofre).
- **Prova de Fogo Real (`PID 12824`):** **42/42 arquivos** de `00_Inbox_Bruto/` processados via API do Gemini (`Key #1` e `Key #2`, com Chunked Map-Reduce ativo nas notas extensas) e arquivados em `.automacao/processed_archive/`, deixando `0` arquivos pendentes em `00_Inbox_Bruto/`.
