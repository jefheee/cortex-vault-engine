# PROJECT STATE — Cortex Vault Engine (V6.0)

**Atualizado em:** 2026-11-14  
**Versão:** `6.0.0`  
**Cofre Alvo:** `G:\Meu Drive\Obsidian`

## Arquitetura Atual (V6.0)
- **Cofre:** `G:\Meu Drive\Obsidian` (5 pilares ativos `01_Pessoas`..`05_Pessoal_e_Vida` + `00_Indice_Global_MOC.md` + `00_Dashboard_Principal.md` + `00_Catalogo_Geral.base` + `Recentes.base`).
- **Memória Global Lazy-Loading:** `GEMINI.md` e `.gemini/GEMINI.md` sincronizados e ocultos via `+h` e CSS snippet.
- **Motor Node.js V6.0 (`.automacao/` — repositório Git isolado):**
  - Cadeia oficial Gemini (`src/config.ts`, `src/gemini.ts`): `primary=gemini-2.5-flash`, `heavy=gemini-2.5-pro`, `fast=gemini-2.5-flash-lite` e fallbacks (`gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-2.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-2.0-flash`) com `KeyPool` e cache `zeroQuotaModels`.
  - Chunked Map-Reduce com checkpoint (`> 32.000` chars) e *Section-Aware Wiki-Fold* (`mergeWithExistingNote`), **sem** bypass determinístico em notas extensas.
  - Watcher dual (`src/watcher.ts`): Chokidar `usePolling: true` (`5s` + `awaitWriteFinish`) + scanner ativo `setInterval` (`30s` via `fs.readdir`) + `SerialPromiseQueue`.
  - 12 módulos em `src/lib/` (`unicode.ts`, `fs-retry.ts`, `atomic-write.ts`, `promiseQueue.ts`, `frontmatter.ts`, `wikilinks.ts`, `validate-write.ts`, `memory-similarity.ts`, `memory-supersede.ts`, `memory-write.ts`, `transaction.ts`, `lint-engine.ts`).
  - Transações em `ledger.jsonl`, auditoria `security-check.ts` (`npm run security:check`) e boot Windows (`local_bootstrap.vbs`, `start_hidden.vbs`, `watcher.lock`).

## Verificação V6.0
- `typecheck` + `build`: 0 erros.
- `npm test`: **27/27 testes passando** (6 suítes).
- `npm run security:check`: aprovado (`.git` ausente na raiz do cofre).
- **Prova de Fogo:** **42/42** arquivos pendentes de `00_Inbox_Bruto/` processados pelo daemon real via API Gemini (`0` restantes).
