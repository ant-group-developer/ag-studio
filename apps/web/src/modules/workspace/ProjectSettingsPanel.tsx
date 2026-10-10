import { useEffect } from "react";
import { App as AntApp, Button, Form, Input, InputNumber, Modal, Segmented, Select, Switch } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient, type Project, type ProjectAspect } from "../../api/workspace-client";

interface Values {
  name: string;
  channelUrl?: string;
  description?: string;
  language: string;
  aspect: ProjectAspect;
  model?: string;
  targetSeconds?: number | null;
  autoFix: boolean;
  autoContinue: boolean;
}

const MODELS = ["", "sonnet", "opus", "haiku"] as const;

/** The project's own settings: name, channel, the usual video, how the agent works. */
export function ProjectSettingsPanel({ project, canEdit, canArchive }: { project: Project; canEdit: boolean; canArchive: boolean }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form] = Form.useForm<Values>();

  useEffect(() => {
    form.setFieldsValue({
      name: project.name, channelUrl: project.channelUrl ?? "", description: project.description, language: project.language,
      aspect: project.aspect, model: project.settings.model ?? "", targetSeconds: project.settings.target_seconds ?? null,
      autoFix: project.settings.auto_fix, autoContinue: project.settings.auto_continue,
    });
  }, [project, form]);

  const save = useMutation({
    mutationFn: (v: Values) => client.updateProject(project.id, {
      name: v.name.trim(),
      channelUrl: v.channelUrl?.trim() ? v.channelUrl.trim() : null,
      description: v.description?.trim() ?? "",
      language: v.language,
      aspect: v.aspect,
      settings: {
        ...(v.model ? { model: v.model } : {}),
        ...(v.targetSeconds ? { target_seconds: v.targetSeconds } : {}),
        ...(project.settings.team_skills ? { team_skills: project.settings.team_skills } : {}),
        auto_fix: v.autoFix,
        auto_continue: v.autoContinue,
      },
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["project", project.id] });
      void qc.invalidateQueries({ queryKey: ["projects", project.teamId] });
      void message.success(t("ws.settings.saved"));
    },
    onError: (e) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.settings.saveFailed")),
  });
  const archive = useMutation({
    mutationFn: () => client.archiveProject(project.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects", project.teamId] });
      navigate(`/t/${project.teamId}`);
    },
  });

  return (
    <div className="ws-form">
      <Form form={form} layout="vertical" disabled={!canEdit} requiredMark={false} onFinish={(v) => save.mutate(v)}>
        <Form.Item name="name" label={t("ws.projects.name")} rules={[{ required: true, whitespace: true }]}><Input maxLength={120} /></Form.Item>
        <Form.Item name="channelUrl" label={t("ws.projects.channel")}><Input maxLength={300} placeholder="https://www.youtube.com/@kenh-cua-ban" /></Form.Item>
        <Form.Item name="description" label={t("ws.projects.description")}><Input.TextArea maxLength={4000} autoSize={{ minRows: 3, maxRows: 10 }} /></Form.Item>
        <Form.Item name="language" label={t("ws.settings.language")}>
          <Select options={[{ value: "vi", label: "Tiếng Việt" }, { value: "en", label: "English" }]} />
        </Form.Item>
        <Form.Item name="aspect" label={t("ws.projects.aspect")}>
          <Segmented options={[{ value: "16:9", label: t("ws.projects.landscape") }, { value: "9:16", label: t("ws.projects.portrait") }]} />
        </Form.Item>
        <Form.Item name="targetSeconds" label={t("ws.settings.targetSeconds")}><InputNumber min={10} max={14400} style={{ width: "100%" }} /></Form.Item>
        <Form.Item name="model" label={t("ws.settings.model")} extra={t("ws.settings.modelHint")}>
          <Select options={MODELS.map((m) => ({ value: m, label: m ? m : t("ws.settings.modelDefault") }))} />
        </Form.Item>
        <Form.Item name="autoFix" label={t("ws.settings.autoFix")} valuePropName="checked" extra={t("ws.settings.autoFixHint")}><Switch /></Form.Item>
        <Form.Item name="autoContinue" label={t("ws.settings.autoContinue")} valuePropName="checked" extra={t("ws.settings.autoContinueHint")}><Switch /></Form.Item>
        {canEdit ? <Button type="primary" htmlType="submit" loading={save.isPending}>{t("common.save")}</Button> : null}
      </Form>
      {canArchive ? (
        <div style={{ marginTop: 32, paddingTop: 16, borderTop: "1px solid var(--ws-line)" }}>
          <Button danger onClick={() => Modal.confirm({
            title: t("ws.settings.archiveTitle"), content: t("ws.settings.archiveBody"), okText: t("ws.settings.archive"),
            okButtonProps: { danger: true }, cancelText: t("common.cancel"), onOk: () => archive.mutateAsync(),
          })}>{t("ws.settings.archive")}</Button>
        </div>
      ) : null}
    </div>
  );
}
