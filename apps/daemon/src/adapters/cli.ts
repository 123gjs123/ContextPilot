import { homedir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { ClaudeCodeParser, CodexParser, codexSessionIdFromPath } from '@contextpilot/core';
import { JsonlAdapter, type JsonlAdapterOptions } from './jsonl.js';

// RF-CAP-01 (Claude Code) y RF-CAP-03 (Codex): adaptadores sobre JsonlAdapter.

type Common = Pick<JsonlAdapterOptions, 'recentMs' | 'pipeline' | 'storage' | 'health' | 'log' | 'rescanMs' | 'rootRetryMs'>;

export function defaultClaudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CONTEXTPILOT_CLAUDE_PROJECTS) return env.CONTEXTPILOT_CLAUDE_PROJECTS;
  const cfg = env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return join(cfg, 'projects');
}

export function defaultCodexSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CONTEXTPILOT_CODEX_SESSIONS) return env.CONTEXTPILOT_CODEX_SESSIONS;
  return join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
}

/** Clasifica una ruta bajo projects/: transcript principal o de subagente. */
export function classifyClaudeFile(
  root: string,
  file: string,
): { kind: 'main'; sessionId: string; project: string } | { kind: 'sub'; parentSessionId: string; project: string } | null {
  if (!file.endsWith('.jsonl')) return null;
  const parts = relative(root, file).split(sep);
  if (parts.some((p) => p === '..')) return null;
  if (parts.length === 2) return { kind: 'main', sessionId: basename(parts[1]!, '.jsonl'), project: parts[0]! };
  if (parts.length === 4 && parts[2] === 'subagents') return { kind: 'sub', parentSessionId: parts[1]!, project: parts[0]! };
  return null;
}

export function createClaudeCodeAdapter(o: Common & { root: string; ignoreProjects?: string[] }): JsonlAdapter {
  const ignore = new Set((o.ignoreProjects ?? []).map((p) => p.toLowerCase()));
  const cls = (f: string) => {
    const c = classifyClaudeFile(o.root, f);
    return c && !ignore.has(c.project.toLowerCase()) ? c : null;
  };
  return new JsonlAdapter({
    ...o,
    name: 'claude-code',
    match: (f) => cls(f) !== null,
    parserFor: (f) => {
      const c = cls(f);
      if (!c) return null;
      // D «subagentes»: se atribuyen a la sesión padre.
      return c.kind === 'sub' ? new ClaudeCodeParser({ parentSessionId: c.parentSessionId, sidechain: true }) : new ClaudeCodeParser();
    },
    sessionIdFor: (f) => {
      const c = cls(f);
      return c?.kind === 'main' ? c.sessionId : null;
    },
  });
}

export function createCodexAdapter(o: Common & { root: string }): JsonlAdapter {
  return new JsonlAdapter({
    ...o,
    name: 'codex',
    match: (f) => /^rollout-.*\.jsonl$/.test(basename(f)),
    // API.md: sessionId de Codex = id del archivo de sesión.
    parserFor: (f) => new CodexParser({ sessionId: codexSessionIdFromPath(f) }),
    sessionIdFor: (f) => codexSessionIdFromPath(f),
  });
}
