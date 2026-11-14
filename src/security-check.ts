import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTOMACAO_DIR = path.resolve(__dirname, "..");
const VAULT_ROOT = path.resolve(AUTOMACAO_DIR, "..");

const REQUIRED_GITIGNORE_RULES = [
  ".env",
  ".env.*",
  "!.env.example",
  "*.log",
  "*.lock",
  "state*.json",
  "hashes*.json",
  "sticky-imported.json",
  "vault-index.json",
  "ledger*.jsonl",
  "checkpoints/",
  ".tmp/",
  "processed_archive/",
  "trash/",
  "inbox_chats/",
  "node_modules/",
  "dist/",
];

const FORBIDDEN_TRACKED_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /\.log$/i,
  /\.lock$/i,
  /^sticky-imported\.json$/i,
  /^vault-index\.json$/i,
  /^ledger.*\.jsonl$/i,
  /^processed_archive\//i,
  /^trash\//i,
  /^inbox_chats\//i,
  /^checkpoints\//i,
  /^\.tmp\//i,
];

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "Google/Gemini API Key", regex: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "OpenAI/Stripe Secret Key", regex: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "GitHub Classic Token", regex: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { name: "GitHub Fine-Grained Token", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "JWT Token", regex: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "Private Key Block", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
];

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const failures: string[] = [];

  // 1. Garante que NAO existe .git na raiz do cofre (G:\Meu Drive\Obsidian\.git)
  const parentGitDir = path.join(VAULT_ROOT, ".git");
  if (await pathExists(parentGitDir)) {
    failures.push(`CRITICO: Encontrado .git proibido na raiz do cofre: ${parentGitDir}`);
  }

  // 2. Valida .gitignore em .automacao
  const gitignorePath = path.join(AUTOMACAO_DIR, ".gitignore");
  if (!(await pathExists(gitignorePath))) {
    failures.push(".gitignore ausente em .automacao/");
  } else {
    const gitignoreRaw = await fs.readFile(gitignorePath, "utf8");
    const lines = new Set(
      gitignoreRaw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#")),
    );
    for (const rule of REQUIRED_GITIGNORE_RULES) {
      if (!lines.has(rule)) {
        failures.push(`Regra obrigatoria ausente no .gitignore: ${rule}`);
      }
    }
  }

  // 3. Coleta arquivos candidatos a commit/repositorio (git ls-files se repo existir + src/test/config)
  const candidateFiles = new Set<string>();
  const automacaoGitDir = path.join(AUTOMACAO_DIR, ".git");
  if (await pathExists(automacaoGitDir)) {
    try {
      const tracked = execFileSync("git", ["ls-files"], {
        cwd: AUTOMACAO_DIR,
        encoding: "utf8",
        windowsHide: true,
      });
      const untrackedAllowed = execFileSync(
        "git",
        ["ls-files", "--others", "--exclude-standard"],
        {
          cwd: AUTOMACAO_DIR,
          encoding: "utf8",
          windowsHide: true,
        },
      );

      for (const rel of [...tracked.split(/\r?\n/), ...untrackedAllowed.split(/\r?\n/)]) {
        const clean = rel.trim().replace(/\\/g, "/");
        if (!clean) continue;
        if (clean === ".env.example") {
          candidateFiles.add(clean);
          continue;
        }
        if (FORBIDDEN_TRACKED_PATTERNS.some((p) => p.test(clean))) {
          failures.push(`Arquivo sensivel/runtime exposto no Git: ${clean}`);
          continue;
        }
        candidateFiles.add(clean);
      }
    } catch (err: unknown) {
      failures.push(
        `Falha ao inspecionar git ls-files: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const dirName of ["src", "test"]) {
    const absDir = path.join(AUTOMACAO_DIR, dirName);
    if (await pathExists(absDir)) {
      const walk = async (cur: string): Promise<void> => {
        const entries = await fs.readdir(cur, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(cur, e.name);
          if (e.isDirectory()) {
            await walk(full);
          } else if (e.isFile()) {
            candidateFiles.add(path.relative(AUTOMACAO_DIR, full).replace(/\\/g, "/"));
          }
        }
      };
      await walk(absDir);
    }
  }

  for (const rootFile of ["package.json", ".env.example", "README.md", "cloud_drive_organizer.gs"]) {
    if (await pathExists(path.join(AUTOMACAO_DIR, rootFile))) {
      candidateFiles.add(rootFile);
    }
  }

  // 4. Varredura de segredos em todos os arquivos rastreaveis
  for (const rel of candidateFiles) {
    const abs = path.join(AUTOMACAO_DIR, rel);
    let text: string;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }

    for (const { name, regex } of SECRET_PATTERNS) {
      regex.lastIndex = 0;
      const match = regex.exec(text);
      if (match) {
        // Permite regex literal no proprio security-check.ts ou fixtures sinteticos de teste se explicitamente falsos
        if (rel === "src/security-check.ts") continue;
        failures.push(`Possivel vazamento de ${name} detectado em ${rel}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error("❌ SECURITY CHECK FALHOU:");
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }

  console.log(
    `✅ SECURITY CHECK OK: ${candidateFiles.size} arquivos auditados, .git ausente na raiz do cofre e zero segredos expostos.`,
  );
}

void main();
