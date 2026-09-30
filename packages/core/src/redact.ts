// RNF-02: redacción de secretos antes de persistir o embeber.

const PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED:anthropic-key]'],
  [/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED:openai-key]'],
  [/AIza[0-9A-Za-z_-]{35}/g, '[REDACTED:google-key]'],
  [/gh[pousr]_[A-Za-z0-9]{36,}/g, '[REDACTED:github-token]'],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED:aws-key]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED:jwt]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  [/(bearer\s+)[A-Za-z0-9._-]{16,}/gi, '$1[REDACTED:bearer]'],
  [/((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*)(["']?)[^\s"']{4,}\2/gi, '$1$2[REDACTED]$2'],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
