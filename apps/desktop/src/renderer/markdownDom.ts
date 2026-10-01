import { parseMarkdown, type Block, type Inline } from '../shared/markdown.js';
import { h } from './dom.js';

// Markdown → nodos DOM (todo el texto por textContent; nunca innerHTML).

function inline(nodes: Inline[]): (Node | string)[] {
  return nodes.map((n) => {
    switch (n.t) {
      case 'text':
        return n.v;
      case 'code':
        return h('code', {}, n.v);
      case 'strong':
        return h('strong', {}, ...inline(n.c));
      case 'em':
        return h('em', {}, ...inline(n.c));
      case 'link':
        return h('a', { href: n.href, title: n.href, target: '_blank', rel: 'noreferrer noopener' }, ...inline(n.c));
    }
  });
}

function block(b: Block): HTMLElement {
  switch (b.t) {
    case 'code':
      return h('pre', { class: 'md-code', 'data-lang': b.lang || undefined }, h('code', {}, b.v));
    case 'heading':
      return h(`h${Math.min(6, b.level + 2)}` as 'h3', { class: 'md-h' }, ...inline(b.c));
    case 'list':
      return h(b.ordered ? 'ol' : 'ul', {}, ...b.items.map((it) => h('li', {}, ...inline(it))));
    case 'quote':
      return h('blockquote', {}, ...inline(b.c));
    case 'hr':
      return h('hr', {});
    case 'table':
      return h(
        'div',
        { class: 'md-table' },
        h('table', {}, h('thead', {}, h('tr', {}, ...b.head.map((c) => h('th', {}, ...inline(c))))), h('tbody', {}, ...b.rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, ...inline(c))))))),
      );
    case 'p':
      return h('p', {}, ...inline(b.c));
  }
}

export function markdown(src: string): HTMLElement {
  return h('div', { class: 'md' }, ...parseMarkdown(src).map(block));
}
