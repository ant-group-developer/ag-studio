import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { App as AntApp, Segmented, Tooltip } from "antd";
import { AlertTriangle, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./json-view.css";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Children shown at first under one object or array; more come a page at a time. */
const PAGE = 100;
/** Levels open when the file opens. */
const OPEN_DEPTH = 3;

/** `$.clips[3].in`, `$["tên có dấu cách"]`: where a value sits, as you would write it to reach it. */
export function jsonPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

/**
 * Where JSON text stops being JSON (an offset), for browsers whose `JSON.parse` message does not say: a small
 * recursive-descent scan of the grammar. -1 when the text is valid.
 */
export function jsonErrorOffset(text: string): number {
  let i = 0;
  const ws = () => { while (i < text.length && " \t\n\r".includes(text[i]!)) i++; };
  const fail = (): never => { throw i; };
  const lit = (word: string) => { if (text.startsWith(word, i)) i += word.length; else fail(); };
  const str = () => {
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") { i++; if (text[i] === "u") { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) fail(); i += 4; } else if (!'"\\/bfnrt'.includes(text[i] ?? "")) fail(); }
      else if (text.charCodeAt(i) < 0x20) fail();
      i++;
    }
    if (text[i] !== '"') fail();
    i++;
  };
  const num = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) fail();
    i += m![0].length;
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++; ws();
      if (text[i] === "}") { i++; return; }
      for (;;) {
        ws(); if (text[i] !== '"') fail(); str(); ws();
        if (text[i] !== ":") fail(); i++; value(); ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return; }
        fail();
      }
    }
    if (c === "[") {
      i++; ws();
      if (text[i] === "]") { i++; return; }
      for (;;) {
        value(); ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return; }
        fail();
      }
    }
    if (c === '"') return str();
    if (c === "t") return lit("true");
    if (c === "f") return lit("false");
    if (c === "n") return lit("null");
    return num();
  };
  try { value(); ws(); return i < text.length ? i : -1; } catch (at) { return typeof at === "number" ? at : -1; }
}

/** Where `JSON.parse` stopped, as a line and column: from its message ("at position N", "(line L column C)"), else found. */
export function jsonErrorAt(text: string, message: string): { line: number; column: number } | null {
  const lc = /line (\d+) column (\d+)/.exec(message);
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]) };
  const pos = /position (\d+)/.exec(message);
  const offset = pos ? Number(pos[1]) : jsonErrorOffset(text);
  if (offset < 0) return null;
  const lines = text.slice(0, offset).split("\n");
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}

type Parsed =
  | { ok: true; values: { line: number | null; value: Json }[] }
  | { ok: false; message: string; at: { line: number; column: number } | null };

/** A `.json` file is one value; a `.jsonl` file one value per line (blank lines skipped). */
export function parseJson(text: string, lines: boolean): Parsed {
  if (!lines) {
    try { return { ok: true, values: [{ line: null, value: JSON.parse(text) as Json }] }; } catch (e) {
      const message = (e as Error).message;
      return { ok: false, message, at: jsonErrorAt(text, message) };
    }
  }
  const values: { line: number; value: Json }[] = [];
  const rows = text.split(/\r?\n/);
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i]!.trim()) continue;
    try { values.push({ line: i + 1, value: JSON.parse(rows[i]!) as Json }); } catch (e) {
      const at = jsonErrorAt(rows[i]!, (e as Error).message);
      return { ok: false, message: (e as Error).message, at: { line: i + 1, column: at?.column ?? 1 } };
    }
  }
  return { ok: true, values };
}

const Ctx = createContext<{ openDepth: number; copy: (text: string, what: string) => void }>({ openDepth: OPEN_DEPTH, copy: () => {} });

const isBranch = (v: Json): v is Json[] | { [k: string]: Json } => v !== null && typeof v === "object";

function Scalar({ value }: { value: Json }) {
  if (value === null) return <span className="ws-json__null">null</span>;
  if (typeof value === "string") return <span className="ws-json__str">{JSON.stringify(value)}</span>;
  if (typeof value === "number") return <span className="ws-json__num">{String(value)}</span>;
  return <span className="ws-json__bool">{String(value)}</span>;
}

