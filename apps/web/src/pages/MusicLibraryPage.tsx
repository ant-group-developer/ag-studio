/**
 * The team's music library (plan 2026-10-08 task 29): background tracks tagged by mood that a shot-cut episode with no
 * music of its own is given (cut 1.1.0), and that the editor's music picker lists. Everyone listens; a Studio admin
 * uploads, retags, retires or brings back a track.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App as AntApp, Button, Checkbox, Input, Select } from "antd";
import { useTranslation } from "react-i18next";
import { MUSIC_ORIGINS, StudioHttpError, useStudioClient, type MusicOrigin, type MusicTrackView } from "../api/studio-client";
import { ChatShell } from "../modules/chat/ChatShell";

const LIBRARY_KEY = ["music-library"];

function duration(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

export function MusicLibraryPage() {
  const { t } = useTranslation();
  const client = useStudioClient();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => client.getMe(), staleTime: 5 * 60_000 });
  const { data, isLoading } = useQuery({ queryKey: LIBRARY_KEY, queryFn: () => client.listMusic() });
  const admin = me?.isAdmin ?? false;
  const tracks = data?.tracks ?? [];

  return (
    <ChatShell>
      <main className="chat-main chat-queue">
        <h1>{t("chat.music.title")}</h1>
        <p className="chat-doc__note">{t("chat.music.intro")}</p>
        {admin ? <UploadForm /> : null}
        <section aria-label={t("chat.music.tracks")}>
          <div className="chat-queue__head"><h2>{t("chat.music.tracks")}</h2></div>
          {tracks.length ? (
            <ul className="chat-queue__list">{tracks.map((x) => <TrackRow key={x.trackId} track={x} admin={admin} />)}</ul>
          ) : isLoading ? null : <p className="chat-doc__note">{t("chat.music.empty")}</p>}
        </section>
      </main>
    </ChatShell>
  );
}

function TrackRow({ track, admin }: { track: MusicTrackView; admin: boolean }) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const update = useMutation({
    mutationFn: (patch: { moods?: string[]; active?: boolean }) => client.updateMusic(track.trackId, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: LIBRARY_KEY }),
    onError: () => void message.error(t("chat.music.saveFailed")),
  });
  return (
    <li className="chat-music__track" aria-label={track.displayName}>
      <div>
        <strong>{track.displayName}</strong>
        {track.active ? null : <span className="chat-doc__note"> · {t("chat.music.retired")}</span>}
        <div className="chat-doc__note">
          {t("chat.music.line", { duration: duration(track.durationSeconds), origin: t(`chat.music.origins.${track.origin}`), note: track.originNote })}
          {track.loopOk ? ` · ${t("chat.music.loops")}` : ""}
        </div>
      </div>
      {admin ? (
        <Select mode="tags" size="small" aria-label={t("chat.music.moods")} value={track.moods} style={{ minWidth: 200 }} tokenSeparators={[","]}
          onChange={(moods: string[]) => { if (moods.length) update.mutate({ moods }); }} />
      ) : (
        <ul className="chat-doc__chips">{track.moods.map((m) => <li key={m}>{m}</li>)}</ul>
      )}
      <audio controls preload="none" src={track.listenUrl} aria-label={t("chat.music.listen", { name: track.displayName })} />
      {admin ? (
        <Button size="small" onClick={() => update.mutate({ active: !track.active })} loading={update.isPending}>
          {track.active ? t("chat.music.retire") : t("chat.music.restore")}
        </Button>
      ) : null}
    </li>
  );
}

function UploadForm() {
  const { t } = useTranslation();
  const client = useStudioClient();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [file, setFile] = useState<File | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [moods, setMoods] = useState<string[]>([]);
  const [origin, setOrigin] = useState<MusicOrigin>("royalty_free");
  const [originNote, setOriginNote] = useState("");
  const [loopOk, setLoopOk] = useState(false);
  const ready = !!file && displayName.trim() && moods.length > 0 && originNote.trim();
  const add = useMutation({
    mutationFn: () => client.addMusic({ file: file!, displayName: displayName.trim(), moods, origin, originNote: originNote.trim(), loopOk }),
    onSuccess: (track) => {
      void qc.invalidateQueries({ queryKey: LIBRARY_KEY });
      void message.success(t("chat.music.added", { name: track.displayName }));
      setFile(null); setDisplayName(""); setMoods([]); setOriginNote(""); setLoopOk(false);
    },
    onError: (e) => {
      const code = e instanceof StudioHttpError ? (e.body as { code?: string } | null)?.code : undefined;
      void message.error(code ? t(`chat.audio.errors.${code}`, { defaultValue: t("chat.music.addFailed") }) : t("chat.music.addFailed"));
    },
  });
  return (
    <section aria-label={t("chat.music.add")}>
      <div className="chat-queue__head"><h2>{t("chat.music.add")}</h2></div>
      <form className="chat-music__form" onSubmit={(e) => { e.preventDefault(); if (ready) add.mutate(); }}>
        <input type="file" accept="audio/*" aria-label={t("chat.music.file")} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <Input aria-label={t("chat.music.name")} placeholder={t("chat.music.name")} value={displayName} maxLength={120} onChange={(e) => setDisplayName(e.target.value)} />
        <Select mode="tags" aria-label={t("chat.music.moods")} placeholder={t("chat.music.moodsHint")} value={moods} tokenSeparators={[","]}
          onChange={(v: string[]) => setMoods(v)} style={{ minWidth: 220 }} />
        <Select aria-label={t("chat.music.origin")} value={origin} onChange={(v: MusicOrigin) => setOrigin(v)} style={{ width: 180 }}
          options={MUSIC_ORIGINS.map((o) => ({ value: o, label: t(`chat.music.origins.${o}`) }))} />
        <Input aria-label={t("chat.music.originNote")} placeholder={t("chat.music.originNoteHint")} value={originNote} maxLength={500}
          onChange={(e) => setOriginNote(e.target.value)} />
        <Checkbox checked={loopOk} onChange={(e) => setLoopOk(e.target.checked)}>{t("chat.music.loopOk")}</Checkbox>
        <Button type="primary" htmlType="submit" disabled={!ready} loading={add.isPending}>{t("chat.music.upload")}</Button>
      </form>
    </section>
  );
}
