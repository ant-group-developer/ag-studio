import { useState } from "react";
import { App as AntApp, Select } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { StudioHttpError, useStudioClient, type OverviewGroup, type OverviewItem } from "../api/studio-client";
import { rememberedTeam, rememberTeam } from "../helpers/last-team";
import { ChatComposer } from "../modules/chat/ChatComposer";
import { ChatShell } from "../modules/chat/ChatShell";
import { stepLabelKey, stepOf } from "../modules/chat/steps";

const SECTIONS: OverviewGroup[] = ["waiting_you", "needs_attention", "running", "done"];
const CAN_CREATE = new Set(["producer", "owner"]);

function WorkItem({ p }: { p: OverviewItem }) {
  const { t } = useTranslation();
  const step = stepOf(p.step) ?? stepOf(p.episodes.find((e) => e.group === p.group)?.step);
  return (
    <Link to={`/v/${p.id}`} className={`chat-work chat-work--${p.group}`}>
      <span className="chat-work__title">{p.title}</span>
      {step ? <span className="chat-work__step">{t(stepLabelKey(step))}</span> : null}
    </Link>
  );
}

/** Home of the chat UI (mockup screen 1): one message makes a video; on the right, what waits for you. */
export function ChatHomePage() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const client = useStudioClient();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const { data: teams } = useQuery({ queryKey: ["teams", "all"], queryFn: () => client.listTeams({ page: 1, pageSize: 100 }) });
  const creatable = (teams?.items ?? []).filter((x) => x.role && CAN_CREATE.has(x.role));
  const [picked, setPicked] = useState<string | null>(rememberedTeam());
  const teamId = creatable.find((x) => x.id === picked)?.id ?? creatable[0]?.id ?? null;
  const { data: overview } = useQuery({ queryKey: ["overview"], queryFn: () => client.getOverview(), refetchInterval: 5000 });

  const create = useMutation({
    mutationFn: (body: string) => client.createDraft(teamId!, body),
    onSuccess: (r) => {
      rememberTeam(teamId!);
      void qc.invalidateQueries({ queryKey: ["overview"] });
      navigate(`/v/${r.productionId}`);
    },
    onError: (e) => void message.error(e instanceof StudioHttpError ? e.message : t("chat.home.createFailed")),
  });

  const suggestions = [t("chat.home.suggestSeries"), t("chat.home.suggestReference")];
  return (
    <ChatShell>
      <main className="chat-main chat-home">
        <h1 className="chat-home__title">{t("chat.home.title")}</h1>
        <p className="chat-home__lead">{t("chat.home.lead")}</p>
        {creatable.length > 1 ? (
          <label className="chat-home__team">
            {t("chat.home.team")}
            <Select value={teamId} onChange={(v) => setPicked(v)} options={creatable.map((x) => ({ value: x.id, label: x.name }))} style={{ minWidth: 200 }} />
          </label>
        ) : null}
        {teams && !teamId ? <p className="chat-doc__note">{t("chat.home.noTeam")}</p> : null}
        <ChatComposer rows={3} menuBelow value={text} onValueChange={setText} disabled={!teamId || create.isPending}
          placeholder={t("chat.home.placeholder")} onSend={(body) => create.mutateAsync(body)} />
        <div className="chat-quick">
          {suggestions.map((s) => <button key={s} type="button" onClick={() => setText(`${s} @`)}>{s}</button>)}
        </div>
      </main>
      <aside className="chat-aside chat-work-list" aria-label={t("chat.home.yourWork")}>
        {SECTIONS.map((g) => {
          const items = (overview?.items ?? []).filter((p) => p.group === g).slice(0, g === "done" ? 5 : 20);
          if (!items.length) return null;
          return (
            <section key={g}>
              <h2>{t(`chat.home.sections.${g}`)}</h2>
              {items.map((p) => <WorkItem key={p.id} p={p} />)}
            </section>
          );
        })}
      </aside>
    </ChatShell>
  );
}
