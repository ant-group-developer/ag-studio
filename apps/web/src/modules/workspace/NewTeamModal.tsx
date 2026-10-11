import { App as AntApp, Form, Input, Modal } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { StudioHttpError } from "../../api/http";
import { useStudioClient } from "../../api/studio-client";
import { rememberTeam } from "../../helpers/last-team";

/** A new team (the people who work together; its projects are channels): the creator is its owner. Opens its projects. */
export function NewTeamModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useStudioClient();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form] = Form.useForm<{ name: string }>();

  const create = useMutation({
    mutationFn: (name: string) => client.createTeam(name),
    onSuccess: (team) => {
      void qc.invalidateQueries({ queryKey: ["teams"] });
      rememberTeam(team.id);
      onClose();
      form.resetFields();
      navigate(`/t/${team.id}`);
    },
    onError: (e) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.teams.createFailed")),
  });

  const submit = async () => {
    const v = await form.validateFields();
    create.mutate(v.name.trim());
  };

  return (
    <Modal
      open={open} title={t("ws.teams.newTitle")} okText={t("ws.teams.create")} cancelText={t("common.cancel")}
      onOk={() => void submit()} onCancel={onClose} confirmLoading={create.isPending} destroyOnHidden
    >
      <p style={{ marginTop: 0, color: "var(--ws-muted, #4a505a)" }}>{t("ws.teams.newLead")}</p>
      <Form form={form} layout="vertical" requiredMark={false} onFinish={() => void submit()}>
        <Form.Item name="name" label={t("ws.teams.name")} rules={[{ required: true, whitespace: true, message: t("ws.teams.nameRequired") }]}>
          <Input maxLength={120} placeholder={t("ws.teams.namePlaceholder")} autoFocus />
        </Form.Item>
      </Form>
    </Modal>
  );
}
