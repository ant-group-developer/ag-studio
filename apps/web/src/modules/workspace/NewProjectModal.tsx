import { App as AntApp, Form, Input, Modal, Segmented } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient, type CreateProjectInput, type ProjectAspect } from "../../api/workspace-client";

const CHANNEL = /^(@[\w.-]{3,100}|https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\/.+)$/i;

/** A new project: a name, the YouTube channel it makes videos for, a few words about it. Opens the project. */
export function NewProjectModal({ teamId, open, onClose }: { teamId: string; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form] = Form.useForm<{ name: string; channelUrl?: string; description?: string; aspect: ProjectAspect }>();

  const create = useMutation({
    mutationFn: (input: CreateProjectInput) => client.createProject(teamId, input),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ["projects", teamId] });
      onClose();
      form.resetFields();
      navigate(`/p/${p.id}`);
    },
    onError: (e) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.projects.createFailed")),
  });

  const submit = async () => {
    const v = await form.validateFields();
    create.mutate({
      name: v.name.trim(),
      ...(v.channelUrl?.trim() ? { channelUrl: v.channelUrl.trim() } : {}),
      ...(v.description?.trim() ? { description: v.description.trim() } : {}),
      aspect: v.aspect,
    });
  };

  return (
    <Modal
      open={open} title={t("ws.projects.newTitle")} okText={t("ws.projects.create")} cancelText={t("common.cancel")}
      onOk={() => void submit()} onCancel={onClose} confirmLoading={create.isPending} destroyOnHidden
    >
      <p style={{ marginTop: 0, color: "var(--ws-muted, #4a505a)" }}>{t("ws.projects.newLead")}</p>
      <Form form={form} layout="vertical" initialValues={{ aspect: "16:9" }} requiredMark={false}>
        <Form.Item name="name" label={t("ws.projects.name")} rules={[{ required: true, whitespace: true, message: t("ws.projects.nameRequired") }]}>
          <Input maxLength={120} placeholder={t("ws.projects.namePlaceholder")} autoFocus />
        </Form.Item>
        <Form.Item name="channelUrl" label={t("ws.projects.channel")} rules={[{ pattern: CHANNEL, message: t("ws.projects.channelInvalid") }]}>
          <Input maxLength={300} placeholder="https://www.youtube.com/@kenh-cua-ban" />
        </Form.Item>
        <Form.Item name="description" label={t("ws.projects.description")} extra={t("ws.projects.descriptionHint")}>
          <Input.TextArea maxLength={4000} autoSize={{ minRows: 3, maxRows: 8 }} placeholder={t("ws.projects.descriptionPlaceholder")} />
        </Form.Item>
        <Form.Item name="aspect" label={t("ws.projects.aspect")}>
          <Segmented options={[{ value: "16:9", label: t("ws.projects.landscape") }, { value: "9:16", label: t("ws.projects.portrait") }]} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
