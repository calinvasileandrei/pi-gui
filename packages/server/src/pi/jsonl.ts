import { StringDecoder } from "node:string_decoder";

/**
 * Strict JSONL splitter for pi RPC: splits on LF only, strips one trailing CR.
 * Never use node:readline here — it also splits on U+2028/U+2029, which are legal inside JSON strings.
 */
export class JsonlSplitter {
  private decoder = new StringDecoder("utf8");
  private buf = "";

  constructor(private onLine: (line: string) => void) {}

  push(chunk: Buffer | string): void {
    this.buf += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let start = 0;
    let nl: number;
    while ((nl = this.buf.indexOf("\n", start)) !== -1) {
      this.emit(this.buf.slice(start, nl));
      start = nl + 1;
    }
    this.buf = this.buf.slice(start);
  }

  end(): void {
    this.buf += this.decoder.end();
    if (this.buf.length > 0) this.emit(this.buf);
    this.buf = "";
  }

  private emit(line: string): void {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length > 0) this.onLine(line);
  }
}

export function encodeJsonl(obj: unknown): string {
  // JSON.stringify escapes \n inside strings, so one object == one line.
  return JSON.stringify(obj) + "\n";
}
