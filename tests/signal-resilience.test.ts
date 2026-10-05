import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The server is spawned inside the harness's controlling-terminal process
// group, so terminal job-control signals (SIGHUP on terminal hangup, SIGINT on
// Ctrl-C) reach it as collateral when Jean detaches zellij, closes the
// terminal, or interrupts Claude. Exiting on those is what made the server
// "keep disconnecting" mid-session. It must stay alive on SIGHUP/SIGINT, treat
// SIGTERM as a soft request that only counts once the pipe is gone, and shut
// down on the harness's authoritative signal: stdin EOF.

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (p: ChildProcess) => p.exitCode === null && p.signalCode === null;

async function startServer(): Promise<ChildProcess> {
  const p = spawn(process.execPath, [SERVER], { stdio: ["pipe", "ignore", "ignore"] });
  await sleep(500); // let main() connect the stdio transport
  if (!alive(p)) throw new Error("server exited during startup");
  return p;
}

describe("signal resilience", () => {
  it("ignores SIGHUP and keeps serving", async () => {
    const p = await startServer();
    try {
      p.kill("SIGHUP");
      await sleep(300);
      expect(alive(p)).toBe(true);
    } finally {
      p.kill("SIGKILL");
    }
  }, 5000);

  it("ignores SIGINT and keeps serving", async () => {
    const p = await startServer();
    try {
      p.kill("SIGINT");
      await sleep(300);
      expect(alive(p)).toBe(true);
    } finally {
      p.kill("SIGKILL");
    }
  }, 5000);

  it("keeps serving on SIGTERM while the pipe is still open", async () => {
    const p = await startServer();
    try {
      p.kill("SIGTERM");
      await sleep(2500); // past the 2s grace window
      expect(alive(p)).toBe(true);
    } finally {
      p.kill("SIGKILL");
    }
  }, 6000);

  it("exits cleanly on SIGTERM once stdin is closed", async () => {
    const p = await startServer();
    const exited = new Promise<number | null>((res) => p.on("exit", (code) => res(code)));
    p.kill("SIGTERM");
    p.stdin?.end();
    const code = await exited;
    expect(code).toBe(0);
  }, 6000);

  it("exits when stdin closes (harness gone)", async () => {
    const p = await startServer();
    const exited = new Promise<number | null>((res) => p.on("exit", (code) => res(code)));
    p.stdin?.end(); // EOF on stdin is the harness's primary shutdown signal
    const code = await exited;
    expect(code).toBe(0);
  }, 5000);
});
