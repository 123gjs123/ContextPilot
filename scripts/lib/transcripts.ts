// Descubrimiento de transcripts de Claude Code en disco (compartido por replay-transcripts y
// snapshot-fixtures). Estructura real:
//   <projects>/<proyecto>/<sessionId>.jsonl                      hilo principal
//   <projects>/<proyecto>/<sessionId>/subagents/agent-<id>.jsonl  subagentes (sidechain)
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export interface TranscriptSet {
  /** Archivo principal de la sesión. */
  main: string;
  sessionId: string;
  /** Archivos de subagentes de esa sesión (puede estar vacío). */
  subagents: string[];
  mtimeMs: number;
  size: number;
}

/** Carpeta de proyectos de Claude Code (mismas variables que el daemon, INSTALL.md §2). */
export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CONTEXTPILOT_CLAUDE_PROJECTS) return env.CONTEXTPILOT_CLAUDE_PROJECTS;
  const base = env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return join(base, 'projects');
}

function safeDir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

/** Lista las sesiones (principal + subagentes) ordenadas de la más reciente a la más vieja. */
export function listTranscriptSets(root = claudeProjectsDir()): TranscriptSet[] {
  const out: TranscriptSet[] = [];
  for (const proj of safeDir(root)) {
    const pdir = join(root, proj);
    for (const f of safeDir(pdir)) {
      if (!f.endsWith('.jsonl')) continue;
      const main = join(pdir, f);
      let st;
      try {
        st = statSync(main);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const sessionId = f.slice(0, -'.jsonl'.length);
      const subDir = join(pdir, sessionId, 'subagents');
      const subagents = existsSync(subDir)
        ? safeDir(subDir)
            .filter((x) => x.endsWith('.jsonl'))
            .map((x) => join(subDir, x))
            .sort()
        : [];
      out.push({ main, sessionId, subagents, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Si el archivo es `<sesión>/subagents/*.jsonl`, devuelve el id de la sesión padre. */
export function subagentParent(file: string): string | undefined {
  const dir = dirname(file);
  if (basename(dir) !== 'subagents') return undefined;
  return basename(dirname(dir));
}
