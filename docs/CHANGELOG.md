# CHANGELOG

## [6.0.0] — 2026-11-14 (Cortex Vault Engine)
- **Arquivos afetados:** `.automacao/src/config.ts`, `.automacao/src/gemini.ts`, `.automacao/src/organizer.ts`, `.automacao/src/watcher.ts`, `.automacao/src/vault.ts`, `.automacao/src/lib/*.ts` (12 módulos), `.automacao/src/security-check.ts`, `.automacao/test/organizer.test.ts`, `.automacao/cloud_drive_organizer.gs`, `.automacao/.gitignore`, `.automacao/README.md`, `00_Catalogo_Geral.base`, `Recentes.base`, `00_Indice_Global_MOC.md`, `00_Dashboard_Principal.md`, `GEMINI.md`, `.gemini/GEMINI.md`.
- **Objetivo:** Correção crítica do watcher para Google Drive Desktop (`usePolling` + active `readdir` scan), adoção estrita da cadeia oficial Gemini (`gemini-2.5-flash` / `gemini-2.5-pro` / `gemini-2.5-flash-lite` + fallbacks), remoção do bypass determinístico em favor de Chunked Map-Reduce + Section-Aware Wiki-Fold, transplante dos 12 módulos `src/lib/`, transações em `ledger.jsonl`, Bases `.base`, isolamento Git exclusivo em `.automacao/` com `security-check.ts` e Prova de Fogo drenando **42/42** arquivos de `00_Inbox_Bruto/` (`0` pendentes).

## [2026-11-14] - Upgrade V3: Autonomous Evolving Second Brain & Performance Engine
- **Arquivos afetados:** `05_Pessoal_e_Vida/00_Perfil_Mestre_Jefherson.md`, `02_Projetos_e_Negocios/Sistemas_e_SaaS/Catálogo de Projetos e Repositórios.md`, `GEMINI.md`, `.automacao/src/*`, `.automacao/test/organizer.test.ts`, `.automacao/local_bootstrap.vbs`, `.automacao/install_startup.bat`, `.automacao/uninstall_startup.bat`, `.automacao/link_global_memory.bat`.
- **Objetivo:** Perfil Mestre completo e evolutivo (`EVOLVE_PROFILE` + `inbox_chats/`), cache incremental (`vault-index.json`), filtro Top-K (`O(1)` tokens), `GEMINI.md` Lazy-Loading <= 50 linhas, boot no Windows sem Admin com wait-loop para `G:\` e PID lockfile (`watcher.lock`).

## [2026-11-14] - Upgrade V2: Smart Second Brain Engine
- **Arquivos afetados:** `.automacao/.env`, `.automacao/.env.example`, `.automacao/src/*`, `.automacao/test/organizer.test.ts`, `.automacao/cloud_drive_organizer.gs`, `.automacao/link_global_memory.bat`, `.obsidian/graph.json`, `GEMINI.md`, `05_Pessoal_e_Vida/00_Perfil_Mestre_Jefherson.md`.
- **Objetivo:** Pool de 5 chaves com failover, Retry Queue offline, Smart Merge, 6 pilares semânticos e ponte global.
