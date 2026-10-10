import { App as AntApp, Button } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lightbulb } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient } from "../../api/workspace-client";

/**
 * Lessons Studio drew from this thread once it went quiet (spec agent-workspace §4): each waits for a person to keep it
 * (it joins memory/lessons.md, which every chat of the project reads) or drop it.
 */
export function LessonCards({ projectId, threadId, canWrite }: { projectId: string; threadId: string; canWrite: boolean }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const key = ["lessons", projectId, threadId];
  const { data } = useQuery({ queryKey: key, queryFn: () => client.listLessons(projectId, { status: "proposed", threadId }) });
  const done = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["file", projectId, "memory/lessons.md"] });
  };
  const accept = useMutation({
    mutationFn: (id: string) => client.acceptLesson(projectId, id),
    onSuccess: () => { done(); void message.success(t("ws.lessons.saved")); },
    onError: (e) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.lessons.failed")),
  });
  const dismiss = useMutation({ mutationFn: (id: string) => client.dismissLesson(projectId, id), onSuccess: done });
  const lessons = data?.lessons ?? [];
  if (!lessons.length) return null;
  return (
    <div className="ws-lessons" role="region" aria-label={t("ws.lessons.title")}>
      <div className="ws-lessons__head"><Lightbulb size={14} aria-hidden />{t("ws.lessons.title")}</div>
      {lessons.map((l) => (
        <div key={l.id} className="ws-lesson">
          <span>{l.text}</span>
          {canWrite ? (
            <span className="ws-lesson__actions">
              <Button size="small" type="primary" onClick={() => accept.mutate(l.id)} loading={accept.isPending && accept.variables === l.id}>{t("ws.lessons.keep")}</Button>
              <Button size="small" onClick={() => dismiss.mutate(l.id)}>{t("ws.lessons.drop")}</Button>
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
