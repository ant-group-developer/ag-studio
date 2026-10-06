import { describe, expect, it } from "vitest";
import { resolveCommand, type ResolveCommandDeps } from "../src/resolve-command.js";

const NPM = "C:\\Users\\me\\AppData\\Roaming\\npm";
const SHIM_EXE = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*",
].join("\r\n");
const SHIM_JS = "@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n)";

function deps(files: Record<string, string>, over: Partial<ResolveCommandDeps> = {}): ResolveCommandDeps {
  return {
    platform: "win32",
    pathEnv: `C:\\Windows\\system32;${NPM}`,
    exists: (p) => p in files,
    readFile: (p) => {
      const f = files[p];
      if (f === undefined) throw new Error(`ENOENT ${p}`);
      return f;
    },
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    ...over,
  };
}

describe("resolveCommand", () => {
  it("uses <name>.exe found on PATH", () => {
    const exe = `${NPM}\\claude.exe`;
    expect(resolveCommand("claude", deps({ [exe]: "" }))).toEqual({ cmd: exe, prefixArgs: [] });
  });

  it("follows an npm .cmd shim to the native .exe it wraps, so no cmd.exe sits between us and the CLI", () => {
    const exe = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
    expect(resolveCommand("claude", deps({ [`${NPM}\\claude.cmd`]: SHIM_EXE, [exe]: "" }))).toEqual({ cmd: exe, prefixArgs: [] });
  });

  it("runs a .cmd shim that wraps a JavaScript entry with node", () => {
    const js = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
    expect(resolveCommand("claude", deps({ [`${NPM}\\claude.cmd`]: SHIM_JS, [js]: "" })))
      .toEqual({ cmd: "C:\\Program Files\\nodejs\\node.exe", prefixArgs: [js] });
  });

  it("prefers an .exe over a .cmd shim anywhere on PATH", () => {
    const exe = "C:\\Windows\\system32\\claude.exe";
    expect(resolveCommand("claude", deps({ [exe]: "", [`${NPM}\\claude.cmd`]: SHIM_EXE }))).toEqual({ cmd: exe, prefixArgs: [] });
  });

  it("leaves the name alone when nothing is found, so spawn fails with ENOENT as before", () => {
    expect(resolveCommand("claude", deps({}))).toEqual({ cmd: "claude", prefixArgs: [] });
  });

  it("leaves the name alone when the shim points at a file that does not exist", () => {
    expect(resolveCommand("claude", deps({ [`${NPM}\\claude.cmd`]: SHIM_EXE }))).toEqual({ cmd: "claude", prefixArgs: [] });
  });

  it("does nothing outside Windows", () => {
    expect(resolveCommand("claude", deps({ [`${NPM}\\claude.exe`]: "" }, { platform: "linux" }))).toEqual({ cmd: "claude", prefixArgs: [] });
  });

  it("does nothing for a path or a name that already has an extension", () => {
    const d = deps({ [`${NPM}\\node.exe`]: "" });
    expect(resolveCommand("E:/tools/claude.exe", d)).toEqual({ cmd: "E:/tools/claude.exe", prefixArgs: [] });
    expect(resolveCommand("node.exe", d)).toEqual({ cmd: "node.exe", prefixArgs: [] });
  });

  it("copes with an empty PATH", () => {
    expect(resolveCommand("claude", deps({}, { pathEnv: undefined }))).toEqual({ cmd: "claude", prefixArgs: [] });
  });
});
