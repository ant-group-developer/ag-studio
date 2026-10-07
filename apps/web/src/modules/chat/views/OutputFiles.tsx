import { useQuery } from "@tanstack/react-query";
import { Image } from "antd";
import { Copy, Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { StoredTimeline } from "@harness/contracts";
import type { EpisodeDetail } from "../../../api/studio-client";
import { TimelineResult } from "./TimelineResult";

type ExportFile = EpisodeDetail["exportFiles"][number];

/** As the kit writes chapters into the description: rounded to the second. */
const mmss = (s: number) => { const r = Math.round(s); return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`; };

/** The file's own small "Tải về" (Content-Disposition: attachment), next to what shows it. */
function DownloadLink({ file }: { file: ExportFile }) {
  const { t } = useTranslation();
  return (
    <a className="chat-files__download" href={file.downloadUrl} aria-label={`${t("chat.files.download")} ${file.name}`}>
      <Download size={13} /> {t("chat.files.download")}
    </a>
  );
}

function FileHead({ file, title }: { file: ExportFile; title?: string }) {
  return (
    <div className="chat-files__head">
      <span className="chat-files__name">{title ?? file.name}</span>
      <DownloadLink file={file} />
    </div>
  );
}

/** A JSON file of the export, read from its signed URL (the bucket answers CORS). */
function useJsonFile<T>(file: ExportFile) {
  return useQuery({
    queryKey: ["export-file", file.url],
    queryFn: async () => {
      const res = await fetch(file.url);
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as T;
    },
    retry: false, staleTime: Infinity,
  });
}

function Unreadable() {
  const { t } = useTranslation();
  return <p className="chat-doc__note">{t("chat.files.unreadable")}</p>;
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="chat-link-button chat-files__copy" onClick={() => void navigator.clipboard?.writeText(text).catch(() => {})}>
      <Copy size={12} /> {t("chat.files.copy")}
    </button>
  );
}

interface YoutubeFile {
  title: string; alt_titles?: string[]; description: string; chapters?: { start_s: number; title: string }[];
  tags?: string[]; hashtags?: string[]; playlist?: string | null;
}

/** youtube.json: what goes on YouTube, readable and copyable. */
function YoutubePack({ file }: { file: ExportFile }) {
  const { t } = useTranslation();
  const { data, isError } = useJsonFile<YoutubeFile>(file);
  return (
    <section className="chat-files__item">
      <FileHead file={file} title={t("chat.files.youtube")} />
      {isError ? <Unreadable /> : !data ? null : (
        <div className="chat-files__youtube">
          <div className="chat-files__row"><strong>{data.title}</strong><CopyButton text={data.title} /></div>
          {data.alt_titles?.length ? (
            <ul className="chat-doc__list chat-files__alt">{data.alt_titles.map((x) => <li key={x}>{x}</li>)}</ul>
          ) : null}
          <div className="chat-files__row chat-files__label">{t("chat.files.description")}<CopyButton text={data.description} /></div>
          <p className="chat-files__description">{data.description}</p>
          {data.chapters?.length ? (
            <>
              <div className="chat-files__label">{t("chat.files.chapters")}</div>
              <ul className="chat-files__chapters">{data.chapters.map((c) => <li key={c.start_s}>{`${mmss(c.start_s)} ${c.title}`}</li>)}</ul>
            </>
          ) : null}
          {data.tags?.length ? (
            <>
              <div className="chat-files__row chat-files__label">{t("chat.files.tags")}<CopyButton text={data.tags.join(", ")} /></div>
              <div className="chat-files__chips">{data.tags.map((x) => <span key={x} className="chat-files__chip">{x}</span>)}</div>
            </>
          ) : null}
          {data.hashtags?.length ? (
            <div className="chat-files__chips">{data.hashtags.map((x) => <span key={x} className="chat-files__chip">{x}</span>)}</div>
          ) : null}
          {data.playlist ? <p className="chat-doc__note">{t("chat.files.playlist", { name: data.playlist })}</p> : null}
        </div>
      )}
    </section>
  );
}

/** timeline.json: the timeline the render used, folded (it is long). */
function RenderedTimeline({ file, productionId, episodeId }: { file: ExportFile; productionId: string; episodeId: string }) {
  const { t } = useTranslation();
  const { data, isError } = useJsonFile<StoredTimeline>(file);
  return (
    <section className="chat-files__item">
      <details className="chat-files__fold">
        <summary>
          <span className="chat-files__name">{data ? t("chat.files.timelineCount", { n: data.clips.length }) : t("chat.files.timeline")}</span>
          <DownloadLink file={file} />
        </summary>
        {isError ? <Unreadable /> : data ? <TimelineResult productionId={productionId} episodeId={episodeId} timeline={data} withPreview={false} /> : null}
      </details>
    </section>
  );
}

/** The files of an episode's export, each shown where a browser can: pictures, the YouTube pack, the timeline. */
export function OutputFiles({ files, productionId, episodeId }: { files: ExportFile[]; productionId: string; episodeId: string }) {
  const { t } = useTranslation();
  const thumbs = files.filter((f) => f.kind === "thumbnail");
  return (
    <div className="chat-files">
      {files.filter((f) => f.kind === "mp4").map((f) => <FileHead key={f.url} file={f} />)}
      {thumbs.length ? (
        <section className="chat-files__item">
          <div className="chat-files__label">{t("chat.files.thumbnails")}</div>
          <Image.PreviewGroup>
            <div className="chat-files__thumbs">
              {thumbs.map((f) => (
                <figure key={f.url} className="chat-files__thumb">
                  <Image src={f.url} alt={f.name} />
                  <figcaption><DownloadLink file={f} /></figcaption>
                </figure>
              ))}
            </div>
          </Image.PreviewGroup>
        </section>
      ) : null}
      {files.filter((f) => f.kind === "youtube").map((f) => <YoutubePack key={f.url} file={f} />)}
      {files.filter((f) => f.kind === "timeline").map((f) => <RenderedTimeline key={f.url} file={f} productionId={productionId} episodeId={episodeId} />)}
      {files.filter((f) => f.kind === "pack").map((f) => <FileHead key={f.url} file={f} />)}
    </div>
  );
}
