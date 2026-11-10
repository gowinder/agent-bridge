// Small Markdown renderer built on DOM nodes only: no innerHTML, so transcript
// text can never inject markup. Covers the subset used in chat output.

const SAFE_SCHEME = /^(https?:|mailto:)/i;
/** Hard caps so a crafted transcript cannot exhaust the JS stack. */
const MAX_INLINE_DEPTH = 8;
const MAX_BLOCK_DEPTH = 16;
const MAX_LIST_DEPTH = 16;

function safeHref(raw: string): string | null {
  const href = raw.trim().replace(/^<|>$/g, "");
  return SAFE_SCHEME.test(href) ? href : null;
}

function codeSpan(text: string): HTMLElement {
  const code = document.createElement("code");
  code.textContent = text;
  return code;
}

function anchor(label: string, rawHref: string): HTMLElement {
  const href = safeHref(rawHref);
  if (!href) {
    const span = document.createElement("span");
    span.textContent = label;
    return span;
  }
  const a = document.createElement("a");
  a.textContent = label;
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

const INLINE =
  /(`[^`\n]+`)|(\*\*(?=\S)[\s\S]*?\S\*\*)|(__(?=\S)[\s\S]*?\S__)|(~~(?=\S)[\s\S]*?\S~~)|(\*(?=[^\s*])[^*\n]*[^\s*]\*)|(_(?=[^\s_])[^_\n]*[^\s_]_)|(\[[^\]\n]*\]\([^)\n]+\))|(<https?:\/\/[^>\s]+>)|(https?:\/\/[^\s<>()]+)/;

export function inlineNodes(text: string, depth = 0): Node[] {
  if (depth > MAX_INLINE_DEPTH) return [document.createTextNode(text)];
  const out: Node[] = [];
  let rest = text;
  while (rest) {
    const match = INLINE.exec(rest);
    if (!match || match.index === undefined) break;
    if (match.index > 0) out.push(document.createTextNode(rest.slice(0, match.index)));
    const raw = match[0];
    if (match[1]) {
      out.push(codeSpan(raw.slice(1, -1)));
    } else if (match[2] || match[3]) {
      const strong = document.createElement("strong");
      strong.append(...inlineNodes(raw.slice(2, -2), depth + 1));
      out.push(strong);
    } else if (match[4]) {
      const del = document.createElement("del");
      del.append(...inlineNodes(raw.slice(2, -2), depth + 1));
      out.push(del);
    } else if (match[5] || match[6]) {
      const em = document.createElement("em");
      em.append(...inlineNodes(raw.slice(1, -1), depth + 1));
      out.push(em);
    } else if (match[7]) {
      const link = /^\[([^\]]*)\]\(([^)]+)\)$/.exec(raw);
      out.push(anchor(link?.[1] ?? raw, link?.[2] ?? ""));
    } else if (match[8]) {
      out.push(anchor(raw.slice(1, -1), raw.slice(1, -1)));
    } else {
      const url = raw.replace(/[.,;:!?。，；：！？]+$/, "");
      out.push(anchor(url, url));
      if (url !== raw) out.push(document.createTextNode(raw.slice(url.length)));
    }
    rest = rest.slice(match.index + raw.length);
  }
  if (rest) out.push(document.createTextNode(rest));
  return out;
}

function appendInline(target: HTMLElement, text: string): void {
  const parts = text.split("\n");
  parts.forEach((part, index) => {
    if (index > 0) target.append(document.createElement("br"));
    target.append(...inlineNodes(part));
  });
}

interface ListItem {
  indent: number;
  ordered: boolean;
  text: string[];
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

function buildList(items: ListItem[], depth = 0): HTMLElement {
  if (depth > MAX_LIST_DEPTH) {
    // Fold deeper nesting into a flat, unformatted list instead of recursing.
    const flat = document.createElement(items[0]?.ordered ? "ol" : "ul");
    for (const item of items) {
      const li = document.createElement("li");
      li.textContent = item.text.join("\n");
      flat.append(li);
    }
    return flat;
  }
  const base = items[0]?.indent ?? 0;
  const root = document.createElement(items[0]?.ordered ? "ol" : "ul");
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (!item) break;
    if (item.indent > base) {
      // Orphan deeper item: fold it into the previous entry.
      const last = root.lastElementChild;
      if (last) last.append(buildList(items.slice(i), depth + 1));
      return root;
    }
    const li = document.createElement("li");
    appendInline(li, item.text.join("\n"));
    i += 1;
    const sub: ListItem[] = [];
    while (i < items.length && (items[i]?.indent ?? 0) > base) {
      const next = items[i];
      if (next) sub.push(next);
      i += 1;
    }
    if (sub.length > 0) li.append(buildList(sub, depth + 1));
    root.append(li);
  }
  return root;
}

function readList(lines: string[], start: number, depth = 0): { node: HTMLElement; next: number } | null {
  const items: ListItem[] = [];
  let last: ListItem | null = null;
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const match = LIST_ITEM.exec(line);
    if (match) {
      last = { indent: (match[1] ?? "").length, ordered: /\d/.test(match[2] ?? ""), text: [match[3] ?? ""] };
      items.push(last);
      i += 1;
      continue;
    }
    if (last && line.trim() && /^\s{2,}\S/.test(line)) {
      last.text.push(line.trim());
      i += 1;
      continue;
    }
    if (!line.trim()) {
      let j = i + 1;
      while (j < lines.length && !(lines[j] ?? "").trim()) j += 1;
      if (j < lines.length && LIST_ITEM.test(lines[j] ?? "")) {
        i = j;
        continue;
      }
    }
    break;
  }
  if (items.length === 0) return null;
  return { node: buildList(items, depth), next: i };
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((cell) => cell.trim());
}

function isTableStart(lines: string[], index: number): boolean {
  const head = lines[index] ?? "";
  const sep = lines[index + 1] ?? "";
  return head.includes("|") && /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*(?::?-{2,}:?)?\s*\|?\s*$/.test(sep + "|");
}

function readTable(lines: string[], start: number): { node: HTMLElement; next: number } {
  const header = splitRow(lines[start] ?? "");
  const align = splitRow(lines[start + 1] ?? "").map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : "";
  });
  const table = document.createElement("table");
  table.className = "md-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  header.forEach((cell, index) => {
    const th = document.createElement("th");
    if (align[index]) th.style.textAlign = align[index] ?? "";
    appendInline(th, cell);
    headRow.append(th);
  });
  thead.append(headRow);
  table.append(thead);
  const tbody = document.createElement("tbody");
  let i = start + 2;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim() || !line.includes("|")) break;
    const row = document.createElement("tr");
    splitRow(line).forEach((cell, index) => {
      const td = document.createElement("td");
      if (align[index]) td.style.textAlign = align[index] ?? "";
      appendInline(td, cell);
      row.append(td);
    });
    tbody.append(row);
    i += 1;
  }
  table.append(tbody);
  const wrap = document.createElement("div");
  wrap.className = "md-table-wrap";
  wrap.append(table);
  return { node: wrap, next: i };
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return (
    /^\s*(```|~~~)/.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    isTableStart(lines, index)
  );
}

