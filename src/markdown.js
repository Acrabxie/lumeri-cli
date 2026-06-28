// A compact Markdown → Ink renderer. Handles the cases a chat model actually
// emits: paragraphs, **bold**/*italic*, `code`, [links](url), #headings,
// - lists, > quotes, ``` fenced code, and --- rules. Tolerant of the partial
// markup you get mid-stream (an unclosed ** or ``` just renders literally).

import { Box, Text } from "ink";
import { html } from "./html.js";
import { color, glyph } from "./theme.js";

const INLINE_RE =
  /(\*\*|__)([\s\S]+?)\1|(\*|_)(?=\S)([\s\S]+?)(?<=\S)\3|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

function renderInline(text, kp) {
  const nodes = [];
  let last = 0;
  let i = 0;
  let m;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const k = `${kp}-i${i++}`;
    if (m[1]) {
      nodes.push(html`<${Text} key=${k} bold>${m[2]}</${Text}>`);
    } else if (m[3]) {
      nodes.push(html`<${Text} key=${k} italic>${m[4]}</${Text}>`);
    } else if (m[5] !== undefined) {
      nodes.push(html`<${Text} key=${k} color=${color.warn}>${m[5]}</${Text}>`);
    } else if (m[6] !== undefined) {
      nodes.push(
        html`<${Text} key=${k}><${Text} color=${color.link} underline>${m[6]}</${Text}><${Text} color=${color.muted}> (${m[7]})</${Text}></${Text}>`,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function paragraph(text, key) {
  return html`<${Text} key=${key}>${renderInline(text, key)}</${Text}>`;
}

function heading(level, text, key) {
  const c = level <= 2 ? color.brand : color.text;
  return html`<${Text} key=${key} bold color=${c}>${renderInline(text, key)}</${Text}>`;
}

function hr(key) {
  return html`<${Text} key=${key} color=${color.muted}>${glyph.hr.repeat(40)}</${Text}>`;
}

function codeBlock(code, lang, key) {
  const lines = code.split("\n");
  return html`<${Box} key=${key} flexDirection="column" borderStyle="round" borderColor=${color.muted} paddingX=${1} marginY=${0}>
    ${lang ? html`<${Text} key="lang" color=${color.muted} dimColor>${lang}</${Text}>` : null}
    ${lines.map((ln, idx) => html`<${Text} key=${"c" + idx} color=${color.warn}>${ln.length ? ln : " "}</${Text}>`)}
  </${Box}>`;
}

function blockquote(text, key) {
  const inner = renderMarkdown(text, key + "q");
  return html`<${Box} key=${key} flexDirection="column" borderStyle="single" borderColor=${color.muted} borderTop=${false} borderRight=${false} borderBottom=${false} paddingLeft=${1}>
    ${inner}
  </${Box}>`;
}

function list(items, key) {
  return html`<${Box} key=${key} flexDirection="column" paddingLeft=${1}>
    ${items.map(
      (it, idx) => html`<${Box} key=${idx}>
        <${Text} color=${color.muted}>${it.ordered ? it.marker + " " : glyph.bullet + " "}</${Text}>
        <${Text}>${renderInline(it.text, key + idx)}</${Text}>
      </${Box}>`,
    )}
  </${Box}>`;
}

const BLOCK_START = /^\s*(#{1,6}\s|>|```|([-*+]|\d+\.)\s)/;
const HR_RE = /^\s*([-*_])\1\1+\s*$/;

export function renderMarkdown(src, kp = "md") {
  const lines = String(src ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  let b = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const lang = fence[1].trim();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip closing fence (or run off the end if unclosed)
      blocks.push(codeBlock(code.join("\n"), lang, `${kp}-${b++}`));
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      blocks.push(hr(`${kp}-${b++}`));
      i++;
      continue;
    }
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push(heading(h[1].length, h[2], `${kp}-${b++}`));
      i++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(blockquote(q.join("\n"), `${kp}-${b++}`));
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const mm = lines[i].match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
        items.push({ ordered: /\d+\./.test(mm[1]), marker: mm[1], text: mm[2] });
        i++;
      }
      blocks.push(list(items, `${kp}-${b++}`));
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !BLOCK_START.test(lines[i]) &&
      !HR_RE.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(paragraph(para.join(" "), `${kp}-${b++}`));
  }
  return blocks;
}
