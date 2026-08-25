// A compact Markdown → Ink renderer. Handles the cases a chat model actually
// emits: paragraphs, **bold**/*italic*, `code`, [links](url), #headings,
// - lists, > quotes, ``` fenced code, and --- rules. Tolerant of the partial
// markup you get mid-stream (an unclosed ** or ``` just renders literally).

import { Box, Text } from "ink";
import { html } from "./html.js";
import { color, glyph } from "./theme.js";
import { terminalSafeText } from "./terminal-output.js";

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
      nodes.push(html`<${Text} key=${k} bold>${m[5]}</${Text}>`);
    } else if (m[6] !== undefined) {
      nodes.push(
        html`<${Text} key=${k}><${Text} color=${color.accentText} underline>${m[6]}</${Text}><${Text} dimColor> (${m[7]})</${Text}></${Text}>`,
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
  if (level === 1)
    return html`<${Text} key=${key} bold color=${color.accentText}>${renderInline(text, key)}</${Text}>`;
  return html`<${Text} key=${key} bold>${renderInline(text, key)}</${Text}>`;
}

function hr(key) {
  return html`<${Text} key=${key} dimColor>${glyph.hr.repeat(40)}</${Text}>`;
}

function codeBlock(code, lang, key) {
  const lines = code.split("\n");
  return html`<${Box} key=${key} flexDirection="column" paddingLeft=${2} marginY=${0}>
    ${lang ? html`<${Text} key="lang" dimColor>${lang}</${Text}>` : null}
    ${lines.map((ln, idx) => html`<${Text} key=${"c" + idx}>${ln.length ? ln : " "}</${Text}>`)}
  </${Box}>`;
}

function blockquote(text, key) {
  const inner = renderMarkdown(text, key + "q");
  return html`<${Box} key=${key} flexDirection="column" borderStyle="single" borderDimColor=${true} borderTop=${false} borderRight=${false} borderBottom=${false} paddingLeft=${1}>
    ${inner}
  </${Box}>`;
}

function list(items, key) {
  return html`<${Box} key=${key} flexDirection="column" paddingLeft=${2}>
    ${items.map(
      (it, idx) => html`<${Box} key=${idx}>
        <${Text} dimColor>${it.ordered ? it.marker + " " : glyph.bullet + " "}</${Text}>
        <${Text}>${renderInline(it.text, key + idx)}</${Text}>
      </${Box}>`,
    )}
  </${Box}>`;
}

// Hard-wrapped source lines are re-joined with a space — except between two
// CJK characters, where Latin-style joining would inject a visible gap
// mid-sentence (CJK prose carries no inter-line space).
const CJK_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
function joinProse(lines) {
  return lines.reduce((acc, ln) => {
    if (!acc) return ln;
    const glue = CJK_RE.test(acc.slice(-1)) && CJK_RE.test(ln.charAt(0)) ? "" : " ";
    return acc + glue + ln;
  }, "");
}

const BLOCK_START = /^\s*(#{1,6}\s|>|```|([-*+]|\d+\.)\s)/;
const HR_RE = /^\s*([-*_])\1\1+\s*$/;

export function renderMarkdown(src, kp = "md") {
  const lines = terminalSafeText(src).replace(/\r\n/g, "\n").split("\n");
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
    blocks.push(paragraph(joinProse(para), `${kp}-${b++}`));
  }
  return blocks;
}
