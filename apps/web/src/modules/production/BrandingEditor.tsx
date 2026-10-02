/**
 * BrandingEditor — edit and approve/save a StudioBranding document.
 */
import { useCallback, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  ColorPicker,
  Collapse,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Spin,
  Typography,
} from "antd";
import { useTranslation } from "react-i18next";
import { StudioBrandingSchema, THUMBNAIL_TEXT_POSITIONS } from "@harness/contracts";
import type { StudioBranding } from "@harness/contracts";
import { StringListField } from "./StringListField";

const { Text } = Typography;

// ---------------------------------------------------------------------------
// Small thumbnail preview
// ---------------------------------------------------------------------------
interface ThumbnailPreviewProps {
  seriesName: string;
  firstExample: string;
  textColor: string;
  outlineColor: string;
  position: StudioBranding["thumbnail"]["position"];
  textCase: "upper" | "sentence";
}

function ThumbnailPreview({ seriesName, firstExample, textColor, outlineColor, position, textCase }: ThumbnailPreviewProps) {
  const text = textCase === "upper" ? (firstExample || seriesName).toUpperCase() : (firstExample || seriesName);

  const positionStyle: React.CSSProperties = {
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    width: "90%",
    textAlign: "center",
    fontSize: 16,
    fontWeight: "bold",
    color: textColor,
    WebkitTextStroke: `1px ${outlineColor}`,
    textShadow: `0 0 3px ${outlineColor}`,
    wordBreak: "break-word",
  };

  if (position === "top") Object.assign(positionStyle, { top: 8 });
  else if (position === "bottom") Object.assign(positionStyle, { bottom: 8 });
  else if (position === "left") Object.assign(positionStyle, { top: "50%", left: 8, width: "45%", transform: "translateY(-50%)", textAlign: "left" });
  else if (position === "right") Object.assign(positionStyle, { top: "50%", left: "unset", right: 8, width: "45%", transform: "translateY(-50%)", textAlign: "right" });
  else Object.assign(positionStyle, { top: "50%", transform: "translate(-50%, -50%)" });

  return (
    <div style={{
      width: 320,
      height: 180,
      background: "linear-gradient(135deg, #1a1a2e, #16213e, #0f3460)",
      borderRadius: 8,
      position: "relative",
      overflow: "hidden",
      border: "1px solid #eee",
      marginBottom: 8,
    }}>
      <div style={positionStyle}>{text}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper to normalise ColorPicker value to #RRGGBB
// ---------------------------------------------------------------------------
function toHex(val: unknown): string {
  if (typeof val === "string" && /^#[0-9A-Fa-f]{6}$/.test(val)) return val.toUpperCase();
  if (val && typeof val === "object" && "toHexString" in val) {
    return ((val as { toHexString: () => string }).toHexString()).toUpperCase().slice(0, 7);
  }
  return "#FFFFFF";
}

// ---------------------------------------------------------------------------
// Main BrandingEditor
// ---------------------------------------------------------------------------
export interface BrandingEditorProps {
  value: StudioBranding;
  readOnly?: boolean;
  primaryLabel: string;
  onSubmit: (doc: StudioBranding) => Promise<unknown>;
  submitting?: boolean;
  problems?: string[];
  warnings?: string[];
}

export function BrandingEditor({
  value,
  readOnly,
  primaryLabel,
  onSubmit,
  submitting,
  problems = [],
  warnings = [],
}: BrandingEditorProps) {
  const { t } = useTranslation();
  const [form] = Form.useForm<StudioBranding>();

  // Preview state (driven by form watch — use state as workaround for antd Form.useWatch)
  const [previewState, setPreviewState] = useState({
    seriesName: value.series_name,
    firstExample: value.titles.examples[0] ?? "",
    textColor: value.thumbnail.palette.text,
    outlineColor: value.thumbnail.palette.outline,
    position: value.thumbnail.position,
    textCase: value.thumbnail.text_case,
  });

  const handleValuesChange = (changed: Partial<StudioBranding>) => {
    const updated = { ...previewState };
    if (changed.series_name !== undefined) updated.seriesName = changed.series_name;
    if (changed.thumbnail) {
      if (changed.thumbnail.palette?.text) updated.textColor = toHex(changed.thumbnail.palette.text);
      if (changed.thumbnail.palette?.outline) updated.outlineColor = toHex(changed.thumbnail.palette.outline);
      if (changed.thumbnail.position) updated.position = changed.thumbnail.position;
      if (changed.thumbnail.text_case) updated.textCase = changed.thumbnail.text_case;
    }
    setPreviewState(updated);
  };

  const handleSubmit = useCallback(async () => {
    const values = await form.validateFields();
    // Normalise palette hex colours
    if (values.thumbnail?.palette) {
      values.thumbnail.palette.text = toHex(values.thumbnail.palette.text);
      values.thumbnail.palette.outline = toHex(values.thumbnail.palette.outline);
      values.thumbnail.palette.accent = toHex(values.thumbnail.palette.accent);
    }
    // Validate with Zod
    const result = StudioBrandingSchema.safeParse(values);
    if (!result.success) {
      const schemaErrors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
      throw Object.assign(new Error(t("brandingEditor.schemaErrors")), {
        body: { problems: schemaErrors.map((m) => ({ code: "schema", message: m })) },
      });
    }
    await onSubmit(result.data);
  }, [form, onSubmit, t]);

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={value}
      disabled={readOnly}
      onValuesChange={handleValuesChange}
    >
      {problems.length > 0 && (
        <Alert
          type="error"
          message={t("brandingEditor.problemsTitle")}
          description={<ul style={{ margin: 0, paddingLeft: 20 }}>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
          showIcon
          style={{ marginBottom: 12 }}
        />
      )}
      {warnings.length > 0 && (
        <Alert
          type="warning"
          message={t("brandingEditor.warningsTitle")}
          description={<ul style={{ margin: 0, paddingLeft: 20 }}>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
          showIcon
          style={{ marginBottom: 12 }}
        />
      )}

      {/* Core identity */}
      <Form.Item name="series_name" label={t("brandingEditor.seriesName")} rules={[{ required: true }]}>
        <Input maxLength={100} />
      </Form.Item>
      <Form.Item name="tagline" label={t("brandingEditor.tagline")}>
        <Input maxLength={200} />
      </Form.Item>
      <Form.Item name="positioning" label={t("brandingEditor.positioning")} rules={[{ required: true }]}>
        <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={1000} />
      </Form.Item>

      {/* Voice */}
      <Collapse size="small" style={{ marginBottom: 12 }} items={[{
        key: "voice",
        label: t("brandingEditor.voice"),
        children: (
          <Space direction="vertical" style={{ width: "100%" }} size={12}>
            <StringListField name={["voice", "personality"]} label={t("brandingEditor.personality")} maxItems={6} maxChars={100} readOnly={readOnly} />
            <StringListField name={["voice", "do"]} label={t("brandingEditor.voiceDo")} maxItems={10} maxChars={300} readOnly={readOnly} />
            <StringListField name={["voice", "dont"]} label={t("brandingEditor.voiceDont")} maxItems={10} maxChars={300} readOnly={readOnly} />
            <StringListField name={["voice", "signature_phrases"]} label={t("brandingEditor.signaturePhrases")} maxItems={10} maxChars={200} readOnly={readOnly} />
            <StringListField name={["voice", "banned_words"]} label={t("brandingEditor.bannedWords")} maxItems={20} maxChars={100} readOnly={readOnly} />
          </Space>
        ),
      }]} />

      {/* Titles */}
      <Collapse size="small" style={{ marginBottom: 12 }} defaultActiveKey={["titles"]} items={[{
        key: "titles",
        label: t("brandingEditor.titles"),
        children: (
          <Space direction="vertical" style={{ width: "100%" }} size={12}>
            <StringListField name={["titles", "formulas"]} label={t("brandingEditor.titleFormulas")} maxItems={8} maxChars={200} readOnly={readOnly} addLabel="Thêm công thức" />
            <StringListField name={["titles", "rules"]} label={t("brandingEditor.titleRules")} maxItems={10} maxChars={300} readOnly={readOnly} />
            <StringListField name={["titles", "examples"]} label={t("brandingEditor.titleExamples")} maxItems={10} maxChars={100} readOnly={readOnly} />
            <Form.Item name={["titles", "max_chars"]} label={t("brandingEditor.titleMaxChars")}>
              <InputNumber min={20} max={100} style={{ width: 120 }} />
            </Form.Item>
          </Space>
        ),
      }]} />

      {/* Description */}
      <Collapse size="small" style={{ marginBottom: 12 }} items={[{
        key: "description",
        label: t("brandingEditor.description"),
        children: (
          <Space direction="vertical" style={{ width: "100%" }} size={12}>
            <Form.Item name={["description", "opening"]} label={t("brandingEditor.descriptionOpening")}>
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={500} />
            </Form.Item>
            <Form.Item name={["description", "cta"]} label={t("brandingEditor.descriptionCta")}>
              <Input.TextArea autoSize={{ minRows: 1, maxRows: 3 }} maxLength={300} />
            </Form.Item>
            <Form.Item
              name={["description", "hashtags"]}
              label={t("brandingEditor.descriptionHashtags")}
              rules={[{
                validator: (_, value: string[] = []) => {
                  const invalid = value.filter((v) => !/^#[\p{L}\p{N}_]+$/u.test(v));
                  return invalid.length > 0
                    ? Promise.reject(new Error(t("brandingEditor.hashtagInvalid")))
                    : Promise.resolve();
                },
              }]}
            >
              <Select
                mode="tags"
                tokenSeparators={[","]}
                placeholder="#hashtag"
                disabled={readOnly}
              />
            </Form.Item>
          </Space>
        ),
      }]} />

      {/* Thumbnail */}
      <Collapse size="small" style={{ marginBottom: 12 }} defaultActiveKey={["thumbnail"]} items={[{
        key: "thumbnail",
        label: t("brandingEditor.thumbnail"),
        children: (
          <Space direction="vertical" style={{ width: "100%" }} size={12}>
            {/* Live preview */}
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>{t("brandingEditor.preview")}</Text>
              <ThumbnailPreview
                seriesName={previewState.seriesName}
                firstExample={previewState.firstExample}
                textColor={previewState.textColor}
                outlineColor={previewState.outlineColor}
                position={previewState.position}
                textCase={previewState.textCase}
              />
            </div>

            <Form.Item name={["thumbnail", "concept"]} label={t("brandingEditor.thumbnailConcept")} rules={[{ required: true }]}>
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={500} />
            </Form.Item>
            <StringListField name={["thumbnail", "text_rules"]} label={t("brandingEditor.thumbnailTextRules")} maxItems={8} maxChars={300} readOnly={readOnly} />
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name={["thumbnail", "max_words"]} label={t("brandingEditor.thumbnailMaxWords")}>
                  <InputNumber min={1} max={8} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name={["thumbnail", "text_case"]} label={t("brandingEditor.thumbnailTextCase")}>
                  <Select
                    options={[
                      { value: "upper", label: t("brandingEditor.textCaseUpper") },
                      { value: "sentence", label: t("brandingEditor.textCaseSentence") },
                    ]}
                    disabled={readOnly}
                  />
                </Form.Item>
              </Col>
            </Row>

            {/* Palette */}
            <div>
              <Text style={{ fontSize: 14 }}>Palette</Text>
              <Row gutter={12} style={{ marginTop: 8 }}>
                <Col span={8}>
                  <Form.Item name={["thumbnail", "palette", "text"]} label={t("brandingEditor.paletteText")} getValueFromEvent={toHex}>
                    <ColorPicker disabled={readOnly} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name={["thumbnail", "palette", "outline"]} label={t("brandingEditor.paletteOutline")} getValueFromEvent={toHex}>
                    <ColorPicker disabled={readOnly} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name={["thumbnail", "palette", "accent"]} label={t("brandingEditor.paletteAccent")} getValueFromEvent={toHex}>
                    <ColorPicker disabled={readOnly} />
                  </Form.Item>
                </Col>
              </Row>
            </div>

            <Form.Item name={["thumbnail", "position"]} label={t("brandingEditor.position")}>
              <Select
                options={THUMBNAIL_TEXT_POSITIONS.map((p) => ({ value: p, label: t(`brandingEditor.position${p.charAt(0).toUpperCase() + p.slice(1)}`) }))}
                disabled={readOnly}
              />
            </Form.Item>
            <Form.Item name={["thumbnail", "emotion"]} label={t("brandingEditor.emotion")}>
              <Input maxLength={200} />
            </Form.Item>
            <StringListField name={["thumbnail", "do"]} label={t("brandingEditor.thumbnailDo")} maxItems={8} maxChars={300} readOnly={readOnly} />
            <StringListField name={["thumbnail", "dont"]} label={t("brandingEditor.thumbnailDont")} maxItems={8} maxChars={300} readOnly={readOnly} />
          </Space>
        ),
      }]} />

      {/* On-screen text */}
      <Collapse size="small" style={{ marginBottom: 12 }} items={[{
        key: "on_screen_text",
        label: t("brandingEditor.onScreenText"),
        children: (
          <Space direction="vertical" style={{ width: "100%" }} size={12}>
            <Form.Item name={["on_screen_text", "style"]} label={t("brandingEditor.onScreenStyle")}>
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={500} />
            </Form.Item>
            <Form.Item name={["on_screen_text", "max_chars"]} label={t("brandingEditor.onScreenMaxChars")}>
              <InputNumber min={10} max={64} style={{ width: 120 }} />
            </Form.Item>
            <StringListField name={["on_screen_text", "rules"]} label={t("brandingEditor.onScreenRules")} maxItems={8} maxChars={300} readOnly={readOnly} />
          </Space>
        ),
      }]} />

      {/* Music mood */}
      <Form.Item name="music_mood" label={t("brandingEditor.musicMood")}>
        <Select
          mode="tags"
          tokenSeparators={[","]}
          placeholder="chill, upbeat, inspirational"
          disabled={readOnly}
        />
      </Form.Item>

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

export function BrandingWritingSpinner() {
  const { t } = useTranslation();
  return (
    <div style={{ textAlign: "center", padding: 32 }}>
      <Spin />
      <div style={{ marginTop: 8, color: "var(--ant-color-text-secondary)" }}>
        {t("brandingEditor.writing")}
      </div>
    </div>
  );
}
