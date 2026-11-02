import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { App as AntApp, Button, Checkbox, Drawer, Empty, Input, InputNumber, Pagination, Segmented, Select, Spin } from "antd";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import {
  Activity, Bookmark, Check, ChevronDown, ChevronRight, ChevronUp, Download, Flag, Layers, Loader2, Mic, Music, Palette, Pause, Play, Plus, Search,
  SlidersVertical, Smile, Sparkles, Tag, User, Users, type LucideIcon,
} from "lucide-react";
import { StudioHttpError } from "../../api/http";
import {
  AG_MUSIC_CATEGORY_KINDS, AG_MUSIC_SORTS, AG_MUSIC_TRACK_TYPES, useWorkspaceClient,
  type AgMusicCategoryKind, type AgMusicFacets, type AgMusicFilter, type AgMusicSort, type AgMusicTrack, type AgMusicTrackType, type MediaItem,
} from "../../api/workspace-client";
import { useDebouncedValue } from "../../helpers/use-debounced-value";
import { useAiTranslation } from "../common/assistant-name";
import { clock } from "../workspace/time";
import "./inputs.css";

const PAGE_SIZE = 20;

/** Codes of the API's ag-music answers that have their own text here, in the language of the page. */
const ERROR_CODES = ["ag_music_forbidden", "ag_music_unauthorized", "ag_music_unavailable", "ag_music_not_found",
  "track_not_approved", "track_copyright_violation", "file_too_large"] as const;

/** What went wrong, by the API's code (its message is Vietnamese only), else `fallback`. */
export function agMusicErrorText(t: (key: string) => string, e: unknown, fallback: string): string {
  const code = e instanceof StudioHttpError ? e.code : undefined;
  return code && (ERROR_CODES as readonly string[]).includes(code) ? t(`ws.library.agMusic.error.${code}`) : t(fallback);
}

/** One sound at a time: an audio starting pauses every other one on the page (the library's players, the picker's). */
export function pauseOthers(playing: HTMLMediaElement): void {
  for (const el of document.querySelectorAll<HTMLMediaElement>("audio, video")) if (el !== playing && !el.paused) el.pause();
}

/** Whether Studio is wired to ag-music (asked once a session; off when the API cannot say). */
export function useAgMusicEnabled(enabled: boolean): boolean {
  const client = useWorkspaceClient();
  const status = useQuery({ queryKey: ["ag-music-status"], enabled, staleTime: Infinity, retry: false, queryFn: () => client.agMusicStatus() });
  return status.data?.enabled === true;
}

type EnumKey = "voiceGenders" | "purposes" | "origins" | "releaseStatuses";
type SectionKey = "vocal" | AgMusicCategoryKind | EnumKey;

/** Values of ag-music's enum filters, labelled as ag-music labels them. */
const ENUM_VALUES: Record<EnumKey, string[]> = {
  voiceGenders: ["MALE", "FEMALE", "UNKNOWN"],
  purposes: ["SHORT", "ASMR", "LICENSE"],
  origins: ["COVER_REMIX", "ORIGINAL", "LICENSED", "OTHER"],
  releaseStatuses: ["NOT_FOR_RELEASE", "UNRELEASED", "RELEASING", "RELEASED"],
};

/** The filter groups and their order by track type, as ag-music's sidebar has them. */
const LAYOUTS: Record<AgMusicTrackType | "all", SectionKey[]> = {
  all: ["vocal", "GENRE", "THEME", "MOOD", "EFFECT", "INSTRUMENT", "voiceGenders", "purposes", "releaseStatuses", "origins"],
  SONG: ["vocal", "GENRE", "THEME", "MOOD", "EFFECT", "INSTRUMENT", "releaseStatuses", "origins"],
  ASSISTED: ["vocal", "voiceGenders", "GENRE", "THEME", "INSTRUMENT", "MOOD", "EFFECT", "releaseStatuses", "origins"],
  ASSET: ["purposes", "vocal", "GENRE", "THEME", "INSTRUMENT"],
  MUSIC_INDEX: ["purposes", "vocal", "GENRE", "THEME", "INSTRUMENT"],
};

