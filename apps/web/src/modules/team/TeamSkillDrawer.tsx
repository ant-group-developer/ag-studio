/**
 * Add, edit or read one team skill: name, purpose, the AI steps it applies to, on/off, and the markdown itself
 * (write / preview). People who may not edit see the same form read-only.
 */
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Checkbox, Drawer, Form, Input, Switch, Tabs, Typography } from "antd";
import { Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StudioHttpError, useStudioClient, type TeamSkill, type TeamSkillStep } from "../../api/studio-client";
import { useEnumLabel } from "../../helpers/enum-label";
import { MarkdownPreview } from "./MarkdownPreview";
import { SKILL_LIMITS, SKILL_STEPS, type SkillFile } from "./skill-md";

interface FormValues {
  name: string;
  purpose: string;
  appliesTo: TeamSkillStep[];
  enabled: boolean;
  content: string;
}

interface Props {
  teamId: string;
  open: boolean;
  /** The skill to edit; null with `draft` (template, import) or nothing = a new skill. */
  skill: TeamSkill | null;
  draft?: SkillFile | null;
  canEdit: boolean;
  onClose: () => void;
}

export function errorMessage(e: unknown): string {
  if (e instanceof StudioHttpError) {
    const body = e.body as { message?: unknown } | null;
    if (body && typeof body.message === "string") return body.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export function TeamSkillDrawer({ teamId, open, skill, draft, canEdit, onClose }: Props) {
  const { t } = useTranslation();
  const label = useEnumLabel();
  const client = useStudioClient();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [tab, setTab] = useState("write");
  const content = Form.useWatch("content", form) ?? "";

  useEffect(() => { if (open) setTab("write"); }, [open]);
  // The drawer's content is rebuilt on every open (destroyOnHidden), so the form starts from these each time.
  const initialValues: FormValues = {
    name: skill?.name ?? draft?.name ?? "",
    purpose: skill?.purpose ?? draft?.purpose ?? "",
    appliesTo: skill?.appliesTo ?? draft?.appliesTo ?? [],
    enabled: skill?.enabled ?? true,
    content: skill?.content ?? draft?.content ?? "",
  };

  const save = useMutation({
    mutationFn: (v: FormValues) => {
      const body = { name: v.name.trim(), purpose: v.purpose.trim(), appliesTo: v.appliesTo, enabled: v.enabled, content: v.content };
      return skill ? client.updateTeamSkill(teamId, skill.id, body) : client.createTeamSkill(teamId, body);
    },
    onSuccess: () => {
      void message.success(t("teamSkills.saved"));
      void queryClient.invalidateQueries({ queryKey: ["team-skills", teamId] });
      onClose();
    },
    onError: (e) => void message.error(errorMessage(e)),
  });

  const title = !canEdit ? t("teamSkills.drawerView") : skill ? t("teamSkills.drawerEdit") : t("teamSkills.drawerCreate");

  return (
    <Drawer
      title={title}
      open={open}
      onClose={onClose}
      width="min(760px, 100vw)"
      destroyOnHidden
      extra={canEdit ? (
        <Button type="primary" icon={<Save size={16} />} loading={save.isPending} onClick={() => form.submit()}>
          {t("teamSkills.save")}
        </Button>
      ) : null}
    >
      {!canEdit && <Alert type="info" showIcon message={t("teamSkills.readOnly")} style={{ marginBottom: 16 }} />}
      <Form form={form} layout="vertical" disabled={!canEdit} initialValues={initialValues} onFinish={(v) => save.mutate(v)}>
        <Form.Item name="name" label={t("teamSkills.nameLabel")} rules={[{ required: true, whitespace: true, message: t("teamSkills.nameRequired") }]}>
          <Input maxLength={SKILL_LIMITS.name} showCount />
        </Form.Item>
        <Form.Item name="purpose" label={t("teamSkills.purposeLabel")}>
          <Input.TextArea maxLength={SKILL_LIMITS.purpose} showCount autoSize={{ minRows: 1, maxRows: 3 }} placeholder={t("teamSkills.purposePlaceholder")} />
        </Form.Item>
        <Form.Item name="appliesTo" label={t("teamSkills.stepsLabel")} extra={t("teamSkills.stepsHelp")}>
          <Checkbox.Group options={SKILL_STEPS.map((s) => ({ value: s, label: label("teamSkillStep", s) ?? s }))} />
        </Form.Item>
        <Form.Item name="enabled" label={t("teamSkills.enabledLabel")} valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item label={t("teamSkills.contentLabel")} required style={{ marginBottom: 0 }}>
          <Tabs
            activeKey={tab}
            onChange={setTab}
            items={[
              {
                key: "write",
                label: t("teamSkills.write"),
                children: (
                  <Form.Item name="content" noStyle rules={[{ required: true, whitespace: true, message: t("teamSkills.contentRequired") }]}>
                    <Input.TextArea
                      aria-label={t("teamSkills.contentLabel")}
                      autoSize={{ minRows: 16, maxRows: 32 }}
                      maxLength={SKILL_LIMITS.content}
                      style={{ fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" }}
                    />
                  </Form.Item>
                ),
              },
              { key: "preview", label: t("teamSkills.preview"), children: <MarkdownPreview text={content} /> },
            ]}
          />
          <Typography.Text type="secondary">{t("teamSkills.chars", { count: content.length, limit: SKILL_LIMITS.content })}</Typography.Text>
        </Form.Item>
      </Form>
    </Drawer>
  );
}
