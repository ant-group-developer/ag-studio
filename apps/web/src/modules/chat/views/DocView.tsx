import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { listDiff } from "../diff-doc";
import { DOC_SPECS, valueAt, type DocKind, type FieldSpec } from "./doc-specs";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function seconds(v: unknown): string {
  if (typeof v !== "number") return "";
  const m = Math.floor(v / 60);
  const s = Math.round(v % 60);
  return m ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

function scalar(field: FieldSpec, v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  return field.kind === "seconds" ? seconds(v) : String(v);
}

/** Old value struck through next to the new one, the new one highlighted (mockup "Số tập 4 3"). */
function Changed({ before, after }: { before: string; after: ReactNode }) {
  return (
    <>
      {before ? <del className="chat-doc__old">{before}</del> : null}
      <ins className="chat-doc__new">{after}</ins>
    </>
  );
}

function Field({ field, doc, prev, names }: { field: FieldSpec; doc: unknown; prev: unknown; names: Record<string, string> }) {
  const v = valueAt(doc, field.path);
  const p = prev === undefined ? v : valueAt(prev, field.path);
  const changed = prev !== undefined && !same(v, p);
  switch (field.kind) {
    case "text": case "number": case "seconds": {
      const now = scalar(field, v);
      if (!now && !changed) return null;
      return <div className="chat-doc__value">{changed ? <Changed before={scalar(field, p)} after={now} /> : now}</div>;
    }
    case "list": case "chips": {
      const items = (Array.isArray(v) ? v : []).map((x) => names[String(x)] ?? String(x));
      const before = (Array.isArray(p) ? p : []).map((x) => names[String(x)] ?? String(x));
      const d = listDiff(before, items);
      if (!items.length && !d.removed.length) return null;
      const cls = field.kind === "chips" ? "chat-doc__chips" : "chat-doc__list";
      return (
        <ul className={cls}>
          {items.map((x, i) => <li key={`${x}-${i}`}>{changed && d.added.has(x) ? <ins className="chat-doc__new">{x}</ins> : x}</li>)}
          {changed ? d.removed.map((x) => <li key={`del-${x}`}><del className="chat-doc__old">{x}</del></li>) : null}
        </ul>
      );
    }
    case "pairs": {
      const items = Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
      const before = Array.isArray(p) ? (p as Record<string, unknown>[]) : [];
      if (!items.length) return null;
      const [a, b] = field.pair ?? ["title", "text"];
      return (
        <ul className="chat-doc__list">
          {items.map((it, i) => {
            const fresh = changed && !before.some((x) => same(x, it));
            const body = <><strong>{String(it[a] ?? "")}</strong>{it[b] ? ` — ${String(it[b])}` : ""}</>;
            return <li key={i}>{fresh ? <ins className="chat-doc__new">{body}</ins> : body}</li>;
          })}
        </ul>
      );
    }
    case "palette": {
      const pal = (v ?? {}) as Record<string, string>;
      return (
        <div className="chat-doc__palette">
          {Object.entries(pal).map(([k, c]) => <span key={k}><span className="chat-swatch" style={{ background: c }} />{c}</span>)}
        </div>
      );
    }
    case "episodes": {
      const eps = Array.isArray(v) ? (v as { idx: number; title: string; target_seconds: number; items: { asset_id: string; section_title: string | null }[] }[]) : [];
      const before = Array.isArray(p) ? (p as typeof eps) : [];
      return (
        <div className="chat-doc__episodes">
          {eps.map((e, i) => {
            const old = before[i];
            const titleChanged = changed && old && old.title !== e.title;
            const lenChanged = changed && old && old.items.length !== e.items.length;
            return (
              <div key={e.idx} className="chat-doc__episode">
                <div className="chat-doc__episode-title">
                  <strong>{titleChanged ? <Changed before={old.title} after={e.title} /> : e.title}</strong>
                  <span>{seconds(e.target_seconds)} · {lenChanged ? <Changed before={String(old.items.length)} after={String(e.items.length)} /> : e.items.length} clip</span>
                </div>
                <ul className="chat-doc__chips">
                  {e.items.filter((x) => x.section_title).slice(0, 6).map((x, k) => <li key={k}>{x.section_title}</li>)}
                </ul>
              </div>
            );
          })}
          {changed && before.length > eps.length ? before.slice(eps.length).map((e) => <del key={e.idx} className="chat-doc__old">{e.title}</del>) : null}
        </div>
      );
    }
  }
}

/**
 * A step's document as people read it (spec local-chat §2.3), fields in the order of its spec; with `previous`, what
 * changed is highlighted — the new value marked, the old one struck through.
 */
export function DocView({ kind, doc, previous, names = {} }: { kind: DocKind; doc: unknown; previous?: unknown; names?: Record<string, string> }) {
  const { t } = useTranslation();
  if (kind === "trend_report" && (doc as { skipped?: boolean } | null)?.skipped) {
    return <p className="chat-doc__note">{t("chat.fields.skippedResearch")}</p>;
  }
  return (
    <dl className="chat-doc">
      {DOC_SPECS[kind].map((f) => {
        const body = <Field field={f} doc={doc} prev={previous} names={names} />;
        const v = valueAt(doc, f.path);
        const empty = v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
        if (empty && (previous === undefined || same(v, valueAt(previous, f.path)))) return null;
        return (
          <div key={f.path} className="chat-doc__row">
            <dt>{t(`chat.fields.${f.label}`)}</dt>
            <dd>{body}</dd>
          </div>
        );
      })}
    </dl>
  );
}