/** What the sidebar has ticked: categories by kind (ids as text), the rest by ag-music's values. */
interface Filters {
  cats: Partial<Record<AgMusicCategoryKind, string[]>>;
  vocal: string[];
  artists: string[];
  voiceGenders: string[]; purposes: string[]; origins: string[]; releaseStatuses: string[];
  bpmFrom: number | null; bpmTo: number | null;
}
const NO_FILTERS: Filters = { cats: {}, vocal: [], artists: [], voiceGenders: [], purposes: [], origins: [], releaseStatuses: [], bpmFrom: null, bpmTo: null };

function toQuery(f: Filters, type: AgMusicTrackType | "all", q: string): AgMusicFilter {
  const categoryIds = AG_MUSIC_CATEGORY_KINDS.flatMap((k) => (f.cats[k] ?? []).map(Number));
  return {
    ...(q ? { q } : {}), ...(type !== "all" ? { type } : {}),
    ...(categoryIds.length ? { categoryIds } : {}),
    ...(f.artists.length ? { artistIds: f.artists.map(Number) } : {}),
    // both "with words" and "instrumental" ticked: no filter
    ...(f.vocal.length === 1 ? { instrumental: f.vocal[0] === "true" } : {}),
    ...(f.voiceGenders.length ? { voiceGenders: f.voiceGenders } : {}),
    ...(f.purposes.length ? { purposes: f.purposes } : {}),
    ...(f.origins.length ? { origins: f.origins } : {}),
    ...(f.releaseStatuses.length ? { releaseStatuses: f.releaseStatuses } : {}),
    ...(f.bpmFrom ? { bpmFrom: f.bpmFrom } : {}),
    ...(f.bpmTo ? { bpmTo: f.bpmTo } : {}),
  };
}

/** About `bars` bars from ag-music's peaks, each the loudest of its stretch, scaled to 0..1. */
function bars(peaks: number[], count: number): number[] {
  const step = Math.max(1, peaks.length / count);
  const out = Array.from({ length: Math.min(count, peaks.length) }, (_, i) => {
    let m = 0;
    for (let j = Math.floor(i * step); j < Math.max(Math.floor((i + 1) * step), Math.floor(i * step) + 1); j++) m = Math.max(m, Math.abs(peaks[j] ?? 0));
    return m;
  });
  const max = Math.max(...out, 0);
  return max > 0 ? out.map((v) => Math.max(0.04, v / max)) : out;
}

/** The track's waveform (from ag-music's peaks); played part in the accent colour; a click plays from there. */
function Waveform({ peaks, progress, label, onSeek }: { peaks: number[] | null | undefined; progress: number; label: string; onSeek: (at: number) => void }) {
  const clip = useId();
  const shape = useMemo(() => (peaks?.length ? bars(peaks, 120) : []), [peaks]);
  if (!shape.length) return <span className="ws-agm__wave ws-agm__wave--none" aria-hidden />;
  const n = shape.length;
  const path = shape.map((v, i) => `M${i + 0.5} ${50 - v * 48}V${50 + v * 48}`).join("");
  const seek = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onSeek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
  };
  return (
    <button type="button" className="ws-agm__wave" onClick={seek} aria-label={label}>
      <svg viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" aria-hidden>
        <defs><clipPath id={clip}><rect x="0" y="0" width={progress * n} height="100" /></clipPath></defs>
        <path d={path} className="ws-agm__wave-base" />
        <path d={path} className="ws-agm__wave-done" clipPath={`url(#${clip})`} />
      </svg>
    </button>
  );
}

