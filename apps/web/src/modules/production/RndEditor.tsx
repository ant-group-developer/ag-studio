/**
 * RndEditor — edit and approve/save a StudioRnd document.
 *
 * Modes:
 *  - Gate mode (onSubmit = submitApproveRnd): primaryLabel = "Duyệt R&D"
 *  - Edit mode (onSubmit = putProductionRnd): primaryLabel = "Lưu R&D"
 */
import { useCallback } from "react";
import {
  Alert,
  Button,
  Card,
  Collapse,
  Form,
  Input,
  InputNumber,
  Space,
  Spin,
  Typography,
} from "antd";
import { useTranslation } from "react-i18next";
import { StudioRndSchema } from "@harness/contracts";
import type { StudioRnd } from "@harness/contracts";
import { DurationInput } from "./DurationInput";
import { StringListField } from "./StringListField";

const { Text } = Typography;

export interface RndEditorProps {
  value: StudioRnd;
  readOnly?: boolean;
  primaryLabel: string;
  onSubmit: (doc: StudioRnd) => Promise<unknown>;
  submitting?: boolean;
  problems?: string[];
  warnings?: string[];
}

export function RndEditor({
  value,
  readOnly,
  primaryLabel,
  onSubmit,
  submitting,
  problems = [],
  warnings = [],
}: RndEditorProps) {
  const { t } = useTranslation();
  const [form] = Form.useForm<StudioRnd>();

  // Initialise form from value prop
  // (parent re-mounts with key={runId} so we don't need an effect here)
  const initialValues = value;

  const handleSubmit = useCallback(async () => {
    try {
      const values = await form.validateFields();
      // Validate with Zod schema
      const result = StudioRndSchema.safeParse(values);
      if (!result.success) {
        // Schema errors go through the same problems list mechanism
        const schemaErrors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
        // Throw a synthetic error object that gateProblems can extract
        throw Object.assign(new Error(t("rndEditor.schemaErrors")), {
          body: { problems: schemaErrors.map((m) => ({ code: "schema", message: m })) },
        });
      }
      await onSubmit(result.data);
    } catch (e) {
      // Re-throw so parent's useMutation onError fires
      throw e;
    }
  }, [form, onSubmit, t]);

  return (
    <Form form={form} layout="vertical" initialValues={initialValues} disabled={readOnly}>
      {problems.length > 0 && (
        <Alert
          type="error"
          message={t("rndEditor.problemsTitle")}
          description={<ul style={{ margin: 0, paddingLeft: 20 }}>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
          showIcon
          style={{ marginBottom: 12 }}
        />
      )}
      {warnings.length > 0 && (
        <Alert
          type="warning"
          message={t("rndEditor.warningsTitle")}
          description={<ul style={{ margin: 0, paddingLeft: 20 }}>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
          showIcon
          style={{ marginBottom: 12 }}
        />
      )}

      {/* Summary */}
      <Form.Item name="summary" label={t("rndEditor.summary")} rules={[{ required: true }]}>
        <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} maxLength={3000} showCount />
      </Form.Item>

      {/* Market section */}
      <Collapse
        size="small"
        style={{ marginBottom: 12 }}
        defaultActiveKey={["market"]}
        items={[{
          key: "market",
          label: t("rndEditor.market"),
          children: (
            <Space direction="vertical" style={{ width: "100%" }} size={12}>
              <StringListField
                name={["market", "opportunities"]}
                label={t("rndEditor.opportunities")}
                maxItems={10}
                maxChars={500}
                readOnly={readOnly}
                placeholder={t("rndEditor.opportunities")}
                addLabel={t("rndEditor.opportunities")}
              />
              <StringListField
                name={["market", "gaps"]}
                label={t("rndEditor.gaps")}
                maxItems={10}
                maxChars={500}
                readOnly={readOnly}
                placeholder={t("rndEditor.gaps")}
                addLabel={t("rndEditor.gaps")}
              />
              <StringListField
                name={["market", "risks"]}
                label={t("rndEditor.risks")}
                maxItems={10}
                maxChars={500}
                readOnly={readOnly}
                placeholder={t("rndEditor.risks")}
                addLabel={t("rndEditor.risks")}
              />
              {/* Competitors */}
              <div>
                <Text style={{ fontSize: 14 }}>{t("rndEditor.competitors")}</Text>
                <Form.List name={["market", "competitors"]}>
                  {(fields, { add, remove }) => (
                    <Space direction="vertical" style={{ width: "100%" }} size={8}>
                      {fields.map((field) => (
                        <Card size="small" key={field.key} extra={
                          !readOnly && (
                            <Button size="small" danger onClick={() => remove(field.name)} aria-label={t("rndEditor.removeCompetitor")}>
                              {t("rndEditor.removeCompetitor")}
                            </Button>
                          )
                        }>
                          <Form.Item name={[field.name, "channel"]} label={t("rndEditor.competitorChannel")} rules={[{ required: true }]}>
                            <Input maxLength={200} />
                          </Form.Item>
                          <Form.Item name={[field.name, "strengths"]} label={t("rndEditor.competitorStrengths")}>
                            <Input.TextArea autoSize={{ minRows: 1, maxRows: 3 }} maxLength={500} />
                          </Form.Item>
                          <Form.Item name={[field.name, "weaknesses"]} label={t("rndEditor.competitorWeaknesses")}>
                            <Input.TextArea autoSize={{ minRows: 1, maxRows: 3 }} maxLength={500} />
                          </Form.Item>
                        </Card>
                      ))}
                      {!readOnly && fields.length < 10 && (
                        <Button size="small" onClick={() => add({ channel: "", strengths: "", weaknesses: "" })}>
                          {t("rndEditor.addCompetitor")}
                        </Button>
                      )}
                    </Space>
                  )}
                </Form.List>
              </div>
            </Space>
          ),
        }]}
      />

      {/* Own channels (shown only when not null) */}
      {value.own_channels !== null && (
        <Collapse
          size="small"
          style={{ marginBottom: 12 }}
          items={[{
            key: "own_channels",
            label: t("rndEditor.ownChannels"),
            children: (
              <Space direction="vertical" style={{ width: "100%" }} size={12}>
                <Form.Item name={["own_channels", "assessment"]} label={t("rndEditor.ownChannelsAssessment")} rules={[{ required: true }]}>
                  <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} maxLength={2000} />
                </Form.Item>
                <StringListField name={["own_channels", "strengths"]} label={t("rndEditor.ownStrengths")} maxItems={8} maxChars={300} readOnly={readOnly} />
                <StringListField name={["own_channels", "weaknesses"]} label={t("rndEditor.ownWeaknesses")} maxItems={8} maxChars={300} readOnly={readOnly} />
                <StringListField name={["own_channels", "recommendations"]} label={t("rndEditor.ownRecommendations")} maxItems={8} maxChars={500} readOnly={readOnly} />
              </Space>
            ),
          }]}
        />
      )}

      {/* Footage fit */}
      <Collapse
        size="small"
        style={{ marginBottom: 12 }}
        items={[{
          key: "footage_fit",
          label: t("rndEditor.footageFit"),
          children: (
            <Space direction="vertical" style={{ width: "100%" }} size={12}>
              <Form.Item name={["footage_fit", "summary"]} label={t("rndEditor.footageSummary")} rules={[{ required: true }]}>
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} maxLength={2000} />
              </Form.Item>
              <StringListField name={["footage_fit", "strong_themes"]} label={t("rndEditor.strongThemes")} maxItems={10} maxChars={200} readOnly={readOnly} />
              <StringListField name={["footage_fit", "gaps"]} label={t("rndEditor.footageGaps")} maxItems={10} maxChars={300} readOnly={readOnly} />
            </Space>
          ),
        }]}
      />

      {/* Direction */}
      <Collapse
        size="small"
        style={{ marginBottom: 12 }}
        defaultActiveKey={["direction"]}
        items={[{
          key: "direction",
          label: t("rndEditor.direction"),
          children: (
            <Space direction="vertical" style={{ width: "100%" }} size={12}>
              <Form.Item name={["direction", "description"]} label={t("rndEditor.description")} rules={[{ required: true }]}>
                <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} maxLength={4000} showCount />
              </Form.Item>
              <Form.Item name={["direction", "goal"]} label={t("rndEditor.goal")} rules={[{ required: true }]}>
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={1000} />
              </Form.Item>
              <Form.Item name={["direction", "audience"]} label={t("rndEditor.audience")} rules={[{ required: true }]}>
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={1000} />
              </Form.Item>
              <Form.Item name={["direction", "tone"]} label={t("rndEditor.tone")} rules={[{ required: true }]}>
                <Input maxLength={500} />
              </Form.Item>
              <Form.Item name={["direction", "positioning"]} label={t("rndEditor.positioning")} rules={[{ required: true }]}>
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={1000} />
              </Form.Item>

              {/* Content pillars */}
              <div>
                <Text style={{ fontSize: 14 }}>{t("rndEditor.contentPillars")}</Text>
                <Form.List name={["direction", "content_pillars"]}>
                  {(fields, { add, remove }) => (
                    <Space direction="vertical" style={{ width: "100%" }} size={8}>
                      {fields.map((field) => (
                        <Card size="small" key={field.key} extra={
                          !readOnly && (
                            <Button size="small" danger onClick={() => remove(field.name)} aria-label={t("rndEditor.removePillar")}>
                              {t("rndEditor.removePillar")}
                            </Button>
                          )
                        }>
                          <Form.Item name={[field.name, "name"]} label={t("rndEditor.pillarName")} rules={[{ required: true }]}>
                            <Input maxLength={100} />
                          </Form.Item>
                          <Form.Item name={[field.name, "description"]} label={t("rndEditor.pillarDescription")} rules={[{ required: true }]}>
                            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={500} />
                          </Form.Item>
                        </Card>
                      ))}
                      {!readOnly && fields.length < 8 && (
                        <Button size="small" onClick={() => add({ name: "", description: "" })}>
                          {t("rndEditor.addPillar")}
                        </Button>
                      )}
                    </Space>
                  )}
                </Form.List>
              </div>

              <Form.Item name={["direction", "episode_target_seconds"]} label={t("rndEditor.episodeTargetSeconds")}
                rules={[{ required: true }, {
                  validator: (_, v: number | undefined) =>
                    v === undefined || (v >= 10 && v <= 3600) ? Promise.resolve() : Promise.reject(new Error("10–3600s")),
                }]}>
                <DurationInput />
              </Form.Item>
              <Form.Item name={["direction", "max_episodes"]} label={t("rndEditor.maxEpisodes")}>
                <InputNumber min={1} max={30} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item name={["direction", "posting_schedule"]} label={t("rndEditor.postingSchedule")}>
                <Input maxLength={500} />
              </Form.Item>
              <Form.Item name={["direction", "keywords"]} label={t("rndEditor.keywords")}>
                <Input.TextArea
                  autoSize={{ minRows: 1, maxRows: 3 }}
                  placeholder="keyword1, keyword2"
                  readOnly={readOnly}
                />
              </Form.Item>

              {/* Episode ideas */}
              <div>
                <Text style={{ fontSize: 14 }}>{t("rndEditor.episodeIdeas")}</Text>
                <Form.List name={["direction", "episode_ideas"]}>
                  {(fields, { add, remove }) => (
                    <Space direction="vertical" style={{ width: "100%" }} size={8}>
                      {fields.map((field) => (
                        <Card size="small" key={field.key} extra={
                          !readOnly && (
                            <Button size="small" danger onClick={() => remove(field.name)} aria-label={t("rndEditor.removeIdea")}>
                              {t("rndEditor.removeIdea")}
                            </Button>
                          )
                        }>
                          <Form.Item name={[field.name, "title"]} label={t("rndEditor.ideaTitle")} rules={[{ required: true }]}>
                            <Input maxLength={150} />
                          </Form.Item>
                          <Form.Item name={[field.name, "angle"]} label={t("rndEditor.ideaAngle")} rules={[{ required: true }]}>
                            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={500} />
                          </Form.Item>
                        </Card>
                      ))}
                      {!readOnly && fields.length < 15 && (
                        <Button size="small" onClick={() => add({ title: "", angle: "" })}>
                          {t("rndEditor.addIdea")}
                        </Button>
                      )}
                    </Space>
                  )}
                </Form.List>
              </div>

              <Form.Item name={["direction", "notes"]} label={t("rndEditor.notes")}>
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} maxLength={4000} />
              </Form.Item>
            </Space>
          ),
        }]}
      />

      {!readOnly && (
        <Button
          type="primary"
          loading={submitting}
          onClick={() => void handleSubmit()}
        >
          {primaryLabel}
        </Button>
      )}
    </Form>
  );
}

// Spinner shown while the rnd stage is still running and no document exists yet
export function RndWritingSpinner() {
  const { t } = useTranslation();
  return (
    <div style={{ textAlign: "center", padding: 32 }}>
      <Spin />
      <div style={{ marginTop: 8, color: "var(--ant-color-text-secondary)" }}>
        {t("rndEditor.writing")}
      </div>
    </div>
  );
}
