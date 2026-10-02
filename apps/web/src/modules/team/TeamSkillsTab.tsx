/**
 * "Quy chuẩn & skill" tab of a team: the markdown rules the team's AI steps follow. Everyone in the team reads them;
 * owners and producers add (blank, from a template, from .md files), edit, switch on/off, download and delete.
 */
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Dropdown, Popconfirm, Progress, Space, Switch, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Download, Eye, FilePlus2, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStudioClient, type TeamSkill } from "../../api/studio-client";
import { useEnumLabel } from "../../helpers/enum-label";
import { errorMessage, TeamSkillDrawer } from "./TeamSkillDrawer";
import { parseSkillMarkdown, SKILL_LIMITS, skillFileName, STARTER_TEMPLATES, toSkillMarkdown, type SkillFile } from "./skill-md";

interface Props {
  teamId: string;
  canEdit: boolean;
}

/** FileReader rather than `file.text()`: works in every browser and in jsdom. */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error ?? new Error(`cannot read ${file.name}`));
    r.readAsText(file);
  });
}

function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function TeamSkillsTab({ teamId, canEdit }: Props) {
  const { t } = useTranslation();
  const label = useEnumLabel();
  const client = useStudioClient();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const fileInput = useRef<HTMLInputElement>(null);
  // What the drawer shows survives its closing animation; `open` alone opens and closes it.
  const [drawer, setDrawerState] = useState<{ skill: TeamSkill | null; draft: SkillFile | null }>({ skill: null, draft: null });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const setDrawer = (d: { skill: TeamSkill | null; draft: SkillFile | null }) => { setDrawerState(d); setDrawerOpen(true); };

  const { data: skills = [], isLoading } = useQuery({
    queryKey: ["team-skills", teamId],
    queryFn: () => client.listTeamSkills(teamId),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["team-skills", teamId] });

  const toggle = useMutation({
    mutationFn: (s: TeamSkill) => client.updateTeamSkill(teamId, s.id, { enabled: !s.enabled }),
    onSuccess: refresh,
    onError: (e) => void message.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (s: TeamSkill) => client.deleteTeamSkill(teamId, s.id),
    onSuccess: refresh,
    onError: (e) => void message.error(errorMessage(e)),
  });

  /** Each file becomes one skill; a file the API refuses (name taken, too long) is reported and skipped. */
  async function importFiles(files: FileList | null): Promise<void> {
    if (!files?.length) return;
    let done = 0;
    for (const file of Array.from(files)) {
      try {
        const parsed = parseSkillMarkdown(await readText(file), file.name);
        await client.createTeamSkill(teamId, { ...parsed, position: skills.length + done });
        done++;
      } catch (e) {
        void message.error(t("teamSkills.importFailed", { name: file.name, error: errorMessage(e) }));
      }
    }
    if (done) void message.success(t("teamSkills.importDone", { count: done }));
    refresh();
  }

  const used = skills.filter((s) => s.enabled).reduce((n, s) => n + s.content.length, 0);

  const columns: ColumnsType<TeamSkill> = [
    {
      title: t("teamSkills.columnName"), dataIndex: "name", key: "name", width: 220, ellipsis: { showTitle: false },
      render: (name: string, s) => <Tooltip title={name}><a onClick={() => setDrawer({ skill: s, draft: null })}>{name}</a></Tooltip>,
    },
    {
      title: t("teamSkills.columnPurpose"), dataIndex: "purpose", key: "purpose", width: 280, ellipsis: { showTitle: false },
      render: (purpose: string) => <Tooltip title={purpose}>{purpose}</Tooltip>,
    },
    {
      title: t("teamSkills.columnSteps"), dataIndex: "appliesTo", key: "appliesTo", width: 260,
      render: (steps: TeamSkill["appliesTo"]) => steps.length
        ? <Space size={[4, 4]} wrap>{steps.map((s) => <Tag key={s}>{label("teamSkillStep", s) ?? s}</Tag>)}</Space>
        : <Tag color="blue">{t("teamSkills.allSteps")}</Tag>,
    },
    {
      title: t("teamSkills.columnEnabled"), dataIndex: "enabled", key: "enabled", width: 80,
      render: (enabled: boolean, s) => (
        <Switch size="small" checked={enabled} disabled={!canEdit} loading={toggle.isPending && toggle.variables?.id === s.id}
          onChange={() => toggle.mutate(s)} aria-label={t("teamSkills.columnEnabled")} />
      ),
    },
    {
      title: t("teamSkills.columnUpdated"), dataIndex: "updatedAt", key: "updatedAt", width: 120,
      render: (at: string) => <Tooltip title={new Date(at).toLocaleString()}>{new Date(at).toLocaleDateString()}</Tooltip>,
    },
    {
      title: t("teamSkills.columnActions"), key: "actions", fixed: "right", width: 130,
      render: (_: unknown, s) => (
        <Space size={4}>
          <Tooltip title={canEdit ? t("teamSkills.edit") : t("teamSkills.view")}>
            <Button size="small" icon={canEdit ? <Pencil size={14} /> : <Eye size={14} />} aria-label={canEdit ? t("teamSkills.edit") : t("teamSkills.view")}
              onClick={() => setDrawer({ skill: s, draft: null })} />
          </Tooltip>
          <Tooltip title={t("teamSkills.download")}>
            <Button size="small" icon={<Download size={14} />} aria-label={t("teamSkills.download")}
              onClick={() => downloadText(skillFileName(s.name), toSkillMarkdown(s))} />
          </Tooltip>
          {canEdit && (
            <Popconfirm title={t("teamSkills.deleteConfirm")} okButtonProps={{ danger: true }} onConfirm={() => remove.mutate(s)}>
              <Tooltip title={t("teamSkills.delete")}>
                <Button size="small" danger icon={<Trash2 size={14} />} aria-label={t("teamSkills.delete")} />
              </Tooltip>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Typography.Paragraph type="secondary">{t("teamSkills.intro")}</Typography.Paragraph>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        {canEdit && (
          <>
            <Button type="primary" icon={<Plus size={16} />} onClick={() => setDrawer({ skill: null, draft: null })}>
              {t("teamSkills.add")}
            </Button>
            <Tooltip title={t("teamSkills.import")}>
              <Button icon={<Upload size={16} />} aria-label={t("teamSkills.import")} onClick={() => fileInput.current?.click()} />
            </Tooltip>
            <input ref={fileInput} type="file" accept=".md,.markdown,text/markdown" multiple hidden data-testid="skill-file-input"
              onChange={(e) => { void importFiles(e.target.files); e.target.value = ""; }} />
            <Dropdown
              trigger={["click"]}
              menu={{
                items: STARTER_TEMPLATES.map((tpl, i) => ({ key: String(i), label: tpl.name })),
                onClick: ({ key }) => setDrawer({ skill: null, draft: STARTER_TEMPLATES[Number(key)]! }),
              }}
            >
              <Tooltip title={t("teamSkills.fromTemplate")}>
                <Button icon={<FilePlus2 size={16} />} aria-label={t("teamSkills.fromTemplate")} />
              </Tooltip>
            </Dropdown>
          </>
        )}
        <div style={{ marginLeft: "auto", minWidth: 220 }}>
          <Typography.Text type="secondary">{t("teamSkills.usage", { used, limit: SKILL_LIMITS.enabledTotal })}</Typography.Text>
          <Progress percent={Math.min(100, Math.round((used / SKILL_LIMITS.enabledTotal) * 100))} size="small" showInfo={false}
            status={used > SKILL_LIMITS.enabledTotal * 0.9 ? "exception" : "normal"} />
        </div>
      </div>
      {!canEdit && <Alert type="info" showIcon message={t("teamSkills.readOnly")} style={{ marginBottom: 12 }} />}
      <Table
        columns={columns}
        dataSource={skills}
        rowKey="id"
        loading={isLoading}
        scroll={{ x: "max-content" }}
        pagination={false}
        locale={{ emptyText: t("teamSkills.empty") }}
      />
      <TeamSkillDrawer
        teamId={teamId}
        open={drawerOpen}
        skill={drawer.skill}
        draft={drawer.draft}
        canEdit={canEdit}
        onClose={() => setDrawerOpen(false)}
      />
    </div>
  );
}
