import { describe, expect, it } from "vitest";
import { JsonlSplitter, encodeJsonl } from "./jsonl.ts";

function collect() {
  const lines: string[] = [];
  return { lines, s: new JsonlSplitter((l) => lines.push(l)) };
}

describe("JsonlSplitter", () => {
  it("splits on LF and handles partial chunks", () => {
    const { lines, s } = collect();
    s.push('{"a":1}\n{"b"');
    s.push(":2}\n");
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("strips trailing CR", () => {
    const { lines, s } = collect();
    s.push('{"a":1}\r\n');
    expect(lines).toEqual(['{"a":1}']);
  });

  it("does not split on U+2028 / U+2029", () => {
    const { lines, s } = collect();
    const rec = { text: "a b c" };
    s.push(JSON.stringify(rec) + "\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(rec);
  });

  it("reassembles multibyte UTF-8 split across buffers", () => {
    const { lines, s } = collect();
    const bytes = Buffer.from('{"e":"€😀"}\n', "utf8");
    for (const b of bytes) s.push(Buffer.from([b]));
    expect(JSON.parse(lines[0]!)).toEqual({ e: "€😀" });
  });

  it("flushes a final unterminated line on end", () => {
    const { lines, s } = collect();
    s.push('{"a":1}');
    s.end();
    expect(lines).toEqual(['{"a":1}']);
  });

  it("skips empty lines", () => {
    const { lines, s } = collect();
    s.push("\n\r\n{}\n");
    expect(lines).toEqual(["{}"]);
  });

  it("encodeJsonl keeps embedded newlines on one line", () => {
    expect(encodeJsonl({ m: "a\nb" })).toBe('{"m":"a\\nb"}\n');
  });
});
