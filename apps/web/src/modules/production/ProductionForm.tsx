/**
 * Reusable ProductionForm — used in ProductionDetailPage (step 0 edit) and ProductionsPage (create drawer).
 */
import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Collapse,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  TreeSelect,
  Typography,
} from "antd";
import type { FormInstance } from "antd";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useAgGoClient } from "../../api/ag-go-client";
import { buildFolderTree } from "../../helpers/folder-tree";
import { DurationInput } from "./DurationInput";

// ---------------------------------------------------------------------------
// Helpers (exported so pages can convert on save)
// ---------------------------------------------------------------------------

/** Target length of an episode the API accepts (`episodeTargetSeconds`, docs/studio-api-v3.md). */
export const TARGET_SECONDS_MIN = 10;
export const TARGET_SECONDS_MAX = 3600;

// ---------------------------------------------------------------------------
// YouTube channel validation
// ---------------------------------------------------------------------------

function isValidYTChannel(value: string): boolean {
  if (!value) return false;
  if (value.includes("youtube.com") || value.includes("youtu.be")) return true;
  if (value.startsWith("@")) return true;
  if (/^UC[A-Za-z0-9_-]{22}$/.test(value)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Folder tree data conversion for antd TreeSelect
// ---------------------------------------------------------------------------

interface TreeSelectNode {
  value: string;
  title: string;
  children: TreeSelectNode[];
}

function toTreeSelectNodes(nodes: ReturnType<typeof buildFolderTree>): TreeSelectNode[] {
  return nodes.map((n) => ({
    value: n.key,
    title: `${n.title} (${n.usableVideos})`,
    children: toTreeSelectNodes(n.children),
  }));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProductionFormValues {
  /** For create mode: team to create under */
  teamId?: string;
  title: string;
  description?: string;
  goal?: string;
  audience?: string;
  tone?: string;
  notes?: string;
  /** Target length of each episode in seconds (typed as hours / minutes / seconds). */
  targetSeconds?: number;
  maxEpisodes?: number;
  aspect: "16:9" | "9:16";
  language: string;
  /** Folder ids from TreeSelect */
  sources?: string[];
  /** The team's own YouTube channels */
  ownChannels?: string[];
  youtubeChannels?: string[];
  keywords?: string[];
  musicTrack?: string;
  musicGainDb?: number;
  musicDucking?: boolean;
}

export interface ProductionFormProps {
  form: FormInstance<ProductionFormValues>;
  readOnly?: boolean;
  /** Show a team selector (create mode only) */
  showTeamSelect?: boolean;
  teams?: { id: string; name: string }[];
  loadingTeams?: boolean;
  onTeamChange?: (teamId: string) => void;
  /** Passed from parent only if quota display should reflect an external channel list (optional) */
  youtubeChannels?: string[];
  /** Passed from parent only if quota display should reflect an external keyword list (optional) */
  keywords?: string[];
  /** When true, show info alert that approved R&D is in use — hints are for a new research run */
  directionApproved?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const ASPECT_OPTIONS = [
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
];

const { Text } = Typography;

export function ProductionForm({
  form,
  readOnly,
  showTeamSelect,
  teams,
  loadingTeams,
  onTeamChange,
  directionApproved,
}: ProductionFormProps) {
  const { t } = useTranslation();
  void App.useApp;

  // ---- Folders ----
  const agGoClient = useAgGoClient();
  const { data: foldersData, isLoading: loadingFolders } = useQuery({
    queryKey: ["ag-go-folders"],
    queryFn: () => agGoClient.getFolders(),
  });
  const treeData = React.useMemo(
    () => (foldersData ? toTreeSelectNodes(buildFolderTree(foldersData.folders)) : []),
    [foldersData],
  );

  // ---- Quota estimate (own + reference channels × 3 + keywords × 201) ----
  const watchedOwnChannels: string[] = Form.useWatch("ownChannels", form) ?? [];
  const watchedRefChannels: string[] = Form.useWatch("youtubeChannels", form) ?? [];
  const watchedKeywords: string[] = Form.useWatch("keywords", form) ?? [];
  const quotaN = (watchedOwnChannels.length + watchedRefChannels.length) * 3 + watchedKeywords.length * 201;
  const quotaWarn = quotaN > 5000;

  // ---- Hints collapse (auto-open when any hint has a value) ----
  const watchedDescription: string | undefined = Form.useWatch("description", form);
  const watchedGoal: string | undefined = Form.useWatch("goal", form);
  const watchedAudience: string | undefined = Form.useWatch("audience", form);
  const watchedTone: string | undefined = Form.useWatch("tone", form);
  const watchedNotes: string | undefined = Form.useWatch("notes", form);
  const watchedTargetSeconds: number | undefined = Form.useWatch("targetSeconds", form);
  const watchedMaxEpisodes: number | undefined = Form.useWatch("maxEpisodes", form);

  const hintsHasValue =
    !!watchedDescription ||
    !!watchedGoal ||
    !!watchedAudience ||
    !!watchedTone ||
    !!watchedNotes ||
    watchedTargetSeconds !== undefined ||
    watchedMaxEpisodes !== undefined;

  const hintsManuallySet = useRef(false);
  const [hintsEnabled, setHintsEnabled] = useState(false);

  useEffect(() => {
    if (hintsHasValue && !hintsManuallySet.current) {
      setHintsEnabled(true);
    }
  }, [hintsHasValue]);

  function handleHintsCollapseChange(keys: string | string[]) {
    const active = Array.isArray(keys) ? keys.includes("hints") : keys === "hints";
    hintsManuallySet.current = true;
    setHintsEnabled(active);
  }

  // ---- Music collapse ----
  const watchedMusicTrack: string | undefined = Form.useWatch("musicTrack", form);
  const musicManuallySet = useRef(false);
  const [musicEnabled, setMusicEnabled] = useState(false);

  useEffect(() => {
    if (watchedMusicTrack && !musicManuallySet.current) {
      setMusicEnabled(true);
    }
  }, [watchedMusicTrack]);

  function handleMusicCollapseChange(keys: string | string[]) {
    const active = Array.isArray(keys) ? keys.includes("music") : keys === "music";
    musicManuallySet.current = true;
    setMusicEnabled(active);
    if (!active) {
      form.setFieldsValue({ musicTrack: undefined, musicGainDb: undefined, musicDucking: undefined });
    }
  }

  return (
    <Form form={form} layout="vertical">
      <fieldset disabled={readOnly} style={{ border: "none", padding: 0, margin: 0 }}>
        {/* ---- Team selector (create mode) ---- */}
        {showTeamSelect && (
          <Form.Item
            name="teamId"
            label={t("productions.teamLabel")}
            rules={[{ required: true, message: t("productions.fieldTitleRequired") }]}
          >
            <Select
              loading={loadingTeams}
              options={teams?.map((tm) => ({ value: tm.id, label: tm.name }))}
              placeholder={t("productions.teamPlaceholder")}
              onChange={onTeamChange}
            />
          </Form.Item>
        )}

        {/* ---- Core fields ---- */}
        <Form.Item
          name="title"
          label={t("productions.fieldTitle")}
          rules={[{ required: true, message: t("productions.fieldTitleRequired") }]}
        >
          <Input />
        </Form.Item>

        {/* ---- Source folders (required) ---- */}
        <Form.Item
          name="sources"
          label={
            <Space size={6}>
              {t("productions.fieldSourceFolders")}
              {loadingFolders && <Spin size="small" />}
            </Space>
          }
          rules={[{ required: true, message: "Vui lòng chọn ít nhất một thư mục nguồn" }]}
        >
          <TreeSelect
            treeData={treeData}
            treeCheckable
            showSearch
            multiple
            style={{ width: "100%" }}
            placeholder={t("productions.sourceFoldersPlaceholder")}
            allowClear
          />
        </Form.Item>

        {/* ---- Own channels (team's) ---- */}
        <Form.Item
          name="ownChannels"
          label={t("productions.fieldOwnChannels")}
          rules={[
            {
              validator: (_, value: string[] = []) => {
                const invalid = value.filter((v) => !isValidYTChannel(v));
                if (invalid.length > 0) {
                  return Promise.reject(new Error(t("productions.ownChannelInvalid")));
                }
                return Promise.resolve();
              },
            },
          ]}
        >
          <Select
            mode="tags"
            placeholder={t("productions.ownChannelsPlaceholder")}
            tokenSeparators={[","]}
            tagRender={(props) => {
              const invalid = !isValidYTChannel(String(props.value));
              return (
                <Tag
                  color={invalid ? "error" : undefined}
                  closable={props.closable}
                  onClose={props.onClose}
                  style={{ marginRight: 3 }}
                >
                  {props.label}
                </Tag>
              );
            }}
          />
        </Form.Item>

        {/* ---- Reference YouTube channels ---- */}
        <Form.Item
          name="youtubeChannels"
          label={t("productions.fieldYoutubeChannels")}
          rules={[
            {
              validator: (_, value: string[] = []) => {
                const invalid = value.filter((v) => !isValidYTChannel(v));
                if (invalid.length > 0) {
                  return Promise.reject(new Error(t("productions.youtubeChannelInvalid")));
                }
                return Promise.resolve();
              },
            },
          ]}
        >
          <Select
            mode="tags"
            placeholder={t("productions.youtubeChannelsPlaceholder")}
            tokenSeparators={[","]}
            tagRender={(props) => {
              const invalid = !isValidYTChannel(String(props.value));
              return (
                <Tag
                  color={invalid ? "error" : undefined}
                  closable={props.closable}
                  onClose={props.onClose}
                  style={{ marginRight: 3 }}
                >
                  {props.label}
                </Tag>
              );
            }}
          />
        </Form.Item>

        {/* ---- Keywords; also says when there is nothing to research (no channel and no keyword).
             That check used to sit on a hidden field, so its message never showed and Create looked dead. ---- */}
        <Form.Item
          name="keywords"
          label={t("productions.fieldKeywords")}
          dependencies={["ownChannels", "youtubeChannels"]}
          rules={[
            {
              validator: (_, value: string[] = []) => {
                if (value.length > 20) return Promise.reject(new Error("Tối đa 20 từ khóa"));
                if (value.some((k) => k.length > 100))
                  return Promise.reject(new Error("Từ khóa tối đa 100 ký tự"));
                const own = form.getFieldValue("ownChannels") as string[] | undefined;
                const ref = form.getFieldValue("youtubeChannels") as string[] | undefined;
                if ((own?.length ?? 0) + (ref?.length ?? 0) + value.length === 0) {
                  return Promise.reject(new Error(t("productions.atLeastOneResearchSource")));
                }
                return Promise.resolve();
              },
            },
          ]}
        >
          <Select
            mode="tags"
            placeholder={t("productions.keywordsPlaceholder")}
            tokenSeparators={[","]}
          />
        </Form.Item>

        {/* ---- Quota estimate ---- */}
        <div style={{ marginBottom: 16, fontSize: 12 }}>
          <Text type={quotaWarn ? "warning" : "secondary"}>
            {t("productions.quotaEstimate", { n: quotaN })}
            {quotaWarn && <span style={{ marginLeft: 8 }}>{t("productions.quotaWarning")}</span>}
          </Text>
          <div style={{ marginTop: 4 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>{watchedKeywords.length}/20 từ khóa</Text>
          </div>
        </div>

        {/* ---- Aspect and language ---- */}
        <Form.Item
          name="aspect"
          label={t("productions.fieldAspect")}
          rules={[{ required: true, message: t("productions.fieldAspectRequired") }]}
        >
          <Select options={ASPECT_OPTIONS} style={{ width: 120 }} />
        </Form.Item>

        <Form.Item name="language" label={t("productions.fieldLanguage")}>
          <Input style={{ width: 120 }} />
        </Form.Item>

        {/* ---- AI hints collapse (collapsed by default; auto-opens when any hint has a value) ---- */}
        <Collapse
          activeKey={hintsEnabled ? ["hints"] : []}
          onChange={handleHintsCollapseChange}
          style={{ marginBottom: 16 }}
          items={[
            {
              key: "hints",
              label: t("productions.hintsSectionLabel"),
              children: (
                <Space direction="vertical" style={{ width: "100%" }}>
                  {directionApproved && (
                    <Alert
                      type="info"
                      message={t("productions.hintsApprovedRdNote")}
                      showIcon
                      style={{ marginBottom: 8 }}
                    />
                  )}

                  <Form.Item name="description" label={t("productions.fieldBrief")} style={{ marginBottom: 0 }}>
                    <Input.TextArea rows={3} maxLength={4000} showCount />
                  </Form.Item>

                  <Form.Item name="goal" label={t("productions.fieldGoal")} style={{ marginBottom: 0 }}>
                    <Input.TextArea rows={2} maxLength={1000} />
                  </Form.Item>

                  <Form.Item name="audience" label={t("productions.fieldAudience")} style={{ marginBottom: 0 }}>
                    <Input maxLength={1000} />
                  </Form.Item>

                  <Form.Item name="tone" label={t("productions.fieldTone")} style={{ marginBottom: 0 }}>
                    <Input maxLength={500} />
                  </Form.Item>

                  <Form.Item name="notes" label={t("productions.fieldNotes")} style={{ marginBottom: 0 }}>
                    <Input.TextArea rows={2} maxLength={4000} />
                  </Form.Item>

                  <Form.Item
                    name="targetSeconds"
                    label={t("productions.fieldTargetSeconds")}
                    extra={t("productions.fieldTargetSecondsHelp")}
                    style={{ marginBottom: 0 }}
                    rules={[
                      {
                        validator: (_, value: number | undefined) =>
                          value === undefined || (value >= TARGET_SECONDS_MIN && value <= TARGET_SECONDS_MAX)
                            ? Promise.resolve()
                            : Promise.reject(new Error(t("productions.fieldTargetSecondsRange"))),
                      },
                    ]}
                  >
                    <DurationInput disabled={readOnly} />
                  </Form.Item>

                  <Form.Item
                    name="maxEpisodes"
                    label={t("productions.fieldMaxEpisodes")}
                    extra="Để trống = AI đề xuất trong R&D"
                    style={{ marginBottom: 0 }}
                  >
                    <InputNumber min={1} max={30} style={{ width: "100%" }} placeholder="AI đề xuất" />
                  </Form.Item>
                </Space>
              ),
            },
          ]}
        />

        {/* ---- Music (collapsible) ---- */}
        <Collapse
          activeKey={musicEnabled ? ["music"] : []}
          onChange={handleMusicCollapseChange}
          style={{ marginBottom: 24 }}
          items={[
            {
              key: "music",
              label: t("productions.fieldMusic"),
              children: (
                <Space direction="vertical" style={{ width: "100%" }}>
                  <Form.Item
                    name="musicTrack"
                    label={t("productions.fieldMusicTrack")}
                    style={{ marginBottom: 0 }}
                  >
                    <Input placeholder="library:path/to/track" />
                  </Form.Item>
                  <Form.Item
                    name="musicGainDb"
                    label={t("productions.fieldMusicGain")}
                    style={{ marginBottom: 0 }}
                  >
                    <InputNumber min={-40} max={0} style={{ width: "100%" }} addonAfter="dB" />
                  </Form.Item>
                  <Form.Item
                    name="musicDucking"
                    label={t("productions.fieldMusicDucking")}
                    valuePropName="checked"
                    style={{ marginBottom: 0 }}
                  >
                    <Switch />
                  </Form.Item>
                </Space>
              ),
            },
          ]}
        />
      </fieldset>
    </Form>
  );
}
