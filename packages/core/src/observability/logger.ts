import { Redactor } from "./redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface HarnessLogger {
  debug(msg: string, data?: object): void;
  info(msg: string, data?: object): void;
  warn(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
  child(bindings: Record<string, unknown>): HarnessLogger;
}

export interface LoggerOptions { redactor: Redactor; sink?: (line: string) => void; level?: LogLevel; bindings?: Record<string, unknown> }

export function createLogger(opts: LoggerOptions): HarnessLogger {
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + "\n"));
  const level = opts.level ?? "info";
  const bindings = opts.bindings ?? {};
  const write = (lvl: LogLevel, msg: string, data?: object) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const entry = opts.redactor.redact({ level: lvl, time: new Date().toISOString(), ...bindings, ...(data ?? {}), msg });
    sink(JSON.stringify(entry));
  };
  return {
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
    child: (b) => createLogger({ ...opts, bindings: { ...bindings, ...b } }),
  };
}
