import { useEffect, useMemo, useState } from "react";
import { App as AntApp, Button, Checkbox, Empty, Input, Modal, Select, Spin, Tag } from "antd";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mic, MicOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAgGoClient, type AgGoProject } from "../../api/ag-go-client";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient, type FootageItem, type SourceItem } from "../../api/workspace-client";
import { clock } from "../workspace/time";

/** `value` once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

const errorText = (e: unknown, fallback: string) => (e instanceof StudioHttpError ? e.message : fallback);

/**
 * Picks ag-go projects for the project (no more `@folder`): the person's own ag-go projects by name, as ag-go lists
 * them to them. Studio then checks the project's owner sees videos in it (the agent and renders act as the owner).
 */
export function AgGoProjectPicker({ projectId, picked, open, onClose }: { projectId: string; picked: SourceItem[]; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const agGo = useAgGoClient();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const [keyword, setKeyword] = useState("");
  const q = useDebounced(keyword.trim());
  useEffect(() => { if (open) setKeyword(""); }, [open]);
  const list = useQuery({ queryKey: ["agGoProjects", q], queryFn: () => agGo.getProjects({ keyword: q || undefined, pageSize: 30 }), enabled: open });
  const already = new Set(picked.filter((s) => s.kind === "ag_go_project").map((s) => s.ref));
  const add = useMutation({
    mutationFn: (p: AgGoProject) => client.addSource(projectId, { kind: "ag_go_project", ref: p.id, label: p.name }),
    onSuccess: (_r, p) => {
      void qc.invalidateQueries({ queryKey: ["sources", projectId] });
      void message.success(t("ws.inputs.projectAdded", { name: p.name }));
    },
    onError: (e) => void message.error(e instanceof StudioHttpError && e.code === "owner_cannot_access" ? t("ws.inputs.ownerCannotSeeProject") : errorText(e, t("ws.inputs.addFailed"))),
  });
  return (
    <Modal open={open} title={t("ws.inputs.pickProjectTitle")} onCancel={onClose} footer={<Button onClick={onClose}>{t("common.close")}</Button>} destroyOnHidden width={620}>
      <p className="ws-hint" style={{ marginTop: 0 }}>{t("ws.inputs.pickProjectLead")}</p>
      <Input.Search autoFocus allowClear value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder={t("ws.inputs.searchProjects")}
        aria-label={t("ws.inputs.searchProjects")} />
      <div className="ws-picker" aria-busy={list.isFetching}>
        {list.isLoading ? <div className="ws-center"><Spin /></div> : list.error ? <p className="ws-error">{t("ws.inputs.agGoUnavailable")}</p>
          : !list.data?.items.length ? <Empty description={t("ws.inputs.noProjects")} /> : (
            <ul className="ws-picker__list">
              {list.data.items.map((p) => (
                <li key={p.id} className="ws-picker__row">
                  <div className="ws-picker__text">
                    <strong>{p.name}</strong>
                    <span className="ws-hint">{[p.folderPath ?? p.folderName, t("ws.inputs.projectCounts", { videos: p.videoCount, images: p.imageCount })].filter(Boolean).join(" · ")}</span>
                  </div>
                  {already.has(p.id) ? <Tag>{t("ws.inputs.added")}</Tag> : (
                    <Button size="small" onClick={() => add.mutate(p)} loading={add.isPending && add.variables?.id === p.id} disabled={!p.videoCount}>{t("ws.inputs.add")}</Button>
                  )}
                </li>
              ))}
            </ul>
          )}
      </div>
    </Modal>
  );
}

function FootageRow({ item, checked, onToggle, disabled }: { item: FootageItem; checked: boolean; onToggle: () => void; disabled: boolean }) {
  const { t } = useTranslation();
  const prepared = item.prepared.state;
  return (
    <li className="ws-picker__row">
      <Checkbox checked={checked} disabled={disabled} onChange={onToggle} aria-label={item.name} />
      {item.thumbnailUrl ? <img className="ws-picker__thumb" src={item.thumbnailUrl} alt="" loading="lazy" /> : <span className="ws-picker__thumb" aria-hidden />}
      <div className="ws-picker__text">
        <strong>{item.name}</strong>
        <span className="ws-hint">
          {clock(item.durationMs / 1000)}{item.width && item.height ? ` · ${item.width}×${item.height}` : ""}{" "}
          {item.hasSpeech === true ? <Mic size={12} aria-label={t("ws.inputs.hasSpeech")} /> : item.hasSpeech === false ? <MicOff size={12} aria-label={t("ws.inputs.noSpeech")} /> : null}
        </span>
        {item.summaryVi ? <span className="ws-picker__summary">{item.summaryVi}</span> : null}
      </div>
      {prepared === "ready" ? <Tag color="green">{t("ws.inputs.state.ready")}</Tag> : prepared === "queued" || prepared === "preparing" ? <Tag color="blue">{t("ws.inputs.state.preparing")}</Tag> : null}
    </li>
  );
}

/**
 * Picks ag-go videos for one video, from the project's ag-go projects (as the person sees them): search, tick, and
 * "add and prepare" — each is added in the order ticked and prepared in the background.
 */
export function FootagePicker({ projectId, videoId, sources, open, onClose }: {
  projectId: string; videoId: string; sources: SourceItem[]; open: boolean; onClose: () => void;
}) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const projects = sources.filter((s) => s.kind === "ag_go_project");
  const inVideo = new Set(sources.filter((s) => s.kind === "ag_go_asset" && s.videoId === videoId).map((s) => s.ref));
  const [agGoProjectId, setAgGoProjectId] = useState<string | undefined>(undefined);
  const [text, setText] = useState("");
  const q = useDebounced(text.trim());
  const [ticked, setTicked] = useState<FootageItem[]>([]);
  useEffect(() => { if (open) { setTicked([]); setText(""); setAgGoProjectId(undefined); } }, [open]);
  const pages = useInfiniteQuery({
    queryKey: ["footage", projectId, agGoProjectId ?? "", q],
    queryFn: ({ pageParam }) => client.searchFootage(projectId, { agGoProjectId, q: q || undefined, cursor: pageParam || undefined, limit: 40 }),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: open && projects.length > 0,
  });
  const items = useMemo(() => pages.data?.pages.flatMap((p) => p.items) ?? [], [pages.data]);
  const toggle = (it: FootageItem) => setTicked((xs) => (xs.some((x) => x.assetId === it.assetId) ? xs.filter((x) => x.assetId !== it.assetId) : [...xs, it]));
  const add = useMutation({
    mutationFn: async () => {
      const failed: string[] = [];
      for (const it of ticked) {
        try {
          await client.addSource(projectId, {
            kind: "ag_go_asset", ref: it.assetId, label: it.name, videoId, prepare: true,
            meta: { durationMs: it.durationMs, ...(agGoProjectId ? { agGoProjectId } : {}) },
          });
        } catch (e) {
          failed.push(e instanceof StudioHttpError && e.code === "owner_cannot_access" ? t("ws.inputs.ownerCannotUse", { name: it.name }) : `${it.name}: ${errorText(e, t("ws.inputs.addFailed"))}`);
        }
      }
      return failed;
    },
    onSuccess: (failed) => {
      void qc.invalidateQueries({ queryKey: ["sources", projectId] });
      void qc.invalidateQueries({ queryKey: ["jobs", projectId] });
      void qc.invalidateQueries({ queryKey: ["activity", projectId] });
      void qc.invalidateQueries({ queryKey: ["playbook", projectId] });
      if (failed.length) void message.warning(failed.join("\n"));
      else void message.success(t("ws.inputs.videosAdded", { count: ticked.length }));
      onClose();
    },
  });
  return (
    <Modal open={open} title={t("ws.inputs.pickVideosTitle")} onCancel={onClose} destroyOnHidden width={720}
      okText={t("ws.inputs.addAndPrepare", { count: ticked.length })} okButtonProps={{ disabled: !ticked.length }} confirmLoading={add.isPending}
      onOk={() => add.mutate()} cancelText={t("common.cancel")}>
      {projects.length === 0 ? <p className="ws-hint">{t("ws.inputs.noAgGoProject")}</p> : (
        <>
          <div className="ws-picker__bar">
            <Select style={{ minWidth: 200 }} value={agGoProjectId ?? ""} onChange={(v) => setAgGoProjectId(v || undefined)} aria-label={t("ws.inputs.agGoProject")}
              options={[{ value: "", label: t("ws.inputs.allProjects") }, ...projects.map((p) => ({ value: p.ref, label: p.label }))]} />
            <Input.Search allowClear value={text} onChange={(e) => setText(e.target.value)} placeholder={t("ws.inputs.searchVideos")} aria-label={t("ws.inputs.searchVideos")} />
          </div>
          <div className="ws-picker" aria-busy={pages.isFetching}>
            {pages.isLoading ? <div className="ws-center"><Spin /></div> : pages.error ? <p className="ws-error">{errorText(pages.error, t("ws.inputs.agGoUnavailable"))}</p>
              : !items.length ? <Empty description={t("ws.inputs.noVideos")} /> : (
                <ul className="ws-picker__list">
                  {items.map((it) => (
                    <FootageRow key={it.assetId} item={it} checked={inVideo.has(it.assetId) || ticked.some((x) => x.assetId === it.assetId)}
                      disabled={inVideo.has(it.assetId)} onToggle={() => toggle(it)} />
                  ))}
                </ul>
              )}
            {pages.hasNextPage ? <Button block type="link" onClick={() => void pages.fetchNextPage()} loading={pages.isFetchingNextPage}>{t("ws.inputs.more")}</Button> : null}
          </div>
          {ticked.length ? <p className="ws-hint">{t("ws.inputs.tickedOrder", { names: ticked.map((x) => x.name).join(", ") })}</p> : null}
        </>
      )}
    </Modal>
  );
}
