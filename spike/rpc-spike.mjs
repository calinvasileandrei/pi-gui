#!/usr/bin/env node
// M0 spike: spawn `pi --mode rpc`, send get_state + a prompt, print every record.
// Usage: PI_BIN=pi node spike/rpc-spike.mjs "Say hi in 3 words" [--model github-copilot/gpt-4o]
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const args = process.argv.slice(2);
const prompt = args.find((a) => !a.startsWith("--")) ?? "Say hi in three words.";
const modelIdx = args.indexOf("--model");
const piBin = process.env.PI_BIN ?? "pi";
const piArgs = ["--mode", "rpc", "--no-session"];
if (modelIdx >= 0) piArgs.push("--model", args[modelIdx + 1]);

const [cmd, ...pre] = piBin.split(" ");
const child = spawn(cmd, [...pre, ...piArgs], { stdio: ["pipe", "pipe", "pipe"] });

const decoder = new StringDecoder("utf8");
let buf = "";
child.stdout.on("data", (chunk) => {
  buf += decoder.write(chunk);
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    let line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line) onRecord(line);
  }
});
child.stderr.on("data", (d) => process.stderr.write(`[stderr] ${d}`));
child.on("exit", (code, sig) => console.log(`[exit] code=${code} signal=${sig}`));

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");

function onRecord(line) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    console.log(`[non-json] ${line}`);
    return;
  }
  if (rec.type === "message_update") {
    const e = rec.assistantMessageEvent;
    if (e?.type === "text_delta") process.stdout.write(e.delta);
    else console.log(`\n[message_update:${e?.type}]`);
    return;
  }
  console.log(`[${rec.type}]`, JSON.stringify(rec).slice(0, 300));
  if (rec.type === "response" && rec.id === "state") send({ id: "p1", type: "prompt", message: prompt });
  if (rec.type === "response" && rec.id === "p1" && !rec.success) child.kill();
  if (rec.type === "agent_end") setTimeout(() => child.kill(), 200);
}

send({ id: "state", type: "get_state" });
setTimeout(() => {
  console.log("[timeout] killing");
  child.kill();
}, 120_000).unref();
