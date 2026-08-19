// LUMERI wordmark (figlet "ANSI Shadow"). All rows padded to LOGO_WIDTH so a
// column-wipe reveal keeps a stable width (no centering jitter).
export const LOGO_LINES = [
  "██╗     ██╗   ██╗███╗   ███╗███████╗██████╗ ██╗",
  "██║     ██║   ██║████╗ ████║██╔════╝██╔══██╗██║",
  "██║     ██║   ██║██╔████╔██║█████╗  ██████╔╝██║",
  "██║     ██║   ██║██║╚██╔╝██║██╔══╝  ██╔══██╗██║",
  "███████╗╚██████╔╝██║ ╚═╝ ██║███████╗██║  ██║██║",
  "╚══════╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝╚═╝",
];

export const LOGO_WIDTH = Math.max(...LOGO_LINES.map((l) => l.length));
