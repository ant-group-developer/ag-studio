/**
 * ThumbnailGrid — a tab's pictures as clickable tiles: a green check on the one in use, a small badge when
 * a picture is open in Canva, an optional caption (the "Khung hình" tab shows the frame's timestamp there).
 */
import { Empty } from "antd";
import { Check, ExternalLink } from "lucide-react";
import type { ThumbnailView } from "../../api/studio-client";
import { thumbBox } from "./thumbnail-helpers";

interface Props {
  items: ThumbnailView[];
  selectedId: string | null;
  activeId: string | null;
  onPick: (item: ThumbnailView) => void;
  emptyText: string;
  caption?: (item: ThumbnailView) => string | null;
}

export function ThumbnailGrid({ items, selectedId, activeId, onPick, emptyText, caption }: Props) {
  if (items.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />;
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {items.map((item) => {
        const label = caption?.(item) ?? null;
        return (
          <div
            key={item.id}
            onClick={() => onPick(item)}
            role="button"
            aria-label={item.id}
            style={{
              position: "relative",
              ...thumbBox(item, 140),
              cursor: "pointer",
              borderRadius: 6,
              overflow: "hidden",
              outline: item.id === activeId ? "2px solid #1677ff" : "2px solid transparent",
              outlineOffset: -2,
              flexShrink: 0,
            }}
          >
            <img
              src={item.url}
              alt=""
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", background: "#f0f0f0" }}
            />
            {item.id === selectedId && (
              <span
                style={{
                  position: "absolute", top: 4, left: 4, width: 18, height: 18, borderRadius: "50%",
                  background: "#52c41a", display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                <Check size={12} color="#fff" />
              </span>
            )}
            {item.inCanva && (
              <span
                style={{
                  position: "absolute", top: 4, right: 4, width: 18, height: 18, borderRadius: "50%",
                  background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                <ExternalLink size={10} color="#fff" />
              </span>
            )}
            {label && (
              <span
                style={{
                  position: "absolute", bottom: 0, right: 0, background: "rgba(0,0,0,0.6)", color: "#fff",
                  fontSize: 11, padding: "1px 4px", borderTopLeftRadius: 4,
                }}
              >
                {label}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
