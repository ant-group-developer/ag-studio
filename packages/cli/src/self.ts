/** argv that re-invokes this very CLI from any cwd: bare `--import` (and friends) specifiers become absolute file:// URLs. */
export function cliArgv(): string[] {
  const execArgv: string[] = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    const a = process.execArgv[i]!;
    if ((a === "--import" || a === "--loader" || a === "-r" || a === "--require") && process.execArgv[i + 1] && !/^(file:|\.|\/|[A-Za-z]:)/.test(process.execArgv[i + 1]!)) {
      execArgv.push(a, import.meta.resolve(process.execArgv[++i]!)); continue;
    }
    if (a.startsWith("--import=")) { const spec = a.slice(9); execArgv.push(`--import=${/^(file:|\.|\/|[A-Za-z]:)/.test(spec) ? spec : import.meta.resolve(spec)}`); continue; }
    execArgv.push(a);
  }
  return [process.execPath, ...execArgv, process.argv[1]!];
}
