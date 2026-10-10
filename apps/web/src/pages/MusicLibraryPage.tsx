/**
 * The team's music library (plan 2026-10-08 task 29): background tracks tagged by mood that a video with no music of
 * its own is given (by its branding's mood), and that the agent's music tool lists. Everyone listens; a Studio admin
 * uploads, retags, retires or brings back a track.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App as AntApp, Button, Checkbox, Input, Select } from "antd";
import { useTranslation } from "react-i18next";
import { MUSIC_ORIGINS, StudioHttpError, useStudioClient, type MusicOrigin, type MusicTrackView } from "../api/studio-client";
import { WorkspaceShell } from "../modules/workspace/WorkspaceShell";
import "../modules/admin/admin.css";

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
    <WorkspaceShell crumbs={[{ label: t("ws.music.title") }]}>
      <main className="ws-page">
        <div className="ws-page__inner ws-admin__main">
          <div className="ws-page__head">
            <div>
              <h1 className="ws-page__title">{t("ws.music.title")}</h1>
              <p className="ws-page__lead">{t("ws.music.intro")}</p>
            </div>
          </div>
          {admin ? <UploadForm /> : null}
          <section className="ws-admin__section" aria-label={t("ws.music.tracks")}>
            <div className="ws-admin__head"><h2>{t("ws.music.tracks")}</h2></div>
            {tracks.length ? (
              <ul className="ws-admin__list">{tracks.map((x) => <TrackRow key={x.trackId} track={x} admin={admin} />)}</ul>
            ) : isLoading ? null : <p className="ws-admin__note">{t("ws.music.empty")}</p>}
          </section>
        </div>
      </main>
    </WorkspaceShell>
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
    onError: () => void message.error(t("ws.music.saveFailed")),
  });
  return (
    <li className="ws-admin__track" aria-label={track.displayName}>
      <div>
        <strong>{track.displayName}</strong>
        {track.active ? null : <span className="ws-admin__note"> · {t("ws.music.retired")}</span>}
        <div className="ws-admin__note">
          {t("ws.music.line", { duration: duration(track.durationSeconds), origin: t(`ws.music.origins.${track.origin}`), note: track.originNote })}
          {track.loopOk ? ` · ${t("ws.music.loops")}` : ""}
        </div>
      </div>
      {admin ? (
        <Select mode="tags" size="small" aria-label={t("ws.music.moods")} value={track.moods} style={{ minWidth: 200 }} tokenSeparators={[","]}
          onChange={(moods: string[]) => { if (moods.length) update.mutate({ moods }); }} />
      ) : (
        <ul className="ws-admin__chips">{track.moods.map((m) => <li key={m}>{m}</li>)}</ul>
      )}
      <audio controls preload="none" src={track.listenUrl} aria-label={t("ws.music.listen", { name: track.displayName })} />
      {admin ? (
        <Button size="small" onClick={() => update.mutate({ active: !track.active })} loading={update.isPending}>
          {track.active ? t("ws.music.retire") : t("ws.music.restore")}
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
      void message.success(t("ws.music.added", { name: track.displayName }));
      setFile(null); setDisplayName(""); setMoods([]); setOriginNote(""); setLoopOk(false);
    },
    onError: (e) => {
      const code = e instanceof StudioHttpError ? (e.body as { code?: string } | null)?.code : undefined;
      void message.error(code ? t(`ws.music.errors.${code}`, { defaultValue: t("ws.music.addFailed") }) : t("ws.music.addFailed"));
    },
  });
  return (
    <section className="ws-admin__section" aria-label={t("ws.music.add")}>
      <div className="ws-admin__head"><h2>{t("ws.music.add")}</h2></div>
      <form className="ws-admin__form" onSubmit={(e) => { e.preventDefault(); if (ready) add.mutate(); }}>
        <input type="file" accept="audio/*" aria-label={t("ws.music.file")} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <Input aria-label={t("ws.music.name")} placeholder={t("ws.music.name")} value={displayName} maxLength={120} onChange={(e) => setDisplayName(e.target.value)} />
        <Select mode="tags" aria-label={t("ws.music.moods")} placeholder={t("ws.music.moodsHint")} value={moods} tokenSeparators={[","]}
          onChange={(v: string[]) => setMoods(v)} style={{ minWidth: 220 }} />
        <Select aria-label={t("ws.music.origin")} value={origin} onChange={(v: MusicOrigin) => setOrigin(v)} style={{ width: 180 }}
          options={MUSIC_ORIGINS.map((o) => ({ value: o, label: t(`ws.music.origins.${o}`) }))} />
        <Input aria-label={t("ws.music.originNote")} placeholder={t("ws.music.originNoteHint")} value={originNote} maxLength={500}
          onChange={(e) => setOriginNote(e.target.value)} />
        <Checkbox checked={loopOk} onChange={(e) => setLoopOk(e.target.checked)}>{t("ws.music.loopOk")}</Checkbox>
        <Button type="primary" htmlType="submit" disabled={!ready} loading={add.isPending}>{t("ws.music.upload")}</Button>
      </form>
    </section>
  );
}
