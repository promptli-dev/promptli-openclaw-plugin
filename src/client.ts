// A Promptli SDK client whose bearer token comes from a TokenSource (API key or self-refreshing browser
// login). The published SDK takes a static key, so we inject the current token in a fetch wrapper and retry
// once on 401 after refreshing.

import { Promptli } from "@promptli-npm/sdk";
import type { TokenSource } from "./auth.js";

export function tokenFetch(auth: TokenSource, base: typeof fetch = fetch): typeof fetch {
  return async (input, init = {}) => {
    const send = async () => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${await auth.token()}`);
      return base(input, { ...init, headers });
    };
    const res = await send();
    if (res.status === 401 && auth.kind === "browser_login") {
      auth.invalidate();
      return send();
    }
    return res;
  };
}

export function makeClient(auth: TokenSource, opts: { baseUrl?: string; fetch?: typeof fetch } = {}): Promptli {
  return new Promptli({
    apiKey: "from-token-source", // replaced on every request by tokenFetch
    baseUrl: opts.baseUrl,
    fetch: tokenFetch(auth, opts.fetch),
    userAgent: "promptli-openclaw/0.1",
  });
}