/** One track: listen, its waveform, what it is, downloads, and the button that brings it into the library (or says it is there). */
function TrackRow({ track, playing, progress, loading, onPlay, onSeek, onFetch, fetching, fetched }: {
  track: AgMusicTrack; playing: boolean; progress: number; loading: boolean; onPlay: () => void; onSeek: (at: number) => void;
  onFetch: () => void; fetching: boolean; fetched: boolean;
}) {
  const { t } = useAiTranslation();
  const meta = [t(`ws.library.agMusic.type.${track.type}`), track.artists.join(", "), track.categories.join(", "),
    track.bpm ? `${track.bpm} BPM` : null].filter(Boolean).join(" · ");
  return (
    <li className={`ws-agm__row${playing ? " ws-agm__row--on" : ""}`}>
      <button type="button" className="ws-mpick__play" onClick={onPlay} aria-pressed={playing} aria-busy={loading} disabled={loading}
        aria-label={playing ? t("ws.audio.pauseNamed", { name: track.name }) : t("ws.audio.playNamed", { name: track.name })}>
        {loading ? <Loader2 size={13} className="ws-spin" aria-hidden /> : playing ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}
      </button>
      <span className="ws-agm__cover" aria-hidden>{track.thumbnailUrl ? <img src={track.thumbnailUrl} alt="" loading="lazy" /> : <Music size={16} />}</span>
      <div className="ws-agm__text">
        <span className="ws-inputs__name" title={track.name}>{track.name}{track.code ? <span className="ws-hint"> · {track.code}</span> : null}</span>
        <span className="ws-hint ws-agm__meta" title={meta}>{meta}</span>
      </div>
      <Waveform peaks={track.peaks} progress={playing ? progress : 0} onSeek={onSeek} label={t("ws.library.agMusic.seekNamed", { name: track.name })} />
      <span className="ws-agm__num">{track.durationMs ? clock(track.durationMs / 1000) : "–"}</span>
      <span className="ws-agm__num ws-agm__dl" title={t("ws.library.agMusic.downloads")}>
        <Download size={12} aria-hidden /><span className="ws-sr">{t("ws.library.agMusic.downloads")}: </span>{(track.downloadCount ?? 0).toLocaleString()}
      </span>
      <span className="ws-agm__act">
        {fetched ? (
          <span className="ws-agm__have"><Check size={13} aria-hidden /> {t("ws.library.agMusic.inLibrary")}</span>
        ) : (
          <Button size="small" icon={<Plus size={14} />} loading={fetching} onClick={onFetch} aria-label={t("ws.library.agMusic.fetchNamed", { name: track.name })}>
            {t("ws.library.agMusic.fetch")}
          </Button>
        )}
      </span>
    </li>
  );
}

interface Choice { value: string; label: string; count: number | null }
/** One group of the sidebar: ticks among choices, a range (BPM). */
interface Group { key: string; title: string; icon: LucideIcon; active: number; choices?: Choice[]; value?: string[]; onChange?: (v: string[]) => void; range?: boolean }

const GROUP_ICONS: Record<SectionKey | "artists" | "bpm", LucideIcon> = {
  vocal: Mic, GENRE: Tag, THEME: Palette, MOOD: Smile, EFFECT: Sparkles, INSTRUMENT: SlidersVertical,
  releaseStatuses: Flag, origins: Layers, voiceGenders: User, purposes: Bookmark, artists: Users, bpm: Activity,
};
/** A group with more choices than this has a search box. */
const SEARCH_MIN = 12;
/** Choices a long group shows before "Show more" (no scroll inside the scrolling column). */
const PREVIEW_COUNT = 8;

/** Lower case without Vietnamese marks, so "dan" finds "Đàn". */
const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

/** The sidebar's groups, as ag-music's: ticks with counts for the type's groups, then BPM and artists. */
function useGroups(type: AgMusicTrackType | "all", facets: AgMusicFacets | undefined, f: Filters, set: (f: Filters) => void): Group[] {
  const { t } = useAiTranslation();
  const count = (m: Record<string, number> | undefined, v: string) => (m ? (m[v] ?? 0) : null);
  /** With counts, only choices that still have tracks, and the ones ticked (to untick them). */
  const keep = (opts: Choice[], on: string[]) => opts.filter((o) => o.count === null || o.count > 0 || on.includes(o.value));
  const groups = LAYOUTS[type].map((key): Group | null => {
    let choices: Choice[];
    let value: string[];
    let onChange: (v: string[]) => void;
    if (key === "vocal") {
      value = f.vocal;
      choices = [{ value: "false", label: t("ws.library.agMusic.vocal.false"), count: count(facets?.instrumental, "false") },
        { value: "true", label: t("ws.library.agMusic.vocal.true"), count: count(facets?.instrumental, "true") }];
      onChange = (v) => set({ ...f, vocal: v });
    } else if ((AG_MUSIC_CATEGORY_KINDS as readonly string[]).includes(key)) {
      const kind = key as AgMusicCategoryKind;
      value = f.cats[kind] ?? [];
      choices = (facets?.categories[kind] ?? []).map((c) => ({ value: String(c.id), label: c.name, count: c.count }));
      onChange = (v) => set({ ...f, cats: { ...f.cats, [kind]: v } });
    } else {
      const k = key as EnumKey;
      value = f[k];
      choices = ENUM_VALUES[k].map((v) => ({ value: v, label: t(`ws.library.agMusic.${k}.${v}`), count: count(facets?.[k], v) }));
      onChange = (v) => set({ ...f, [k]: v });
    }
    choices = keep(choices, value);
    if (!choices.length && !value.length) return null;
    return { key, title: t(`ws.library.agMusic.group.${key}`), icon: GROUP_ICONS[key], active: value.length, choices, value, onChange };
  }).filter((g): g is Group => g !== null);
  if (type === "all" || type === "SONG") groups.push({ key: "bpm", title: "BPM", icon: Activity, active: f.bpmFrom || f.bpmTo ? 1 : 0, range: true });
  const artists = keep((facets?.artists ?? []).map((a) => ({ value: String(a.id), label: a.name, count: a.count })), f.artists);
  if (artists.length || f.artists.length) {
    groups.push({ key: "artists", title: t("ws.library.agMusic.group.artists"), icon: Users, active: f.artists.length,
      choices: artists, value: f.artists, onChange: (v) => set({ ...f, artists: v }) });
  }
  return groups;
}

