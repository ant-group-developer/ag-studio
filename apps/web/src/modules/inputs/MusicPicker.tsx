import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { Button, Checkbox, Empty, Input, InputNumber, Modal, Slider } from "antd";
import {
  closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type Announcements, type DragEndEvent, type UniqueIdentifier,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Pause, Play, Plus, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { STUDIO_API_URL } from "../../api/http";
import type { MusicFilesInput, ProjectAudioFile } from "../../api/workspace-client";
import { clock } from "../workspace/time";

/** At most this many files are joined into one track (the API's `MUSIC_MIX_MAX_PARTS`). */
export const MUSIC_MAX_PARTS = 20;
const MB = 1024 * 1024;
const NO_TIME = "–:––";

/** How long the joined track plays: every part, less one crossfade between each two. Null until every length is known. */
export function joinedSeconds(seconds: (number | undefined)[], crossfadeS: number): number | null {
  if (!seconds.length || seconds.some((s) => s === undefined || !Number.isFinite(s))) return null;
  return Math.max(0, seconds.reduce<number>((sum, s) => sum + s!, 0) - crossfadeS * (seconds.length - 1));
}

/**
 * Listening to the files: one `<audio>` per file (its length read from the metadata, nothing else loaded), and only
 * one plays at a time.
 */
function usePlayer() {
  const players = useRef(new Map<string, HTMLAudioElement>());
  const [playing, setPlaying] = useState<string | null>(null);
  const [seconds, setSeconds] = useState<Record<string, number>>({});
  const toggle = (path: string) => {
    const el = players.current.get(path);
    if (!el) return;
    if (playing === path && !el.paused) { el.pause(); return; }
    for (const [p, other] of players.current) if (p !== path && !other.paused) other.pause();
    // a file the browser cannot play just stays paused
    void Promise.resolve(el.play()).catch(() => setPlaying(null));
  };
  useEffect(() => () => { for (const el of players.current.values()) el.pause(); }, []);
  const audioProps = (path: string, url: string) => ({
    ref: (el: HTMLAudioElement | null) => { if (el) players.current.set(path, el); else players.current.delete(path); },
    src: url, preload: "metadata" as const,
    onLoadedMetadata: (e: SyntheticEvent<HTMLAudioElement>) => {
      const d = e.currentTarget.duration;
      if (Number.isFinite(d)) setSeconds((s) => ({ ...s, [path]: d }));
    },
    onPlay: () => setPlaying(path),
    onPause: () => setPlaying((p) => (p === path ? null : p)),
    onEnded: () => setPlaying((p) => (p === path ? null : p)),
  });
  return { playing, seconds, toggle, audioProps };
}

/** One track of the play order: a handle to drag it (mouse, touch, or the keyboard: Space, arrows, Space), then remove. */
function OrderItem({ id, index, name, seconds, onRemove }: { id: string; index: number; name: string; seconds: number | undefined; onRemove: () => void }) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={`ws-mpick__item${isDragging ? " ws-mpick__item--drag" : ""}`}>
      <button type="button" ref={setActivatorNodeRef} className="ws-mpick__handle" {...attributes} {...listeners} aria-label={t("ws.audio.dragNamed", { name })}>
        <GripVertical size={14} aria-hidden />
      </button>
      <span className="ws-mpick__num">{index + 1}</span>
      <span className="ws-mpick__name" title={name}>{name}</span>
      <span className="ws-mpick__time">{seconds !== undefined ? clock(seconds) : NO_TIME}</span>
      <button type="button" className="ws-icon-button ws-mpick__remove" onClick={onRemove} aria-label={t("ws.audio.removeNamed", { name })}><X size={13} aria-hidden /></button>
    </li>
  );
}

/**
 * Picks the music from the project's audio files: on the left every file (find, tick, listen, its length), on the right
 * the ticked ones in the order they play — dragged into place — with the total length, the crossfade between each two,
 * and the button. One file is used as it is; several are joined. `initial`: ticked when it opens, and files uploaded
 * while it is open are added after the others.
 */
