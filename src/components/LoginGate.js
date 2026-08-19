import { Box, Text } from "ink";
import { html } from "../html.js";
import { color, glyph } from "../theme.js";
import { productLabelForProduct } from "../product.js";
import { LUMERI_TERMINAL_ICON } from "../terminal-title.js";

export function LoginGate({ version, product = "video", state = "required", pendingLogin = null }) {
  const productLabel = productLabelForProduct(product);
  const pendingText =
    pendingLogin?.step === "email"
      ? "Enter your email address below."
      : pendingLogin?.step === "sending"
        ? "Sending your email code…"
        : pendingLogin?.step === "code"
          ? `Enter the 6-digit code sent to ${pendingLogin.email}.`
          : null;

  return html`<${Box} flexDirection="column" marginBottom=${1} paddingX=${1}>
    <${Box}>
      <${Text} color=${color.accent}>${LUMERI_TERMINAL_ICON + " "}</${Text}>
      <${Text} bold>${"Lumeri " + productLabel}</${Text}>
      <${Text} dimColor>${" v" + version}</${Text}>
    </${Box}>
    <${Box} marginTop=${1}>
      <${Text} color=${state === "unavailable" ? color.error : color.warn}>${glyph.bullet + " "}</${Text}>
      <${Text} bold>${state === "checking" ? "Checking sign-in…" : state === "unavailable" ? "Sign-in unavailable" : "Sign in required"}</${Text}>
    </${Box}>
    <${Text} dimColor>The workspace opens only after Lumeri confirms an active account.</${Text}>
    ${pendingText
      ? html`<${Text} color=${color.accentText}>${pendingText}</${Text}>`
      : html`<${Box} flexDirection="column" marginTop=${1}>
          <${Text}>/login email <${Text} dimColor>email one-time code</${Text}></${Text}>
          <${Text}>/login google <${Text} dimColor>Google in your browser</${Text}></${Text}>
        </${Box}>`}
  </${Box}>`;
}
