// Zero-build JSX: htm bound to React.createElement gives template-literal JSX
// without a Babel/esbuild step, so the CLI runs straight from `node`.
import htm from "htm";
import React from "react";

export const html = htm.bind(React.createElement);
export { React };
