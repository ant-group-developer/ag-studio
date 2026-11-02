import { useEffect, useState } from "react";
import { App as AntApp, Button, Empty, Input, Modal, Pagination, Segmented, Spin } from "antd";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Loader2, Music, Pause, Play, Plus } from "lucide-react";
import { StudioHttpError } from "../../api/http";
import { AG_MUSIC_TRACK_TYPES, useWorkspaceClient, type AgMusicTrack, type AgMusicTrackType, type MediaItem } from "../../api/workspace-client";
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

/** Whether Studio is wired to ag-music (asked once a session; off when the API cannot say). */
export function useAgMusicEnabled(enabled: boolean): boolean {
  const client = useWorkspaceClient();
  const status = useQuery({ queryKey: ["ag-music-status"], enabled, staleTime: Infinity, retry: false, queryFn: () => client.agMusicStatus() });
  return status.data?.enabled === true;
}

/** One track: listen, what it is, and the button that brings it into the library (or says it is there). */
function TrackRow({ track, playing, loading, onPlay, onFetch, fetching, fetched }: {
  track: AgMusicTrack; playing: boolean; loading: boolean; onPlay: () => void; onFetch: () => void; fetching: boolean; fetched: boolean;
}) {
  const { t } = useAiTranslation();
  const meta = [t(`ws.library.agMusic.type.${track.type}`), track.artists.join(", "), track.categories.join(", "),
    track.durationMs ? clock(track.durationMs / 1000) : null, track.bpm ? `${track.bpm} BPM` : null].filter(Boolean).join(" · ");
  return (
    <li className="ws-agm__row">
      <button type="button" className="ws-mpick__play" onClick={onPlay} aria-pressed={playing} aria-busy={loading} disabled={loading}
        aria-label={playing ? t("ws.audio.pauseNamed", { name: track.name }) : t("ws.audio.playNamed", { name: track.name })}>
        {loading ? <Loader2 size={13} className="ws-spin" aria-hidden /> : playing ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}
      </button>
      <span className="ws-agm__cover" aria-hidden>{track.thumbnailUrl ? <img src={track.thumbnailUrl} alt="" loading="lazy" /> : <Music size={16} />}</span>
      <div className="ws-inputs__text">
        <span className="ws-inputs__name" title={track.name}>{track.name}{track.code ? <span className="ws-hint"> · {track.code}</span> : null}</span>
        <span className="ws-hint">{meta}</span>
      </div>
      {fetched ? (
        <span className="ws-agm__have"><Check size={13} aria-hidden /> {t("ws.library.agMusic.inLibrary")}</span>
      ) : (
        <Button size="small" icon={<Plus size={14} />} loading={fetching} onClick={onFetch} aria-label={t("ws.library.agMusic.fetchNamed", { name: track.name })}>
          {t("ws.library.agMusic.fetch")}
        </Button>
      )}
    </li>
  );
}

/**
 * Music from ag-music-v2 into the person's library (2026-11-01): the approved tracks they may see there, by name and
 * type, listened to before picking; a picked track is copied into the library and handed to `onFetched`.
 */
export function AgMusicPicker({ open, onClose, onFetched }: { open: boolean; onClose: () => void; onFetched: (item: MediaItem) => void }) {
  const { t } = useAiTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const [q, setQ] = useState("");
  const [type, setType] = useState<AgMusicTrackType | "all">("all");
  const [page, setPage] = useState(0);
  const [listening, setListening] = useState<{ trackId: number; url: string } | null>(null);
  const [fetched, setFetched] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (!open) { setListening(null); return; }
    setQ(""); setType("all"); setPage(0); setFetched(new Set());
  }, [open]);
  // Asked of ag-music once typing pauses, not on every key
  const query = useDebouncedValue(q.trim(), 300);
  const list = useQuery({
    queryKey: ["ag-music-tracks", query, type, page], enabled: open, retry: false,
    queryFn: () => client.listAgMusicTracks({ ...(query ? { q: query } : {}), ...(type !== "all" ? { type } : {}), page, size: PAGE_SIZE }),
  });
  const listen = useMutation({
    mutationFn: (trackId: number) => client.agMusicListen(trackId),
    onSuccess: (r, trackId) => setListening({ trackId, url: r.url }),
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
    else listen.mutate(trackId);
  };

  return (
    <Modal open={open} title={<span className="ws-mlib__title"><Music size={16} aria-hidden />{t("ws.library.agMusic.title")}</span>}
      footer={null} onCancel={onClose} width={760} destroyOnHidden>
      <p className="ws-hint" style={{ marginTop: 0 }}>{t("ws.library.agMusic.hint")}</p>
      <div className="ws-mlib__tools">
        <Segmented<AgMusicTrackType | "all"> size="small" value={type} onChange={(v) => { setType(v); setPage(0); }} aria-label={t("ws.library.agMusic.typeLabel")}
          options={[{ value: "all", label: t("ws.library.kind.all") }, ...AG_MUSIC_TRACK_TYPES.map((v) => ({ value: v, label: t(`ws.library.agMusic.type.${v}`) }))]} />
        <Input.Search size="small" allowClear placeholder={t("ws.library.agMusic.search")} aria-label={t("ws.library.agMusic.search")}
          value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
      </div>
      {list.isLoading ? <div className="ws-center"><Spin /></div>
        : list.isError ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={agMusicErrorText(t, list.error, "ws.library.agMusic.listFailed")} />
          : list.data?.items.length ? (
            <>
              <ul className="ws-agm__list" aria-label={t("ws.library.agMusic.title")}>
                {list.data.items.map((track) => (
                  <TrackRow key={track.trackId} track={track} playing={listening?.trackId === track.trackId} onPlay={() => toggle(track.trackId)}
                    loading={listen.isPending && listen.variables === track.trackId}
                    fetched={!!track.mediaId || fetched.has(track.trackId)} fetching={fetchTrack.isPending && fetchTrack.variables === track.trackId}
                    onFetch={() => fetchTrack.mutate(track.trackId)} />
                ))}
              </ul>
              {list.data.total > PAGE_SIZE ? (
                <Pagination size="small" className="ws-agm__pages" current={page + 1} pageSize={PAGE_SIZE} total={list.data.total} showSizeChanger={false}
                  onChange={(p) => setPage(p - 1)} />
              ) : null}
            </>
          ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query ? t("ws.library.noMatch") : t("ws.library.agMusic.empty")} />}
      {listening ? <audio key={listening.url} src={listening.url} autoPlay onEnded={() => setListening(null)} hidden /> : null}
    </Modal>
  );
}