/** Ticks of one group: a search box when long, the first few then "Show more", picked ones always shown. */
function GroupChoices({ group }: { group: Group }) {
  const { t } = useAiTranslation();
  const [find, setFind] = useState("");
  const [more, setMore] = useState(false);
  const choices = group.choices ?? [];
  const value = group.value ?? [];
  const needle = fold(find.trim());
  const shown = needle ? choices.filter((c) => fold(c.label).includes(needle))
    : more || choices.length <= PREVIEW_COUNT + 2 ? choices : choices.filter((c, i) => i < PREVIEW_COUNT || value.includes(c.value));
  const toggle = (v: string) => group.onChange?.(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <>
      {choices.length > SEARCH_MIN ? (
        <Input size="small" allowClear prefix={<Search size={13} aria-hidden />} className="ws-agf__search" value={find} onChange={(e) => setFind(e.target.value)}
          placeholder={t("ws.library.agMusic.findIn", { name: group.title.toLowerCase() })} aria-label={t("ws.library.agMusic.findIn", { name: group.title.toLowerCase() })} />
      ) : null}
      {needle && !shown.length ? <p className="ws-hint ws-agf__none">{t("ws.library.noMatch")}</p> : null}
      <ul className="ws-agf__options" role="group" aria-label={group.title}>
        {shown.map((c) => (
          <li key={c.value}>
            <Checkbox checked={value.includes(c.value)} onChange={() => toggle(c.value)}>
              <span className="ws-agf__label" title={c.label}>{c.label}</span>
            </Checkbox>
            {c.count !== null ? <span className="ws-agf__count">{c.count.toLocaleString()}</span> : null}
          </li>
        ))}
      </ul>
      {!needle && (more || shown.length < choices.length) ? (
        <button type="button" className="ws-agf__more" aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? <ChevronUp size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
          {more ? t("ws.library.agMusic.showLess") : t("ws.library.agMusic.showMore", { count: choices.length - shown.length })}
        </button>
      ) : null}
    </>
  );
}

/**
 * The filter column, laid out as ag-music's: a white panel, "Filters" and "Clear" on top, then one group per filter
 * (icon, name, how many ticked, folded or not) parted by hairlines; only the groups scroll. Mood and effect start folded.
 */
