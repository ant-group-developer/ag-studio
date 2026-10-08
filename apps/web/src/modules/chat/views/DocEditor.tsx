import { Input, InputNumber, Select } from "antd";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TextLook } from "@harness/contracts";
import { TextLookInput } from "../../production/TextLookInput";
import { DOC_SPECS, valueAt, type DocKind, type FieldSpec } from "./doc-specs";

/** `doc` with `value` at the dotted `path`, copied along the way (the rest is shared). */
export function setAt<T>(doc: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".");
  const node = (doc && typeof doc === "object" ? doc : {}) as Record<string, unknown>;
  return { ...node, [head!]: rest.length ? setAt(node[head!], rest.join("."), value) : value } as T;
}

type Item = Record<string, unknown>;
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="chat-edit__remove" aria-label={label} title={label} onClick={onClick}><X size={14} aria-hidden /></button>;
}

function AddButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return <button type="button" className="chat-edit__add" onClick={onClick}><Plus size={14} aria-hidden />{t("chat.edit.add")}</button>;
}

/** One field of a document as a form control, by the kind its spec gives it. */
function FieldInput({ field, value, onChange, label }: { field: FieldSpec; value: unknown; onChange: (v: unknown) => void; label: string }) {
  const { t } = useTranslation();
  switch (field.kind) {
    case "text":
      return <Input.TextArea aria-label={label} value={str(value)} autoSize={{ minRows: 1, maxRows: 14 }} onChange={(e) => onChange(e.target.value)} />;
    case "choice":
      return <Select aria-label={label} value={str(value) || undefined} style={{ width: "100%" }} onChange={(v: string) => onChange(v)}
        options={(field.options ?? []).map((o) => ({ value: o, label: o }))} />;
    case "number":
      return <InputNumber aria-label={label} value={typeof value === "number" ? value : null} min={0} precision={0} onChange={(v) => onChange(v ?? null)} />;
    case "seconds":
      return (
        <span className="chat-edit__inline">
          <InputNumber aria-label={label} value={typeof value === "number" ? value : null} min={0} onChange={(v) => onChange(v ?? null)} />
          <span className="chat-doc__note">{t("chat.edit.seconds")}</span>
        </span>
      );
    case "chips":
      return (
        <Select aria-label={label} mode="tags" value={asList(value).map(str)} tokenSeparators={[","]} open={false} suffixIcon={null}
          style={{ width: "100%" }} onChange={(v: string[]) => onChange(v)} />
      );
    case "list": {
      const items = asList(value).map(str);
      return (
        <div className="chat-edit__list">
          {items.map((x, i) => (
            <div key={i} className="chat-edit__row">
              <Input.TextArea aria-label={`${label} ${i + 1}`} value={x} autoSize={{ minRows: 1, maxRows: 8 }}
                onChange={(e) => onChange(items.map((y, k) => (k === i ? e.target.value : y)))} />
              <RemoveButton label={t("chat.edit.remove")} onClick={() => onChange(items.filter((_, k) => k !== i))} />
            </div>
          ))}
          <AddButton onClick={() => onChange([...items, ""])} />
        </div>
      );
    }
    case "pairs": {
      const [a, b] = field.pair ?? ["title", "text"];
      const items = asList(value) as Item[];
      // a thumbnail idea's asset is chosen by Claude from the footage: kept as it is, never typed
      const fixed = b === "asset_id";
      const put = (i: number, k: string, v: string) => onChange(items.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
      return (
        <div className="chat-edit__list">
          {items.map((it, i) => (
            <div key={i} className="chat-edit__pair">
              <div className="chat-edit__pair-body">
                <Input aria-label={`${label} ${i + 1}`} value={str(it[a])} onChange={(e) => put(i, a, e.target.value)} />
                {fixed ? <span className="chat-doc__note">{str(it[b])}</span>
                  : <Input.TextArea aria-label={`${label} ${i + 1} · 2`} value={str(it[b])} autoSize={{ minRows: 1, maxRows: 6 }} onChange={(e) => put(i, b, e.target.value)} />}
              </div>
              <RemoveButton label={t("chat.edit.remove")} onClick={() => onChange(items.filter((_, k) => k !== i))} />
            </div>
          ))}
          {fixed ? null : <AddButton onClick={() => onChange([...items, { [a]: "", [b]: "" }])} />}
        </div>
      );
    }
    case "look":
      return <TextLookInput value={(value ?? null) as TextLook | null} onChange={(v) => onChange(v)} />;
    case "palette": {
      const pal = (value && typeof value === "object" ? value : {}) as Record<string, string>;
      return (
        <div className="chat-doc__palette">
          {Object.entries(pal).map(([k, c]) => (
            <label key={k} className="chat-edit__inline">
              <input type="color" aria-label={`${label} ${k}`} value={/^#[0-9a-f]{6}$/i.test(c) ? c : "#000000"} onChange={(e) => onChange({ ...pal, [k]: e.target.value })} />
              <span>{k}</span>
            </label>
          ))}
        </div>
      );
    }
    case "episodes": {
      const eps = asList(value) as Item[];
      const put = (i: number, k: string, v: unknown) => onChange(eps.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
      return (
        <div className="chat-edit__list">
          {eps.map((e, i) => (
            <div key={i} className="chat-doc__episode">
              <Input aria-label={t("chat.edit.episodeTitle", { n: i + 1 })} value={str(e.title)} onChange={(x) => put(i, "title", x.target.value)} />
              <span className="chat-edit__inline">
                <InputNumber aria-label={t("chat.edit.episodeLength", { n: i + 1 })} value={typeof e.target_seconds === "number" ? e.target_seconds : null} min={10}
                  onChange={(v) => put(i, "target_seconds", v ?? e.target_seconds)} />
                <span className="chat-doc__note">{t("chat.edit.seconds")} · {asList(e.items).length} clip</span>
              </span>
            </div>
          ))}
        </div>
      );
    }
  }
}

/** A step's document as a form, the fields of its spec in order; fields the spec does not show are kept as they are. */
export function DocEditor({ kind, value, onChange }: { kind: DocKind; value: unknown; onChange: (v: unknown) => void }) {
  const { t } = useTranslation();
  return (
    <div className="chat-edit">
      {DOC_SPECS[kind].map((f) => {
        const label = t(`chat.fields.${f.label}`);
        return (
          <div key={f.path} className="chat-edit__field">
            <span className="chat-edit__label">{label}</span>
            <FieldInput field={f} label={label} value={valueAt(value, f.path)} onChange={(v) => onChange(setAt(value, f.path, v))} />
          </div>
        );
      })}
    </div>
  );
}
