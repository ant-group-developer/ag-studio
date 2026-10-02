/**
 * ThumbnailWordEditor — Modal to draw words on a clean thumbnail: text (≤60 chars), position/size, colours,
 * an optional band behind the text, uppercase, with a live preview (POST preview, debounced ~400ms) and two
 * starting presets (the production's branding, or a neutral default). "Lưu" composes the picture, then offers
 * "Dùng làm thumbnail" to pick it right away.
 */
import { useState } from "react";
import { Alert, App as AntApp, Button, ColorPicker, Input, Modal, Segmented, Space, Spin, Switch, Typography } from "antd";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery } from "@tanstack/react-query";
import { THUMBNAIL_TEXT_MAX, THUMBNAIL_TEXT_POSITIONS, THUMBNAIL_TEXT_SIZES } from "@harness/contracts";
import type { StudioBranding, ThumbnailStyle } from "@harness/contracts";
import { useStudioClient, type ThumbnailView } from "../../api/studio-client";
import { useDebouncedValue } from "../../helpers/use-debounced-value";
import { brandingThumbnailStyle, errorText, neutralThumbnailStyle, thumbBox } from "./thumbnail-helpers";

const { Text } = Typography;

/** Normalise antd's ColorPicker value (a `Color` object or already a hex string) to `#RRGGBB`. */
function toHex(val: unknown): string {
  if (typeof val === "string" && /^#[0-9A-Fa-f]{6}$/.test(val)) return val.toUpperCase();
  if (val && typeof val === "object" && "toHexString" in val) {
    return (val as { toHexString: () => string }).toHexString().toUpperCase().slice(0, 7);
  }
  return "#FFFFFF";
}

interface BodyProps {
  productionId: string;
  episodeId: string;
  base: ThumbnailView;
  defaultText: string;
  branding: StudioBranding | null;
  onClose: () => void;
  onComposed: (view: ThumbnailView) => void;
  onUseAsThumbnail: (thumbnailId: string) => void;
}

function WordEditorBody({ productionId, episodeId, base, defaultText, branding, onClose, onComposed, onUseAsThumbnail }: BodyProps) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const { message } = AntApp.useApp();

  const [text, setText] = useState(base.text ?? defaultText);
  // the series look first: the branding preset unless the picture already has its own words
  const [style, setStyle] = useState<ThumbnailStyle>(base.style ?? (branding ? brandingThumbnailStyle(branding) : neutralThumbnailStyle()));
  const [hasBox, setHasBox] = useState(style.box_color != null);
  const [boxColor, setBoxColor] = useState(style.box_color ?? branding?.thumbnail.palette.accent ?? "#000000");
  const [composed, setComposed] = useState<ThumbnailView | null>(null);

  const effectiveStyle: ThumbnailStyle = { ...style, box_color: hasBox ? boxColor : null };
  const debouncedText = useDebouncedValue(text, 400);
  const debouncedStyle = useDebouncedValue(effectiveStyle, 400);

  const { data: preview, isFetching: previewLoading } = useQuery({
    queryKey: ["thumbnail-preview", base.id, debouncedText, debouncedStyle],
    queryFn: () => client.previewThumbnail(productionId, episodeId, base.id, debouncedText, debouncedStyle),
    enabled: debouncedText.trim().length > 0,
    placeholderData: (prev) => prev,
  });

  const composeMutation = useMutation({
    mutationFn: () => client.composeThumbnail(productionId, episodeId, base.id, text, effectiveStyle),
    onSuccess: (view) => {
      setComposed(view);
      onComposed(view);
      void message.success(t("thumbnails.composeDone"));
    },
    onError: (err) => void message.error(errorText(err, t)),
  });

  const applyPreset = (preset: ThumbnailStyle) => {
    setStyle(preset);
    setHasBox(preset.box_color != null);
    if (preset.box_color) setBoxColor(preset.box_color);
  };

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={16}>
      <Space>
        <Button size="small" onClick={() => applyPreset(neutralThumbnailStyle())}>
          {t("thumbnails.presetDefault")}
        </Button>
        {branding && (
          <Button size="small" onClick={() => applyPreset(brandingThumbnailStyle(branding))}>
            {t("thumbnails.presetBranding")}
          </Button>
        )}
      </Space>

      <div style={{ position: "relative", ...thumbBox(base, 320), background: "#222", borderRadius: 6, overflow: "hidden" }}>
        {preview?.dataUrl && (
          <img src={preview.dataUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        )}
        {previewLoading && (
          <div
            style={{
              position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
              background: "rgba(0,0,0,0.25)",
            }}
          >
            <Spin />
          </div>
        )}
      </div>

      <Input.TextArea
        value={text}
        maxLength={THUMBNAIL_TEXT_MAX}
        showCount
        rows={2}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("thumbnails.textLabel")}
      />

      <Space wrap size={24}>
        <div>
          <Text type="secondary" style={{ display: "block", marginBottom: 4 }}>{t("thumbnails.positionLabel")}</Text>
          <Segmented
            value={style.position}
            onChange={(v) => setStyle({ ...style, position: v as ThumbnailStyle["position"] })}
            options={THUMBNAIL_TEXT_POSITIONS.map((p) => ({ value: p, label: t(`thumbnails.position.${p}`) }))}
          />
        </div>
        <div>
          <Text type="secondary" style={{ display: "block", marginBottom: 4 }}>{t("thumbnails.sizeLabel")}</Text>
          <Segmented
            value={style.size}
            onChange={(v) => setStyle({ ...style, size: v as ThumbnailStyle["size"] })}
            options={THUMBNAIL_TEXT_SIZES.map((s) => ({ value: s, label: t(`thumbnails.size.${s}`) }))}
          />
        </div>
      </Space>

      <Space wrap size={24} align="start">
        <div>
          <Text type="secondary" style={{ display: "block", marginBottom: 4 }}>{t("thumbnails.textColorLabel")}</Text>
          <ColorPicker value={style.text_color} onChange={(c) => setStyle({ ...style, text_color: toHex(c) })} />
        </div>
        <div>
          <Text type="secondary" style={{ display: "block", marginBottom: 4 }}>{t("thumbnails.outlineColorLabel")}</Text>
          <ColorPicker value={style.outline_color} onChange={(c) => setStyle({ ...style, outline_color: toHex(c) })} />
        </div>
        <div>
          <Text type="secondary" style={{ display: "block", marginBottom: 4 }}>{t("thumbnails.boxColorToggle")}</Text>
          <Space>
            <Switch checked={hasBox} onChange={setHasBox} />
            {hasBox && <ColorPicker value={boxColor} onChange={(c) => setBoxColor(toHex(c))} />}
          </Space>
        </div>
        <div>
          <Text type="secondary" style={{ display: "block", marginBottom: 4 }}>{t("thumbnails.uppercaseLabel")}</Text>
          <Switch checked={style.uppercase} onChange={(v) => setStyle({ ...style, uppercase: v })} />
        </div>
      </Space>

      {composed ? (
        <Alert
          type="success"
          showIcon
          message={t("thumbnails.composeDone")}
          action={
            <Space direction="vertical">
              <Button size="small" type="primary" onClick={() => onUseAsThumbnail(composed.id)}>
                {t("thumbnails.useThisOne")}
              </Button>
              <Button size="small" onClick={onClose}>{t("thumbnails.close")}</Button>
            </Space>
          }
        />
      ) : (
        <Button type="primary" loading={composeMutation.isPending} disabled={!text.trim()} onClick={() => composeMutation.mutate()}>
          {t("thumbnails.save")}
        </Button>
      )}
    </Space>
  );
}

export interface ThumbnailWordEditorProps {
  open: boolean;
  base: ThumbnailView | null;
  defaultText: string;
  branding: StudioBranding | null;
  productionId: string;
  episodeId: string;
  onClose: () => void;
  onComposed: (view: ThumbnailView) => void;
  onUseAsThumbnail: (thumbnailId: string) => void;
}

export function ThumbnailWordEditor({ open, base, defaultText, branding, productionId, episodeId, onClose, onComposed, onUseAsThumbnail }: ThumbnailWordEditorProps) {
  const { t } = useTranslation();
  return (
    <Modal open={open && !!base} onCancel={onClose} footer={null} width={640} destroyOnClose title={t("thumbnails.editorTitle")}>
      {base && (
        <WordEditorBody
          key={base.id}
          productionId={productionId}
          episodeId={episodeId}
          base={base}
          defaultText={defaultText}
          branding={branding}
          onClose={onClose}
          onComposed={onComposed}
          onUseAsThumbnail={onUseAsThumbnail}
        />
      )}
    </Modal>
  );
}
