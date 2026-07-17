# Lumeri CLI — TUI Redesign Spec v1

**Direction in one line:** Claude Code's transcript grammar + ice-blue accent + ANSI-native degradation. One accent, attributes for hierarchy, boxes only where the user types or decides. Restyle, not re-architecture: every component below maps 1:1 to an existing file.

---

## 1. Palette

**Master rule (resolves the biggest source conflict):** Charm/Textual want detected-background adaptive hex pairs; the terminal-standards source says the 16 ANSI names are the only color API that auto-adapts to any user theme. **Standards win**, because Ink has no OSC-11 background detection and the brand constraint demands dark+light safety. Therefore: *attributes (bold/dim/inverse) carry hierarchy, ANSI-named colors carry status, and hex exists for exactly one thing — the brand accent — with hand-picked fallbacks.*

| Semantic role | Truecolor | ansi256 | 16-color name | Usage & rationale |
|---|---|---|---|---|
| `accent` | `#5FC6DE` | `80` (#5fd7d7, nearest cube point) | `cyan` | The ONLY hex in the running UI. Spinner, focused/input border, selected-row text, banner ✦, links, running-tool bullet, h1. Mid-lightness cyan reads on both #000 and #fff (≈3:1+ both ways). |
| `accent2` / `accent3` | `#8BD8EA` / `#ABE5F1` | — | — | **Splash gradient only, truecolor only.** Below level 3 they collapse to `accent`. Never in the transcript. |
| `success` | — (none) | — | `green` | ANSI-named at every level so the user's theme picks the shade. Done-tool bullet, ✔. |
| `error` | — | — | `red` | ✗, failed bullet, error first-line. Red appears nowhere else, ever. |
| `warn` | — | — | `yellow` | Warnings and budget gates only. **Removed from inline code** (conflict: current theme uses warn-yellow for code; semantic-slot discipline wins — yellow must mean "caution"). |
| `text` | terminal default fg (SGR 39) | default | default | All body text, markdown prose, tool results. Never set explicitly. |
| `muted` | default fg + `dim` (SGR 2) | same | same | Secondary text: args, hints, metadata, connectors, placeholders. **Conflict resolved:** Textual wants explicit grays; standards warn dim can be rewritten/vanish. Dim-on-default-fg wins (derives from the user's own theme, safe on both backgrounds) with two guardrails: never stack dim + a color, and never let dim be the sole carrier of a semantic distinction — a glyph or word always accompanies it. |
| `strong` | default fg + `bold` | same | same | Tool names, headings h2+, notice titles, key tokens. |
| `selection` | `inverse` (SGR 7) | same | same | Selected autocomplete row, ask-panel cursor row. Inverse swaps the user's own fg/bg — readable on every theme with zero palette knowledge. Never dim text on inverse. |
| `border.rest` | default fg + dim (Ink `borderDimColor`) | same | same | Resting borders. |
| `border.focus` | `accent` | `80` | `cyan` | Focused input/ask border — Textual's canonical accent use. |

**Roles deleted outright** (drop to `text`/`muted`, forgo color): brand amber `#E6B450`, user cyan `#56B6C2`, tool blue `#61AFEF`, video `#C792EA`, image `#82AAFF`, audio `#C3E88D`, warn hex `#E5C07B`, success/error hexes. The three media kinds are distinguished by a **word** in the chip, not a hue. Net palette on any one screen: default + dim + bold + 1 accent + ≤3 status names. 90% gray, one accent — matches the brand principle exactly.

theme.js becomes a token table (`text/muted/strong/accent/success/warn/error/selection/border`) with the degradation decision made **once** there; literal chalk color calls in components are banned.

---

## 2. Glyph set

Single-cell, BMP, no variation selectors, ASCII fallback map shipped for `TERM=dumb`/non-UTF-8/accessibility mode.

| Glyph | Verdict | Notes |
|---|---|---|
| `⏺` tool/turn marker (U+23FA) | **Keep** | Proven single-cell (Claude Code precedent). Fallback `*`. |
| `⎿` branch (U+23BF) | **Keep** | Fallback `L`. |
| `›` user prefix (U+203A) | **Keep** | Fallback `>`. Recolored dim (was cyan). |
| `•` bullet | **Keep** | EAW-ambiguous, but only ever at column 0 / list gutter, never inside borders or columns. Fallback `*`. |
| `→` arrow | **Keep, inline-text only** | Ambiguous width — banned from aligned columns/borders. Fallback `->`. |
| `●` live/conn dot | **Replace with `⏺`** | U+25CF is East-Asian-Ambiguous and sits in the right-aligned status line; a mis-width shears the edge. Reuse ⏺ + a state word ("live"/"reconnecting"). |
| `✔` / `✗` | **Keep** | Never append U+FE0F. Fallback `ok` / `x`. |
| `⏸` gate (U+23F8) | **Replace** | Emoji-presentation-prone in many terminals. Gated state = warn-yellow `⏺` + bold word `waiting` on the ⎿ line — word + color, no risky glyph. |
| `─` hr | **Keep** | Fallback `-`. |
| `❯` (U+276F) | **Add** | Selection cursor for autocomplete + ask-panel radio rows. Fallback `>`. |
| `● / ○` radios | **Replace with `(•)` / `( )`** | U+25CF/25CB are ambiguous-width in an aligned option column — exactly where shear hurts. ASCII-safe by construction. |
| `█ ░` progress | **Keep** | Fallback `#` / `.`. |
| `╭─╮│╰╯` round border | **Keep** | Only border style in the app (round everywhere; no double/thick — one app, one border voice). Fallback `+-|`. |
| Spinner frames | **Keep family, retime** | See §4. Fallback `-\|/`. |
| **TOOL_LABELS emoji (📄 🎬 …)** | **REMOVE ALL** | All six sources converge: emoji widths are Unicode-version- and terminal-dependent (breaks the ⎿ alignment column), and glyph-per-line reads as a toy. The verb label ("Read file", "Render range") carries the meaning alone. This is the single highest-leverage deletion. |
| Asset chip `▶` | **Replace with word** | U+25B6 ambiguous. Chip becomes `[clip_01 · video]` — dim brackets/word, default-fg id. |

---

## 3. Per-component redlines

Global grammar first (all components obey it):
- **Indentation ladder:** marker at col 0, content at col 2, ⎿ connector at col 2, result text at col 5, wrapped continuations align to parent text column. One spine.
- **Vertical rhythm:** 0 blank lines inside a block (⏺ header glued to its ⎿ lines), 1 blank line between blocks/turns, 2 max around banner/ask panel. Never >2.
- **Boxes:** exactly three surfaces may have a border — InputBox, AskPrompt, modal overlays. Everything else unboxed. (Conflict: Charm allows a bordered banner "shout"; Gemini's compact-header retreat + less-is-more wins — banner loses its box.)
- **Chrome truncates with `…` (U+2026, 1 cell), never wraps.** Measure in display cells via string-width (CJK=2), never `.length`. Paths middle-truncate keeping the tail.

**Banner** — Drop the round border. Three flush-left lines: line 1 `✦ Lumeri v0.x` (✦ accent, name bold); line 2 dim `video-editing agent · <server-url>`; line 3 dim `/help for commands`. One blank line after. Never re-renders (goes into `<Static>` immediately).

**Splash** — Keep the figlet column-wipe, recolored: truecolor = vertical gradient #5FC6DE→#8BD8EA→#ABE5F1 with a white leading edge; 256-color = solid accent 80; 16-color = cyan; skipped entirely when stdout is not a TTY, `NO_COLOR`+`TERM=dumb`, or CI. Total ≤1.2 s, any key skips, plays once, never in scrollback twice.

**Turn** — User line: `›` dim, text **default fg** (cyan removed — the user's words are content, not chrome). Assistant markdown streams at default fg, wrapped at min(terminal−2, 88) cells. Inline banners: keep 2-space indent; tone color on the leading glyph + first word only, body default/dim.

**ToolCall** — Header: `⏺ Render range(shot_03, 0–48)` — bullet colored by status (**running = accent** — the only accent in the transcript, marks liveness; **done = green; failed = red; gated = yellow**), name **bold default fg** (blue removed), args **dim**, truncated to width.
- Running ⎿ line: **remove the per-line spinner** (conflict with current design: one-spinner rule from Claude Code/Textual/handbook wins — the status-line spinner is the app's only ambient animation). Show dim message; for determinate ops >10 s add a **20-cell** bar, accent `█` fill / dim `░` track, right-aligned `NN%`, monotonic.
- Done ⎿ line: brief summary (git-push register: what changed, new state), metadata folded self-identifying: `3.2s · 1.4k tokens · 2 files` (dim, `·`-separated — no `label: value` sprawl). Asset chip at line end.
- Results collapse after **4 lines** to dim `… +N lines (ctrl+o to expand)` at the ⎿ indent.
- Failed: red `✗` + one-line human cause first, dim detail lines, and the **corrective action/command as the LAST line** (clig: eye lands at the end). Full raw output always available behind the same expand — never swallowed.
- Gated: yellow ⏺, ⎿ `waiting — budget gate: <reason> · y to approve` (bold `waiting`, rest dim).
- Subagents: keep `├─`/`│` tree, cap the live group at **5 rows** with dim `… +N more`, statuses as word+glyph.

**Notice** — Unboxed (already is): glyph colored by tone + **bold default** title, body dim at col 2. No log-level labels, no timestamps, sentence-case wording.

**Help notice** — **Remove the round border.** Bold section headings `Commands` / `Shortcuts`, one worked example line first (`› /render 0–10  render the first ten seconds`, dim), then rows: `/command` in accent padded to width 16, description dim, most-used commands first. Flush left.

**AskPrompt** — Keep the box (interactive focal surface): round border in **accent**, first line bold question (drop "• Lumeri is asking" — the accent border already says who's asking), optional dim hint line, then a vertical radio list: `❯ (•) option` (cursor row inverse), `  ( ) option`. One question per panel, no pre-selected destructive default, submit-only validation, `esc to cancel` dim below the box (outside it). Destructive confirms follow the 3-tier ladder (none / y-n / type-the-name).

**InputBox** — Keep round border; border = **accent** (the accent anchor of the idle screen; everything else quiet). `› ` prompt dim, inverse-block cursor keep, placeholder dim (`Describe an edit, or / for commands`— action-oriented, never "No messages yet"). On error: **input content and focus preserved**, error notice appears above the box, `Error:` + cause + fix. Autocomplete: **unboxed** list directly below, selected row **inverse video** (not accent-background), `/command` accent + description dim, `↑ N more` markers dim, zero animation on open/close. No-match row: dim `No commands match "xzy" — try /help`. Mistyped command: suggest nearest match, never auto-run.

**StatusLine** — Single line, left: accent spinner + gerund verb + `…` + dim `(12s · esc to interrupt)`; idle: dim `/help commands · ↑ history · ctrl+c exit`. Right (all dim): `waiting: plan` / `tasks ×N` / `queued ×N` / account / `⏺ reconnecting` (word + glyph, warn color only when degraded). Below 60 columns: drop right side except connection, truncate-end. First ctrl+c prints `stopping… (ctrl+c again to force)` immediately.

**markdown.js** — h1 = **bold accent**; h2+ = **bold default** (one emphasis channel per element — never bold+color stacked on body). Inline code = **accent** (yellow freed for warnings). Code block: **remove the border box** → 2-space indent, default-fg code, dim lang label above, dim `│`-free — separation by indent + blank lines. Blockquote dim `│ ` keep. Links accent underline + dim URL keep. Lists `• ` keep. hr = dim `─`×40 keep. Wrap measure ≤88 cells.

**format.js** — TOOL_LABELS lose emoji, keep verb phrases. `formatArgs` unchanged in shape; enforce cell-width truncation + path middle-truncation. Quantitative numbers (%, s, tokens, lines) right-align/`padStart` in any columnar context.

---

## 4. Spinner & motion

- **Frames:** `· ✢ ✳ ✶ ✻ ✽ ✻ ✶ ✳ ✢` — keep the asterisk-morph family (brand ✦ continuity, Claude Code precedent; wins over braille suggestion — both are single-cell, continuity breaks the tie). Hold first and last frames 2 ticks (eased feel). **Tick 80 ms.** Color: accent. ASCII fallback `- \ | /`.
- **One spinner on screen, ever**, in the status line. Delay-mount 400 ms so sub-second operations never flash it; on completion the line is replaced with its final state — no frozen frames in scrollback.
- **Never animates:** anything in the transcript/scrollback (finished turns live in Ink `<Static>`), autocomplete open/close, ask-panel appearance, banner, borders. Progress bars may advance (damage-region update, informative) but never shimmer.
- **Non-TTY stdout: zero animation and zero cursor movement** — plain append-only lines (`[render] 40%… [render] done 3.2s`).
- Repaint discipline: only the live tail (status line + composer + running card) re-renders per token; offscreen timers freeze.

---

## 5. Degradation & accessibility

Detection ladder (decided once, in theme.js, per-stream): level 3 truecolor (`COLORTERM=truecolor|24bit`) → level 2 256 (`*-256color`) → level 1 16 (`xterm|screen|vt100|linux|ansi`) → level 0 (`TERM=dumb`, non-TTY). `FORCE_COLOR` overrides all; `--no-color` and non-empty `NO_COLOR` (any value) strip color.

| Mode | Behavior |
|---|---|
| **Truecolor** | Full spec. Splash gradient allowed. |
| **256** | Accent → `80`; gradient → solid 80; everything else already ANSI-named/attributes — unchanged. |
| **16** | Accent → `cyan`. Status = named red/green/yellow. UI fully functional. |
| **NO_COLOR** | Color only is stripped; **bold/dim/inverse stay** (they carry the hierarchy). Every state already pairs color with a glyph or word (✔/✗/waiting/error), so nothing is lost. |
| **TERM=dumb / non-TTY** | No escapes at all: ASCII glyph map (`* L > ok x -\|/ #.`), no boxes, no spinner, no redraws — sequential log lines. Bug per stream: piped stdout may still leave stderr styled. |
| **Accessibility mode** (flag) | Decorative glyphs replaced by short labels: `Tool:`, `Result:`, `Error:`. |
| **Narrow (<60 cols)** | Chrome truncate-ends (never wraps); status-line right side collapses; progress bar shrinks to 10 cells; banner stays 3 lines. |

Contrast rules: never set a background color under body text; never hardcode near-white/near-black foregrounds; never stack dim + gray; test on macOS Terminal "Basic" (light) and "Pro" (dark) before merge. Terminals may rewrite low-contrast colors (iTerm Minimum Contrast) — no meaning may live in a subtle tint.

---

## 6. Reviewer checklist (score after-frames 0–10)

1. **One accent:** ice blue appears only at spinner, input/ask border, selected row, links, running bullet, ✦, h1 — and no amber/blue/purple/media hues anywhere.
2. **Three boxes max on any screen** (input, ask, modal); banner, help, code blocks, tool cards, menus are unboxed.
3. **One spine:** every block's marker at col 0, content col 2, results col 5; nothing centered except splash art.
4. **Zero emoji** in tool labels, gutters, or aligned columns; all chrome glyphs single-cell with ASCII twins.
5. **One animation:** a single accent spinner in the status line; scrollback is byte-stable (no repaints of finished turns).
6. **Status = glyph + word + color**, never color alone; screen still fully legible with `NO_COLOR=1`.
7. **Tool results collapse at 4 lines** with `… +N lines (ctrl+o to expand)`; failed tools show cause first, fix **last**, full log behind expand.
8. **Piped/`TERM=dumb` output** is clean sequential ASCII — no escapes, no spinner residue, no box fragments.
9. **Vertical rhythm:** 0 blank lines inside blocks, exactly 1 between them; metadata is `3.2s · 1.4k tokens` style, no `label: value` sprawl, numbers right-aligned.
10. **Errors preserve input** (typed text intact, box enabled), name a concrete next action, and red appears nowhere else on the screen.

---

### File-by-file touch list
- `theme.js` — new token table + capability ladder + ASCII fallback map; delete 7 hex roles; retime spinner.
- `markdown.js` — h1 accent, unbox code blocks, inline code accent (de-yellow), wrap ≤88.
- `format.js` — de-emoji TOOL_LABELS, cell-width truncation, chip `[id · kind]`, `·` metadata joiner.
- Banner/Splash — unbox banner to 3 lines; splash gradient + skip conditions.
- ToolCall — bullet status colors, remove per-line spinner, 20-cell bar, 4-line collapse, gated `waiting` word, error line order.
- Notice/Help — unbox help, bold headings, example-first.
- AskPrompt — accent border, drop header line, `❯ (•)` radios.
- InputBox — accent border, dim `›`, inverse selection in autocomplete, error-above-box.
- StatusLine — spinner+gerund+esc hint left, dim metadata right, ⏺+word conn state, narrow collapse.