export function MusicPicker({ files, initial, busy, onUse, onUploadMore, uploading }: {
  files: ProjectAudioFile[]; initial: string[]; busy: boolean; onUse: (input: MusicFilesInput) => void;
  /** "Upload more files": they are uploaded, then ticked here. */
  onUploadMore?: (() => void) | undefined;
  /** The upload's progress label while it runs. */
  uploading?: string | null | undefined;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<string[]>(initial.slice(0, MUSIC_MAX_PARTS));
  const [fade, setFade] = useState(2);
  const [find, setFind] = useState("");
  const { playing, seconds, toggle, audioProps } = usePlayer();
  useEffect(() => {
    setChosen((c) => [...c, ...initial.filter((p) => !c.includes(p))].slice(0, MUSIC_MAX_PARTS));
  }, [initial]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const nameOf = (path: UniqueIdentifier) => files.find((f) => f.path === path)?.name ?? String(path).split("/").pop() ?? String(path);
  const toggleChosen = (path: string, on: boolean) => setChosen((c) => (on ? (c.includes(path) ? c : [...c, path]) : c.filter((p) => p !== path)));
  const shown = useMemo(() => {
    const q = find.trim().toLocaleLowerCase("vi");
    return q ? files.filter((f) => `${f.name} ${f.path}`.toLocaleLowerCase("vi").includes(q)) : files;
  }, [files, find]);
  const several = chosen.length > 1;
  const total = joinedSeconds(chosen.map((p) => seconds[p]), several ? fade : 0);
  const positionOf = (id: UniqueIdentifier | undefined) => (id === undefined ? 0 : chosen.indexOf(String(id)) + 1);
  const announcements: Announcements = {
    onDragStart: ({ active }) => t("ws.audio.dragStart", { name: nameOf(active.id), pos: positionOf(active.id) }),
    onDragOver: ({ active, over }) => (over ? t("ws.audio.dragOver", { name: nameOf(active.id), pos: positionOf(over.id) }) : undefined),
    onDragEnd: ({ active, over }) => (over ? t("ws.audio.dragEnd", { name: nameOf(active.id), pos: positionOf(over.id) }) : undefined),
    onDragCancel: ({ active }) => t("ws.audio.dragCancel", { name: nameOf(active.id) }),
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setChosen((c) => arrayMove(c, c.indexOf(String(active.id)), c.indexOf(String(over.id))));
  };

  return (
    <div className="ws-mpick">
      <section className="ws-mpick__col" aria-label={t("ws.audio.filesColumn")}>
        <Input allowClear size="small" value={find} onChange={(e) => setFind(e.target.value)} prefix={<Search size={14} aria-hidden />}
          placeholder={t("ws.audio.searchFiles")} aria-label={t("ws.audio.searchFiles")} />
        <ul className="ws-mpick__files" aria-label={t("ws.audio.pickMusicTitle")}>
          {shown.map((f) => {
            const on = chosen.includes(f.path);
            const isPlaying = playing === f.path;
            return (
              <li key={f.path} className={`ws-mpick__row${on ? " ws-mpick__row--on" : ""}`}>
                <Checkbox checked={on} disabled={!on && chosen.length >= MUSIC_MAX_PARTS} onChange={(e) => toggleChosen(f.path, e.target.checked)}
                  aria-label={t("ws.audio.pickNamed", { name: f.name })} />
                <button type="button" className="ws-mpick__play" onClick={() => toggle(f.path)} aria-pressed={isPlaying}
                  aria-label={isPlaying ? t("ws.audio.pauseNamed", { name: f.name }) : t("ws.audio.playNamed", { name: f.name })}>
                  {isPlaying ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}
                </button>
                <div className="ws-inputs__text">
                  <span className="ws-inputs__name" title={f.path}>{f.name}</span>
                  <span className="ws-hint">{(f.bytes / MB).toFixed(1)} MB · {f.path}</span>
                </div>
                <span className="ws-mpick__time">{seconds[f.path] !== undefined ? clock(seconds[f.path]!) : NO_TIME}</span>
                <audio {...audioProps(f.path, `${STUDIO_API_URL}${f.listenUrl}`)} />
              </li>
            );
          })}
          {!shown.length ? <li className="ws-hint ws-mpick__none">{t("ws.audio.noFileMatch")}</li> : null}
        </ul>
        {onUploadMore ? (
          <Button size="small" icon={<Plus size={14} />} loading={!!uploading} onClick={onUploadMore} className="ws-mpick__more">
            {uploading ?? t("ws.audio.uploadMore")}
          </Button>
        ) : null}
      </section>
      <section className="ws-mpick__col ws-mpick__col--order" aria-label={t("ws.audio.order")}>
        <div className="ws-mpick__head">
          <strong>{t("ws.audio.order")}</strong>
          <span className="ws-hint" aria-live="polite">
            {t("ws.audio.orderCount", { count: chosen.length })}{chosen.length ? ` · ${total !== null ? clock(total) : NO_TIME}` : ""}
          </span>
        </div>
        {chosen.length ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}
            accessibility={{ announcements, screenReaderInstructions: { draggable: t("ws.audio.dragHelp") } }}>
            <SortableContext items={chosen} strategy={verticalListSortingStrategy}>
              <ol className="ws-mpick__order" aria-label={t("ws.audio.order")}>
                {chosen.map((p, i) => (
                  <OrderItem key={p} id={p} index={i} name={nameOf(p)} seconds={seconds[p]} onRemove={() => toggleChosen(p, false)} />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        ) : <p className="ws-hint ws-mpick__empty">{t("ws.audio.orderEmpty", { max: MUSIC_MAX_PARTS })}</p>}
        <div className="ws-mpick__fade">
          <span id="ws-mpick-fade">{t("ws.audio.crossfade")}</span>
          <Slider min={0} max={10} step={0.5} value={fade} onChange={setFade} disabled={!several} aria-labelledby="ws-mpick-fade" className="ws-mpick__slider" />
          <InputNumber size="small" min={0} max={10} step={0.5} value={fade} disabled={!several} onChange={(v) => setFade(typeof v === "number" ? v : 0)}
            aria-label={t("ws.audio.crossfade")} />
          <span className="ws-hint">{t("ws.audio.crossfadeHint")}</span>
        </div>
        <div className="ws-audio__mixfoot">
          <Button type="primary" disabled={!chosen.length} loading={busy} onClick={() => onUse({ paths: chosen, ...(several ? { crossfadeS: fade } : {}) })}>
            {several ? t("ws.audio.joinMusic", { count: chosen.length }) : t("ws.audio.useOneAsMusic")}
          </Button>
        </div>
      </section>
    </div>
  );
}

/** The music picker in its dialog (or why there is nothing to pick yet). */
export function MusicFilesModal({ open, files, initial, busy, onUse, onClose, onUploadMore, uploading }: {
  open: boolean; files: ProjectAudioFile[]; initial: string[]; busy: boolean; onUse: (input: MusicFilesInput) => void; onClose: () => void;
  onUploadMore?: (() => void) | undefined; uploading?: string | null | undefined;
}) {
  const { t } = useTranslation();
  return (
    <Modal open={open} title={t("ws.audio.pickMusicTitle")} footer={null} onCancel={onClose} width={920} destroyOnHidden>
      {files.length ? <MusicPicker files={files} initial={initial} busy={busy} onUse={onUse} onUploadMore={onUploadMore} uploading={uploading} />
        : <Empty description={t("ws.audio.noFiles")} />}
    </Modal>
  );
}
