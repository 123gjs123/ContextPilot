// Markdown mínimo para el chat (sin dependencias y sin HTML crudo: el renderer construye nodos DOM,
// nunca innerHTML). Soporta: bloques de código con lenguaje, títulos, listas (- * 1.), citas,
// separadores, tablas simples y párrafos; en línea: `código`, **negrita**, *cursiva*, [texto](url).

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] };

export type Block =
  | { t: 'code'; lang: string; v: string }
  | { t: 'heading'; level: number; c: Inline[] }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'quote'; c: Inline[] }
  | { t: 'hr' }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'p'; c: Inline[] };

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ t: 'code', v: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'strong', c: parseInline(s.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && s[i + 1] !== ch && s[i + 1] !== ' ') {
      const end = s.indexOf(ch, i + 1);
      const before = i === 0 ? ' ' : s[i - 1]!;
      if (end > i + 1 && /[\s(¿¡"'«]/.test(before)) {
        flush();
        out.push({ t: 'em', c: parseInline(s.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const m = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(s.slice(i));
      if (m) {
        flush();
        out.push({ t: 'link', href: m[2]!, c: parseInline(m[1]!) });
        i += m[0].length;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

const splitRow = (l: string) =>
  l
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => parseInline(c.trim()));

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push({ t: 'p', c: parseInline(para.join('\n')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flushPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      out.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      out.push({ t: 'heading', level: h[1]!.length, c: parseInline(h[2]!) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      out.push({ t: 'hr' });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      flushPara();
      const head = splitRow(line);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(splitRow(lines[i++]!));
      i--;
      out.push({ t: 'table', head, rows });
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const ordered = /\d/.test(li[1]!);
      const items: Inline[][] = [parseInline(li[2]!)];
      while (i + 1 < lines.length) {
        const n = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i + 1]!);
        if (!n || /\d/.test(n[1]!) !== ordered) break;
        items.push(parseInline(n[2]!));
        i++;
      }
      out.push({ t: 'list', ordered, items });
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      out.push({ t: 'quote', c: parseInline(q[1]!) });
      continue;
    }
    para.push(line);
  }
  flushPara();
  return out;
}