export function renderMarkdown(source: string): DocumentFragment {
  return renderBlocks(source, 0);
}

function renderBlocks(source: string, depth: number): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (depth > MAX_BLOCK_DEPTH) {
    const p = document.createElement("p");
    p.className = "md-p";
    p.textContent = source;
    fragment.append(p);
    return fragment;
  }
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1] ?? "```";
      const lang = fence[2] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      const pre = document.createElement("pre");
      pre.className = "md-pre";
      if (lang) pre.dataset["lang"] = lang;
      const code = document.createElement("code");
      code.textContent = body.join("\n");
      pre.append(code);
      fragment.append(pre);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min((heading[1] ?? "#").length, 6);
      const node = document.createElement(`h${level}`);
      node.className = "md-h";
      appendInline(node, heading[2] ?? "");
      fragment.append(node);
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      const hr = document.createElement("hr");
      hr.className = "md-hr";
      fragment.append(hr);
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? "")) {
        body.push(QUOTE.exec(lines[i] ?? "")?.[1] ?? "");
        i += 1;
      }
      const quote = document.createElement("blockquote");
      quote.className = "md-quote";
      quote.append(renderBlocks(body.join("\n"), depth + 1));
      fragment.append(quote);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const list = readList(lines, i);
      if (list) {
        list.node.className = "md-list";
        fragment.append(list.node);
        i = list.next;
        continue;
      }
    }

    if (isTableStart(lines, i)) {
      const table = readTable(lines, i);
      fragment.append(table.node);
      i = table.next;
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() && !(paragraph.length > 0 && isBlockStart(lines, i))) {
      paragraph.push(lines[i] ?? "");
      i += 1;
    }
    const p = document.createElement("p");
    p.className = "md-p";
    appendInline(p, paragraph.join("\n"));
    fragment.append(p);
  }
  return fragment;
}
