import { useState } from "react";
import { Drawer } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { SeriesPlan, StudioBranding, StudioRnd } from "@harness/contracts";
import { useStudioClient, type ChatThreadView } from "../../api/studio-client";
import { BrandingEditor } from "../production/BrandingEditor";
import { gateProblems } from "../production/gate-problems";
import { PlanEditor } from "../production/PlanEditor";
import { RndEditor } from "../production/RndEditor";
import { docKindOf, type DocKind } from "./views/doc-specs";

/** Documents the older screens have an editor for; the others are changed through the chat. */
export const HAND_EDITABLE: ReadonlySet<DocKind> = new Set(["rnd", "branding", "series_plan"]);

/**
 * "⋯ → Sửa tay" (mockup screen 14): the editor of the older screens, in a drawer. Saving adds a version to the chat
 * (the one Duyệt then submits); nothing is approved here.
 */
export function ManualEditDrawer({ open, onClose, productionId, episodeId, thread, onSaved }: {
  open: boolean; onClose: () => void; productionId: string; episodeId?: string | undefined; thread: ChatThreadView; onSaved: () => void;
}) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const stageKey = thread.scope?.stageKey ?? "";
  const kind = docKindOf(stageKey);
  const doc = thread.current?.document;
  const { data: catalog } = useQuery({
    queryKey: ["catalog", productionId], queryFn: () => client.getProductionCatalog(productionId), enabled: open && kind === "series_plan",
  });
  const { data: production } = useQuery({ queryKey: ["production", productionId], queryFn: () => client.getProduction(productionId), enabled: open });

  const save = async (document: unknown) => {
    setSaving(true);
    try {
      await client.saveManualEdit(productionId, { stageKey, episodeId, document });
      setProblems([]);
      onSaved();
      onClose();
    } catch (e) {
      setProblems(gateProblems(e));
      throw e;
    } finally {
      setSaving(false);
    }
  };

  const label = t("chat.manual.save");
  let body = null;
  if (kind === "rnd") body = <RndEditor key={thread.current?.turnId ?? "draft"} value={doc as StudioRnd} primaryLabel={label} onSubmit={save} submitting={saving} problems={problems} />;
  if (kind === "branding") body = <BrandingEditor key={thread.current?.turnId ?? "draft"} value={doc as StudioBranding} primaryLabel={label} onSubmit={save} submitting={saving} problems={problems} />;
  if (kind === "series_plan") {
    body = (
      <PlanEditor key={thread.current?.turnId ?? "draft"} productionId={productionId} plan={doc as SeriesPlan} catalog={catalog ?? null}
        targetSeconds={production?.episodeTargetSeconds ?? 60} onSave={save} saveLabel={label} />
    );
  }
  return (
    <Drawer open={open} onClose={onClose} width="min(960px, 100vw)" title={t("chat.manual.title")} destroyOnClose>
      <p className="chat-doc__note">{t("chat.manual.lead")}</p>
      {body}
    </Drawer>
  );
}