function FilterSidebar({ groups, filters, set, onClear }: { groups: Group[]; filters: Filters; set: (f: Filters) => void; onClear: () => void }) {
  const { t } = useAiTranslation();
  const [folded, setFolded] = useState<Set<string>>(() => new Set(["MOOD", "EFFECT"]));
  const on = groups.some((g) => g.active);
  const fold1 = (key: string) => setFolded((s) => { const n = new Set(s); if (!n.delete(key)) n.add(key); return n; });
  return (
    <aside className="ws-agf" aria-label={t("ws.inputs.picker.filters")}>
      <div className="ws-agf__head">
        <strong>{t("ws.inputs.picker.filters")}</strong>
        <Button size="small" type="link" disabled={!on} onClick={onClear}>{t("ws.inputs.picker.clearFilters")}</Button>
      </div>
      <div className="ws-agf__body">
        {groups.map((g) => {
          const Icon = g.icon;
          const open = !folded.has(g.key);
          return (
            <section key={g.key} className="ws-agf__group">
              <button type="button" className="ws-agf__group-head" aria-expanded={open} onClick={() => fold1(g.key)}>
                <Icon size={14} className="ws-agf__icon" aria-hidden />
                <span className="ws-agf__title">{g.title}</span>
                {g.active ? <span className="ws-agf__badge">{g.active}</span> : null}
                {open ? <ChevronDown size={14} className="ws-agf__chevron" aria-hidden /> : <ChevronRight size={14} className="ws-agf__chevron" aria-hidden />}
              </button>
              {!open ? null : g.range ? (
                <div className="ws-agm__range">
                  <InputNumber size="small" min={1} max={999} placeholder={t("ws.library.agMusic.from")} aria-label={t("ws.library.agMusic.bpmFrom")}
                    value={filters.bpmFrom} onChange={(v) => set({ ...filters, bpmFrom: v ?? null })} />
                  <span aria-hidden>–</span>
                  <InputNumber size="small" min={1} max={999} placeholder={t("ws.library.agMusic.to")} aria-label={t("ws.library.agMusic.bpmTo")}
                    value={filters.bpmTo} onChange={(v) => set({ ...filters, bpmTo: v ?? null })} />
                </div>
              ) : <GroupChoices group={g} />}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

/**
 * Music from ag-music-v2 into the person's library (2026-11-01), full screen like ag-music's own list: the approved
 * tracks they may see there, by type, filtered as on ag-music (genre, mood, vocal, BPM, artists...) with counts, each
 * with its waveform and downloads, listened to before picking; a picked track is copied into the library and handed to
 * `onFetched`.
 */
export function AgMusicPicker({ open, onClose, onFetched }: { open: boolean; onClose: () => void; onFetched: (item: MediaItem) => void }) {
  const { t } = useAiTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const [q, setQ] = useState("");
  const [type, setType] = useState<AgMusicTrackType | "all">("all");
  const [filters, setFiltersState] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<AgMusicSort>("NEWEST");
  const [page, setPage] = useState(0);
  const [listening, setListening] = useState<{ trackId: number; url: string; at: number } | null>(null);
  const [progress, setProgress] = useState(0);
  const [fetched, setFetched] = useState<Set<number>>(new Set());
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (!open) { setListening(null); return; }
    setQ(""); setType("all"); setFiltersState(NO_FILTERS); setSort("NEWEST"); setPage(0); setFetched(new Set());
  }, [open]);
  const setFilters = (f: Filters) => { setFiltersState(f); setPage(0); };
  // Asked of ag-music once typing (or a BPM) pauses, not on every key
  const query = useDebouncedValue(useMemo(() => toQuery(filters, type, q.trim()), [filters, type, q]), 300);
  const list = useQuery({
    queryKey: ["ag-music-tracks", query, sort, page], enabled: open, retry: false, placeholderData: keepPreviousData,
    queryFn: () => client.listAgMusicTracks({ ...query, ...(sort !== "NEWEST" ? { sort } : {}), page, size: PAGE_SIZE }),
  });
  const facets = useQuery({
    queryKey: ["ag-music-facets", query], enabled: open, retry: false, placeholderData: keepPreviousData,
    queryFn: () => client.agMusicFacets(query),
  });
  const groups = useGroups(type, facets.data, filters, setFilters);
  const listen = useMutation({
    mutationFn: ({ trackId }: { trackId: number; at: number }) => client.agMusicListen(trackId),
    onSuccess: (r, { trackId, at }) => { setProgress(at); setListening({ trackId, url: r.url, at }); },
    onError: (e) => void message.error(agMusicErrorText(t, e, "ws.library.agMusic.listenFailed")),
  });
  const fetchTrack = useMutation({
    mutationFn: (trackId: number) => client.fetchFromAgMusic(trackId),
    onSuccess: (item, trackId) => {
      setFetched((s) => new Set(s).add(trackId));
      void message.success(t("ws.library.agMusic.fetched", { name: item.name }));
      onFetched(item);
    },
    onError: (e) => void message.error(agMusicErrorText(t, e, "ws.library.agMusic.fetchFailed")),
  });
  const toggle = (trackId: number) => {
    if (listening?.trackId === trackId) setListening(null);
    else listen.mutate({ trackId, at: 0 });
  };
  /** A click on a waveform: the track playing jumps there; another one starts there. */
  const seek = (trackId: number, at: number) => {
    const el = audio.current;
    if (listening?.trackId === trackId && el && Number.isFinite(el.duration)) { el.currentTime = at * el.duration; setProgress(at); }
    else listen.mutate({ trackId, at });
  };

  const typeOptions = [{ value: "all" as const, label: t("ws.library.kind.all") }, ...AG_MUSIC_TRACK_TYPES.map((v) => ({ value: v, label: t(`ws.library.agMusic.type.${v}`) }))];
  return (
    <Drawer open={open} onClose={onClose} width="100%" destroyOnHidden rootClassName="ws-agm"
      title={<span className="ws-mlib__title"><Music size={16} aria-hidden />{t("ws.library.agMusic.title")}</span>}>
      <div className="ws-mlib__tools ws-agm__tools">
        <Segmented<AgMusicTrackType | "all"> value={type} options={typeOptions} aria-label={t("ws.library.agMusic.typeLabel")}
          onChange={(v) => { setType(v); setFilters(NO_FILTERS); }} />
        <Input.Search allowClear placeholder={t("ws.library.agMusic.search")} aria-label={t("ws.library.agMusic.search")}
          value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
        <Select<AgMusicSort> value={sort} onChange={(v) => { setSort(v); setPage(0); }} aria-label={t("ws.library.agMusic.sortLabel")} style={{ minWidth: 170 }}
          options={AG_MUSIC_SORTS.map((v) => ({ value: v, label: t(`ws.library.agMusic.sort.${v}`) }))} />
      </div>
      <div className="ws-agm__layout">
        {/* once the counts are in, again for each type (its own groups) */}
        {facets.data ? <FilterSidebar key={type} groups={groups} filters={filters} set={setFilters} onClear={() => setFilters(NO_FILTERS)} />
          : <aside className="ws-agf ws-agf--wait" aria-busy>{facets.isError ? null : <Spin size="small" />}</aside>}
        <section className="ws-agm__main">
          <div className="ws-agm__head">
            <strong>{list.data ? t("ws.library.agMusic.count", { count: list.data.total }) : t("ws.library.agMusic.title")}</strong>
            {list.isFetching && !list.isLoading ? <Spin size="small" /> : null}
          </div>
          {list.isLoading ? <div className="ws-center"><Spin /></div>
            : list.isError ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={agMusicErrorText(t, list.error, "ws.library.agMusic.listFailed")} />
              : list.data?.items.length ? (
                <ul className="ws-agm__list" aria-label={t("ws.library.agMusic.title")} aria-busy={list.isFetching}>
                  {list.data.items.map((track) => (
                    <TrackRow key={track.trackId} track={track} playing={listening?.trackId === track.trackId} progress={progress}
                      onPlay={() => toggle(track.trackId)} onSeek={(at) => seek(track.trackId, at)}
                      loading={listen.isPending && listen.variables?.trackId === track.trackId}
                      fetched={!!track.mediaId || fetched.has(track.trackId)} fetching={fetchTrack.isPending && fetchTrack.variables === track.trackId}
                      onFetch={() => fetchTrack.mutate(track.trackId)} />
                  ))}
                </ul>
              ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query.q || groups.some((g) => g.active) ? t("ws.library.noMatch") : t("ws.library.agMusic.empty")} />}
          {list.data && list.data.total > PAGE_SIZE ? (
            <Pagination size="small" className="ws-agm__pages" current={page + 1} pageSize={PAGE_SIZE} total={list.data.total} showSizeChanger={false}
              onChange={(p) => setPage(p - 1)} />
          ) : null}
        </section>
      </div>
      {listening ? (
        <audio ref={audio} key={listening.url} src={listening.url} autoPlay hidden onEnded={() => setListening(null)}
          onPlay={(e) => pauseOthers(e.currentTarget)} onPause={(e) => { if (!e.currentTarget.ended) setListening(null); }}
          onLoadedMetadata={(e) => { if (listening.at > 0) e.currentTarget.currentTime = listening.at * e.currentTarget.duration; }}
          onTimeUpdate={(e) => { const el = e.currentTarget; if (el.duration) setProgress(el.currentTime / el.duration); }} />
      ) : null}
    </Drawer>
  );
}
