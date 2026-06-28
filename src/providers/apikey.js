// Metered OpenAI API-key provider — the last-resort backend that always works
// as long as a key + balance exist (no subscription, no grey area). Speaks the
// same Responses wire format as the Codex path.
import { collect } from "./contract.js";
import { buildResponsesBody, postResponses } from "./responses-sse.js";
import { classifyError, ProviderUnavailableError } from "./errors.js";

const DEFAULT_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5";

export function apikeyProvider({ apiKey, model = DEFAULT_MODEL, url = DEFAULT_URL } = {}) {
  const key = apiKey || process.env.OPENAI_API_KEY || null;
  const self = {
    name: "apikey",

    status() {
      return key
        ? { available: true }
        : { available: false, reason: "OPENAI_API_KEY not set" };
    },

    async *stream(req) {
      if (!key) throw new ProviderUnavailableError("apikey", "OPENAI_API_KEY not set");
      try {
        yield* await postResponses({
          url,
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: buildResponsesBody(req, model),
          signal: req.signal,
        });
      } catch (e) {
        const c = classifyError(e, "apikey");
        if (c instanceof ProviderUnavailableError) throw c;
        throw e;
      }
    },

    respond(req) {
      return collect(self.stream(req));
    },
  };
  return self;
}