function CopyButtons({ path, value }: { path: string; value: Json }) {
  const { t } = useTranslation();
  const { copy } = useContext(Ctx);
  return (
    <span className="ws-json__tools">
      <Tooltip title={t("ws.json.copyPath")}>
        <button type="button" className="ws-json__tool" aria-label={t("ws.json.copyPathOf", { path })} onClick={(e) => { e.stopPropagation(); copy(path, t("ws.json.path")); }}>$</button>
      </Tooltip>
      <Tooltip title={t("ws.json.copyValue")}>
        <button type="button" className="ws-json__tool" aria-label={t("ws.json.copyValueOf", { path })}
          onClick={(e) => { e.stopPropagation(); copy(typeof value === "string" ? value : JSON.stringify(value, null, 2), t("ws.json.value")); }}>
          <Copy size={11} aria-hidden />
        </button>
      </Tooltip>
    </span>
  );
}

/** One key and its value; an object or array opens and closes, long ones a page at a time. */
function Node({ name, value, path, depth, last }: { name: ReactNode; value: Json; path: string; depth: number; last: boolean }) {
  const { t } = useTranslation();
  const { openDepth } = useContext(Ctx);
  const [open, setOpen] = useState(depth < openDepth);
  const [shown, setShown] = useState(PAGE);
  const comma = last ? null : <span className="ws-json__punct">,</span>;
  const label = name === null ? null : <><span className="ws-json__key">{name}</span><span className="ws-json__punct">: </span></>;
  if (!isBranch(value)) {
    return (
      <div className="ws-json__row" style={{ paddingLeft: depth * 16 + 18 }}>
        {label}<Scalar value={value} />{comma}<CopyButtons path={path} value={value} />
      </div>
    );
  }
  const array = Array.isArray(value);
  const entries: [string | number, Json][] = array ? value.map((v, i) => [i, v]) : Object.entries(value);
  const [l, r] = array ? ["[", "]"] : ["{", "}"];
  const count = array ? t("ws.json.items", { count: entries.length }) : t("ws.json.keys", { count: entries.length });
  if (!entries.length) {
    return <div className="ws-json__row" style={{ paddingLeft: depth * 16 + 18 }}>{label}<span className="ws-json__punct">{l}{r}</span>{comma}</div>;
  }
  return (
    <>
      <div className="ws-json__row ws-json__row--branch" style={{ paddingLeft: depth * 16 }}>
        <button type="button" className="ws-json__toggle" aria-expanded={open} aria-label={`${open ? t("ws.json.collapse") : t("ws.json.expand")} ${path}`} onClick={() => setOpen(!open)}>
          <ChevronRight size={12} aria-hidden />
        </button>
        {label}<span className="ws-json__punct">{l}</span>
        {open ? null : <><button type="button" className="ws-json__summary" onClick={() => setOpen(true)}>{count}</button><span className="ws-json__punct">{r}</span>{comma}</>}
        <CopyButtons path={path} value={value} />
      </div>
      {open ? (
        <>
          {entries.slice(0, shown).map(([k, v], i) => (
            <Node key={k} name={array ? null : JSON.stringify(k)} value={v} path={jsonPath(path, k)} depth={depth + 1} last={i === entries.length - 1} />
          ))}
          {entries.length > shown ? (
            <div className="ws-json__row" style={{ paddingLeft: (depth + 1) * 16 + 18 }}>
              <button type="button" className="ws-link" onClick={() => setShown(shown + PAGE)}>{t("ws.json.more", { count: Math.min(PAGE, entries.length - shown), total: entries.length - shown })}</button>
            </div>
          ) : null}
          <div className="ws-json__row" style={{ paddingLeft: depth * 16 + 18 }}><span className="ws-json__punct">{r}</span>{comma}</div>
        </>
      ) : null}
    </>
  );
}

