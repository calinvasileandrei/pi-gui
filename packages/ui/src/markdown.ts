import { Marked, type Tokens } from "marked";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Markdown for model output. Model text is untrusted: raw HTML is escaped (never rendered)
 * and link/image URLs are limited to safe schemes, so output can't run script in the GUI
 * (which holds a token that can drive the agent).
 */
const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return esc(text);
    },
    link({ href, title, tokens }: Tokens.Link) {
      const inner = this.parser.parseInline(tokens);
      if (!/^(https?:|mailto:)/i.test(href)) return inner;
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${esc(title)}"` : ""}>${inner}</a>`;
    },
    image({ href, text }: Tokens.Image) {
      // no remote fetches from model output (tracking / exfil via URL)
      return `<span class="md-img">[image: ${esc(text || href)}]</span>`;
    },
    code({ text, lang }: Tokens.Code) {
      return `<pre class="code"><code data-lang="${esc(lang ?? "")}">${esc(text)}</code></pre>`;
    },
  },
});

export function renderMarkdown(src: string): string {
  return md.parse(src, { async: false }) as string;
}
