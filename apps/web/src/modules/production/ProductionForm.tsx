/**
 * Reusable ProductionForm — used in ProductionDetailPage (step 0 edit) and ProductionsPage (create drawer).
 */
import React, { useEffect, useRef, useState } from "react";
import {
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
}: ProductionFormProps) {
  const { t } = useTranslation();
  // unused — suppress linter
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

  // ---- Quota estimate ----
  const watchedChannels: string[] = Form.useWatch("youtubeChannels", form) ?? [];
  const watchedKeywords: string[] = Form.useWatch("keywords", form) ?? [];
  const quotaN = watchedChannels.length * 3 + watchedKeywords.length * 201;
  const quotaWarn = quotaN > 5000;

  // ---- Music collapse ----
  // Auto-open if musicTrack has a value (e.g. loaded from existing production)
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

        <Form.Item name="description" label={t("productions.fieldBrief")}>
          <Input.TextArea rows={3} />
        </Form.Item>

        <Form.Item name="goal" label={t("productions.fieldGoal")}>
          <Input.TextArea rows={2} />
        </Form.Item>

        <Form.Item name="audience" label={t("productions.fieldAudience")}>
          <Input />
        </Form.Item>

        <Form.Item name="tone" label={t("productions.fieldTone")}>
          <Input />
        </Form.Item>

        <Form.Item name="notes" label={t("productions.fieldNotes")}>
          <Input.TextArea rows={2} />
        </Form.Item>

        {/* ---- Target length of an episode: hours / minutes / seconds ---- */}
        <Form.Item
          name="targetSeconds"
          label={t("productions.fieldTargetSeconds")}
          extra={t("productions.fieldTargetSecondsHelp")}
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

        <Form.Item name="maxEpisodes" label={t("productions.fieldMaxEpisodes")}>
          <InputNumber min={1} max={100} style={{ width: "100%" }} />
        </Form.Item>

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

        {/* ---- Source folders ---- */}
        <Form.Item
          name="sources"
          label={
            <Space size={6}>
              {t("productions.fieldSourceFolders")}
              {loadingFolders && <Spin size="small" />}
            </Space>
          }
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

        {/* ---- YouTube channels ---- */}
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
        <div style={{ marginTop: -20, marginBottom: 16, fontSize: 12 }}>
          <Text type={quotaWarn ? "warning" : "secondary"}>
            {t("productions.quotaEstimate", { n: quotaN })}
            {quotaWarn && <span style={{ marginLeft: 8 }}>{t("productions.quotaWarning")}</span>}
          </Text>
        </div>

        {/* ---- Keywords ---- */}
        <Form.Item
          name="keywords"
          label={t("productions.fieldKeywords")}
          rules={[
            {
              validator: (_, value: string[] = []) => {
                if (value.length > 20) return Promise.reject(new Error("Tối đa 20 từ khóa"));
                if (value.some((k) => k.length > 100))
                  return Promise.reject(new Error("Từ khóa tối đa 100 ký tự"));
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
        <div style={{ marginTop: -20, marginBottom: 16, fontSize: 12 }}>
          <Text type="secondary">{watchedKeywords.length}/20 từ khóa</Text>
        </div>

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
