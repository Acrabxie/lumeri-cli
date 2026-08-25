// Runtime/API text is untrusted terminal input. Preserve ordinary Unicode,
// line feeds, and tabs, but make every other C0/C1 control visible before it
// reaches a terminal renderer. Escaping the introducer bytes also neutralizes
// multi-byte terminal protocols such as CSI and OSC without trying to parse
// their many terminators and private extensions.
const TERMINAL_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

function visibleControl(character) {
  return `\\x${character.codePointAt(0).toString(16).padStart(2, "0")}`;
}

export function terminalSafeText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(TERMINAL_CONTROL_RE, visibleControl);
}
