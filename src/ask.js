// Pure helpers for the interactive ask mechanism (elicit) — no React, no IO.
//
// Mirrors the web client (gemia static/v3/v3.js showAskModal / buildAskControl):
// the agent pauses on an `elicit` tool call and emits an `ask_question` event
//   { kind:"ask_question", question:{ question_id, title, description,
//                                     controls:{ <key>:{type,...} } } }
// The user answers each control; on submit we build
//   answers = { <controlKey>: value }
// and POST it to /sessions/{id}/ask_response (see api.submitAskResponse).
//
// Terminal constraints: we can't render rich widgets, so we present the
// question text + each control's choices/placeholder as lines, and accept a
// single typed line per control (and across controls when there are several),
// parsing it into the right shape per control type. Choice controls accept the
// option value, its label, or a 1-based index.

// Human-readable type tag for the control prompt line.
function typeHint(ctrl) {
  switch (ctrl?.type) {
    case "select":
      return "choose one";
    case "multi_select":
      return "choose one or more (comma-separated)";
    case "slider": {
      const min = ctrl.min != null ? ctrl.min : 0;
      const max = ctrl.max != null ? ctrl.max : 100;
      return `number ${min}–${max}`;
    }
    case "panel":
      return "fields below";
    case "custom_panel":
      return "JSON answer";
    default:
      return ctrl?.multiline ? "free text (multi-line)" : "free text";
  }
}

// Build the lines describing one control for display in the terminal. `key` is
// the control key (used as the label, like the web's <label text=key>).
export function describeControl(key, ctrl) {
  const lines = [];
  lines.push(`${key}  (${typeHint(ctrl)})`);
  const opts = Array.isArray(ctrl?.options) ? ctrl.options : [];
  if (ctrl?.type === "select" || ctrl?.type === "multi_select") {
    opts.forEach((o, i) => {
      const value = o.value != null ? o.value : o.label;
      const label = o.label != null ? o.label : value;
      const def = ctrl.default != null && value === ctrl.default ? "  (default)" : "";
      lines.push(`    ${i + 1}. ${label}${label !== value ? `  [${value}]` : ""}${def}`);
    });
  } else if (ctrl?.type === "text" && ctrl.placeholder) {
    lines.push(`    e.g. ${ctrl.placeholder}`);
  } else if (ctrl?.type === "slider") {
    const def = ctrl.default != null ? `  (default ${ctrl.default})` : "";
    lines.push(`    step ${ctrl.step != null ? ctrl.step : 1}${def}`);
  } else if (ctrl?.type === "panel") {
    const fields = ctrl.fields || {};
    for (const [fk, fctrl] of Object.entries(fields)) {
      for (const l of describeControl(fk, fctrl)) lines.push("    " + l);
    }
  }
  return lines;
}

// Full prompt block for a question: title, description, and every control.
export function describeQuestion(question) {
  const lines = [];
  if (question?.title) lines.push(question.title);
  if (question?.description) lines.push(question.description);
  const controls = question?.controls || {};
  const keys = Object.keys(controls);
  for (const key of keys) {
    for (const l of describeControl(key, controls[key])) lines.push(l);
  }
  if (keys.length > 1) {
    lines.push("");
    lines.push("answer each control on its own line, in order, then Enter");
  }
  return lines;
}

// Resolve a single choice token (value / label / 1-based index) against a
// control's options to the canonical option *value*. Returns the raw token if
// nothing matches, so the server can do the authoritative validation.
function resolveChoice(token, opts) {
  const t = String(token).trim();
  if (!t) return t;
  // 1-based index
  if (/^\d+$/.test(t)) {
    const idx = Number(t) - 1;
    if (idx >= 0 && idx < opts.length) {
      const o = opts[idx];
      return o.value != null ? o.value : o.label;
    }
  }
  // exact value
  for (const o of opts) {
    const value = o.value != null ? o.value : o.label;
    if (String(value) === t) return value;
  }
  // exact label
  for (const o of opts) {
    const label = o.label != null ? o.label : o.value;
    if (String(label) === t) return o.value != null ? o.value : o.label;
  }
  return t;
}

// Parse one raw line into a single control's answer value.
function parseControlValue(ctrl, raw) {
  const opts = Array.isArray(ctrl?.options) ? ctrl.options : [];
  switch (ctrl?.type) {
    case "select":
      return resolveChoice(raw, opts);
    case "multi_select":
      return String(raw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((tok) => resolveChoice(tok, opts));
    case "slider": {
      const n = Number(String(raw).trim());
      return Number.isFinite(n) ? n : String(raw).trim();
    }
    case "custom_panel": {
      try {
        return JSON.parse(raw || "{}");
      } catch {
        return raw;
      }
    }
    default:
      return raw; // text (and unknown) pass through verbatim
  }
}

// Build the `answers` object from the user's raw input, mapping each control
// key to its parsed value. `raw` is the whole typed buffer; with multiple
// controls each non-empty line maps to the next control in declaration order.
// With a single control the entire buffer (incl. newlines for multiline text)
// is that control's value. Always returns a plain object keyed by control key,
// matching the server contract { <controlKey>: value }.
export function buildAnswers(question, raw) {
  const controls = question?.controls || {};
  const keys = Object.keys(controls);
  const answers = {};
  if (keys.length === 0) return answers;
  if (keys.length === 1) {
    const key = keys[0];
    answers[key] = parseControlValue(controls[key], raw ?? "");
    return answers;
  }
  // Multiple controls: split into lines, assign in order.
  const lines = String(raw ?? "").split("\n");
  keys.forEach((key, i) => {
    answers[key] = parseControlValue(controls[key], lines[i] != null ? lines[i] : "");
  });
  return answers;
}

// Normalize an ask_question event payload into a compact pending-ask record.
export function toPendingAsk(question) {
  if (!question || !question.question_id) return null;
  return {
    questionId: question.question_id,
    title: question.title || "Question",
    description: question.description || "",
    controls: question.controls || {},
    lines: describeQuestion(question),
  };
}
