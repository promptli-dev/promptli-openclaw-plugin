// Keep only speakable text from a streamed reply (voice turns): drop code blocks, markdown marks and URLs
// as deltas arrive, without waiting for whole sentences. Port of promptli_gateway/speech.py.

const URL_PREFIXES = ["https://", "http://"];
const MARKS = new Set(["*", "#", "`", "~", "|", ">"]);

export class SpeechFilter {
  private inCode = false;
  private pending = "";

  feed(delta: string): string {
    const text = this.pending + delta;
    this.pending = "";
    const out: string[] = [];
    let i = 0;
    const n = text.length;
    while (i < n) {
      const rest = text.slice(i);
      if (rest.startsWith("```")) {
        this.inCode = !this.inCode;
        i += 3;
        continue;
      }
      if (rest.length < 3 && /^`+$/.test(rest)) {
        this.pending = rest; // maybe the start of a fence
        break;
      }
      if (this.inCode) {
        i += 1;
        continue;
      }
      if (URL_PREFIXES.some((p) => rest.startsWith(p))) {
        const m = /\s/.exec(rest);
        if (!m) {
          this.pending = rest; // the URL may continue in the next delta
          break;
        }
        out.push("the link");
        i += m.index;
        continue;
      }
      if (rest[0] === "h" && rest.length < 8 && URL_PREFIXES.some((p) => p.startsWith(rest))) {
        this.pending = rest;
        break;
      }
      const ch = text[i]!;
      if (!MARKS.has(ch)) out.push(ch);
      i += 1;
    }
    return out.join("");
  }

  flush(): string {
    const rest = this.pending;
    this.pending = "";
    const isUrl = URL_PREFIXES.some((p) => rest.startsWith(p));
    if (this.inCode || isUrl) return isUrl ? "the link" : "";
    return [...rest].filter((ch) => !MARKS.has(ch)).join("");
  }
}

/** Whole-text version (non-streamed replies). */
export function speakable(text: string): string {
  const f = new SpeechFilter();
  return f.feed(text) + f.flush();
}