/** Pretty JSON with its tokens coloured, one numbered line each. */
function Raw({ values }: { values: Json[] }) {
  const lines = useMemo(() => values.map((v) => JSON.stringify(v, null, 2)).join("\n").split("\n"), [values]);
  const token = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  const paint = (line: string) => {
    const out: ReactNode[] = [];
    let at = 0;
    for (const m of line.matchAll(token)) {
      if (m.index! > at) out.push(line.slice(at, m.index));
      const cls = m[1] ? (m[2] ? "ws-json__key" : "ws-json__str") : m[3] ? "ws-json__bool" : m[0] === "null" ? "ws-json__null" : "ws-json__num";
      out.push(<span key={m.index} className={cls}>{m[1] ?? m[0]}</span>);
      if (m[2]) out.push(m[2]);
      at = m.index! + m[0].length;
    }
    out.push(line.slice(at));
    return out;
  };
  return (
    <pre className="ws-json__raw">
      {lines.map((line, i) => <div key={i} className="ws-json__line"><span className="ws-json__ln" aria-hidden>{i + 1}</span><span>{paint(line)}</span></div>)}
    </pre>
  );
}

/**
 * A JSON (or JSON Lines) file to read: a tree that opens and closes (three levels open at first), each kind of value in
 * its colour, the path or value of any node copied in one click, or the whole thing pretty-printed. A file that does
 * not parse says where it broke and shows as text.
 */
export function JsonView({ text, lines = false }: { text: string; lines?: boolean }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const parsed = useMemo(() => parseJson(text, lines), [text, lines]);
  const [view, setView] = useState<"tree" | "raw">("tree");
  const [openDepth, setOpenDepth] = useState(OPEN_DEPTH);
  const [generation, setGeneration] = useState(0);
  const copy = (value: string, what: string) => {
    void navigator.clipboard?.writeText(value).then(() => void message.success(t("ws.json.copied", { what })), () => void message.error(t("ws.json.copyFailed")));
  };
  const ctx = useMemo(() => ({ openDepth, copy }), [openDepth]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!parsed.ok) {
    return (
      <div className="ws-json">
        <div className="ws-json__error" role="alert">
          <AlertTriangle size={14} aria-hidden />
          <span>{parsed.at ? t("ws.json.invalidAt", { line: parsed.at.line, column: parsed.at.column }) : t("ws.json.invalid")} <code>{parsed.message}</code></span>
        </div>
        <pre className="ws-json__raw">
          {text.split("\n").map((line, i) => (
            <div key={i} className={`ws-json__line${parsed.at?.line === i + 1 ? " ws-json__line--bad" : ""}`}><span className="ws-json__ln" aria-hidden>{i + 1}</span><span>{line}</span></div>
          ))}
        </pre>
      </div>
    );
  }
  const openAll = (depth: number) => { setOpenDepth(depth); setGeneration(generation + 1); };
  return (
    <Ctx.Provider value={ctx}>
      <div className="ws-json">
        <div className="ws-json__bar">
          <Segmented size="small" value={view} onChange={(v) => setView(v as "tree" | "raw")}
            options={[{ value: "tree", label: t("ws.json.tree") }, { value: "raw", label: t("ws.json.raw") }]} />
          {lines ? <span className="ws-hint">{t("ws.json.records", { count: parsed.values.length })}</span> : null}
          <span className="ws-spacer" />
          {view === "tree" ? (
            <>
              <Tooltip title={t("ws.json.expandAll")}><button type="button" className="ws-icon-button" aria-label={t("ws.json.expandAll")} onClick={() => openAll(Infinity)}><ChevronsUpDown size={15} /></button></Tooltip>
              <Tooltip title={t("ws.json.collapseAll")}><button type="button" className="ws-icon-button" aria-label={t("ws.json.collapseAll")} onClick={() => openAll(0)}><ChevronsDownUp size={15} /></button></Tooltip>
            </>
          ) : null}
          <Tooltip title={t("ws.json.copyAll")}>
            <button type="button" className="ws-icon-button" aria-label={t("ws.json.copyAll")} onClick={() => copy(parsed.values.map((v) => JSON.stringify(v.value, null, lines ? 0 : 2)).join("\n"), t("ws.json.file"))}><Copy size={15} /></button>
          </Tooltip>
        </div>
        {view === "raw" ? <Raw values={parsed.values.map((v) => v.value)} /> : (
          <div className="ws-json__tree" key={generation}>
            {parsed.values.map((v, i) => (
              <div key={i} className={lines ? "ws-json__record" : undefined}>
                {lines ? <div className="ws-json__record-head">{t("ws.json.line", { line: v.line })}</div> : null}
                <Node name={null} value={v.value} path="$" depth={0} last />
              </div>
            ))}
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}
