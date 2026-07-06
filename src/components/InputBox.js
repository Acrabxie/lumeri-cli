import { Box, Text, useInput } from "ink";
import { useState, useRef } from "react";
import { html } from "../html.js";
import { color, glyph } from "../theme.js";
import { autocompleteState, menuScroll } from "../slash.js";

const PLACEHOLDER = "Send a message to Lumeri…  (/help for commands)";
const ANSWER_PLACEHOLDER = "Type your answer to Lumeri…  (/cancel to dismiss)";
const MENU_MAX = 6;

export function InputBox({ onSubmit, history, answerMode = false }) {
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [sel, setSel] = useState(0); // autocomplete highlight
  const histIndex = useRef(null); // null = editing live draft
  const draft = useRef("");
  const escCleared = useRef(false); // true right after Esc wiped the line

  const winStart = useRef(0); // first visible row of the autocomplete menu

  const ac = autocompleteState(text);
  const matches = ac ? ac.matches : [];
  const selClamped = matches.length ? Math.min(sel, matches.length - 1) : 0;
  winStart.current = matches.length
    ? menuScroll(matches.length, selClamped, winStart.current, MENU_MAX)
    : 0;
  const visible = matches.slice(winStart.current, winStart.current + MENU_MAX);
  const hiddenBelow = matches.length - winStart.current - visible.length;

  const setBoth = (t, c) => {
    setText(t);
    setCursor(c == null ? t.length : Math.max(0, Math.min(c, t.length)));
  };

  const insert = (chunk) => {
    // Pasted text arrives here as one chunk: normalize CR/CRLF to LF (so
    // multi-line pastes keep their line breaks) and keep TAB, but strip the
    // other ASCII control chars / stray escape sequences.
    const clean = chunk.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    if (!clean) return;
    const next = text.slice(0, cursor) + clean + text.slice(cursor);
    setBoth(next, cursor + clean.length);
    setSel(0);
    histIndex.current = null;
    escCleared.current = false;
  };

  useInput((input, key) => {
    // Let App own these.
    if (key.ctrl && (input === "c" || input === "d")) return;

    if (key.return) {
      // Backslash-continuation → newline instead of submit.
      if (text.endsWith("\\")) {
        setBoth(text.slice(0, -1) + "\n", text.length);
        return;
      }
      // Menu open → Enter runs the highlighted command, so a bare "/" or a
      // fragment like "/log" resolves to what's on screen instead of being
      // submitted raw and bouncing as an unknown command.
      const value = matches.length ? `/${matches[selClamped].name}` : text;
      if (!value.trim()) return;
      onSubmit(value);
      setBoth("", 0);
      setSel(0);
      histIndex.current = null;
      draft.current = "";
      return;
    }

    if (key.tab) {
      // shift+tab belongs to App (plan-mode toggle) — Ink broadcasts every
      // keypress to all useInput hooks, so just don't act on it here.
      if (key.shift) return;
      if (matches.length) {
        const filled = `/${matches[selClamped].name} `;
        setBoth(filled, filled.length);
        setSel(0);
      }
      return;
    }

    if (key.escape) {
      // Clear the line, but stash it in the draft so an immediate ↑ restores it.
      if (text) {
        draft.current = text;
        escCleared.current = true;
        setBoth("", 0);
      }
      setSel(0);
      histIndex.current = null;
      return;
    }

    if (key.upArrow) {
      if (matches.length) {
        setSel((s) => (s - 1 + matches.length) % matches.length);
        return;
      }
      // Undo an Esc-clear: bring the wiped draft back before walking history.
      if (escCleared.current && histIndex.current === null && draft.current) {
        escCleared.current = false;
        setBoth(draft.current);
        return;
      }
      // history back
      if (history.length === 0) return;
      if (histIndex.current === null) {
        draft.current = text;
        histIndex.current = history.length - 1;
      } else if (histIndex.current > 0) {
        histIndex.current -= 1;
      }
      setBoth(history[histIndex.current]);
      return;
    }

    if (key.downArrow) {
      if (matches.length) {
        setSel((s) => (s + 1) % matches.length);
        return;
      }
      if (histIndex.current === null) return;
      if (histIndex.current < history.length - 1) {
        histIndex.current += 1;
        setBoth(history[histIndex.current]);
      } else {
        histIndex.current = null;
        setBoth(draft.current);
      }
      return;
    }

    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(text.length, c + 1));
      return;
    }

    // In Ink 7, the macOS Backspace key (DEL 0x7f) maps to key.backspace;
    // key.delete is the forward-delete key (ESC[3~).
    if (key.backspace) {
      if (cursor > 0) {
        setBoth(text.slice(0, cursor - 1) + text.slice(cursor), cursor - 1);
        setSel(0);
        histIndex.current = null;
        escCleared.current = false;
      }
      return;
    }
    if (key.delete) {
      if (cursor < text.length) {
        setBoth(text.slice(0, cursor) + text.slice(cursor + 1), cursor);
        setSel(0);
        histIndex.current = null;
        escCleared.current = false;
      }
      return;
    }

    if (key.ctrl) {
      if (input === "a") return setCursor(0);
      if (input === "e") return setCursor(text.length);
      // The kill-line combos mutate the buffer, so detach it from history nav
      // and the Esc-restore latch, like every other editing key.
      const detach = () => {
        setSel(0);
        histIndex.current = null;
        escCleared.current = false;
      };
      if (input === "u") {
        setBoth(text.slice(cursor), 0);
        detach();
        return;
      }
      if (input === "k") {
        setBoth(text.slice(0, cursor), cursor);
        detach();
        return;
      }
      if (input === "w") {
        const left = text.slice(0, cursor).replace(/\s*\S+\s*$/, "");
        setBoth(left + text.slice(cursor), left.length);
        detach();
        return;
      }
      return; // swallow other ctrl combos
    }

    if (input) insert(input);
  });

  // Render text with an inverse-video cursor block.
  const showPlaceholder = text.length === 0;
  const placeholder = answerMode ? ANSWER_PLACEHOLDER : PLACEHOLDER;
  const before = text.slice(0, cursor);
  const atRaw = text.slice(cursor, cursor + 1);
  const at = atRaw === "" || atRaw === "\n" ? " " : atRaw;
  const after = atRaw === "\n" ? "\n" + text.slice(cursor + 1) : text.slice(cursor + 1);

  return html`<${Box} flexDirection="column">
    <${Box} borderStyle="round" borderColor=${color.brand} paddingX=${1}>
      <${Text} color=${color.brand}>${glyph.user + " "}</${Text}>
      ${showPlaceholder
        ? html`<${Text}><${Text} inverse> </${Text}><${Text} color=${color.muted}>${placeholder}</${Text}></${Text}>`
        : html`<${Text}>${before}<${Text} inverse>${at}</${Text}>${after}</${Text}>`}
    </${Box}>
    ${matches.length
      ? html`<${Box} flexDirection="column" marginLeft=${2}>
          ${winStart.current > 0
            ? html`<${Text} color=${color.muted}>${`↑ ${winStart.current} more`}</${Text}>`
            : null}
          ${visible.map(
            (c, idx) => html`<${Box} key=${c.name}>
              <${Text} color=${winStart.current + idx === selClamped ? color.brand : color.muted} bold=${winStart.current + idx === selClamped}>
                ${"/" + c.name + (c.arg ? " " + c.arg : "")}
              </${Text}>
              <${Text} color=${color.muted}>${"  " + c.desc}</${Text}>
            </${Box}>`,
          )}
          ${hiddenBelow > 0
            ? html`<${Text} color=${color.muted}>${`↓ ${hiddenBelow} more`}</${Text}>`
            : null}
        </${Box}>`
      : null}
  </${Box}>`;
}
