import { renderHook } from "@testing-library/react";
import type { MenuProps } from "antd";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import { useUserMenu } from "./user-menu";

type Item = { key?: string; label?: unknown; onClick?: () => void; children?: Item[] };

function render(opts: {
  onLogout?: () => void;
  canvaEnabled?: boolean;
  canvaConnected?: boolean;
  canvaDisplayName?: string | null;
  onConnectCanva?: () => void;
  onDisconnectCanva?: () => void;
} = {}) {
  const onLogout = opts.onLogout ?? vi.fn();
  const { result } = renderHook(() =>
    useUserMenu({ nickname: "Demo", email: "demo@example.com", initials: "DE", onLogout, ...opts }),
  );
  return { menu: result.current as MenuProps, items: result.current.items as Item[], onLogout };
}

describe("useUserMenu", () => {
  it("có thẻ người dùng, menu ngôn ngữ và đăng xuất như ag-go-web", async () => {
    await i18n.changeLanguage("vi");
    const { items, menu } = render();
    expect(items.map((i) => i?.key)).toEqual(["user", undefined, "language", "logout"]);
    const language = items.find((i) => i?.key === "language")!;
    expect(language.label).toBe("Ngôn ngữ: Tiếng Việt");
    expect(language.children!.map((c) => c.key)).toEqual(["language:vi", "language:en"]);
    expect(menu.selectedKeys).toEqual(["language:vi"]);
  });

  it("chọn English thì đổi ngôn ngữ; đăng xuất gọi onLogout", async () => {
    const { items, onLogout } = render();
    items.find((i) => i?.key === "language")!.children!.find((c) => c.key === "language:en")!.onClick!();
    await vi.waitFor(() => expect(i18n.resolvedLanguage).toBe("en"));
    items.find((i) => i?.key === "logout")!.onClick!();
    expect(onLogout).toHaveBeenCalledOnce();
    await i18n.changeLanguage("vi");
  });

  it("không có mục Canva khi tích hợp đang tắt", () => {
    const { items } = render({ canvaEnabled: false });
    expect(items.find((i) => i?.key === "canva")).toBeUndefined();
  });

  it("chưa kết nối: mục Canva gọi onConnectCanva", async () => {
    await i18n.changeLanguage("vi");
    const onConnectCanva = vi.fn();
    const { items } = render({ canvaEnabled: true, canvaConnected: false, onConnectCanva });
    const canva = items.find((i) => i?.key === "canva")!;
    expect(canva.label).toBe("Kết nối Canva");
    canva.onClick!();
    expect(onConnectCanva).toHaveBeenCalledOnce();
  });

  it("đã kết nối: mục Canva xác nhận rồi gọi onDisconnectCanva", async () => {
    await i18n.changeLanguage("vi");
    const onDisconnectCanva = vi.fn();
    const { items } = render({ canvaEnabled: true, canvaConnected: true, canvaDisplayName: "ACME", onDisconnectCanva });
    const canva = items.find((i) => i?.key === "canva")!;
    const label = canva.label as ReactElement<{ title: ReactElement; onConfirm: () => void }>;
    expect(label.props.title).toBe("Ngắt kết nối Canva?");
    expect(label.props.onConfirm).toBe(onDisconnectCanva);
    label.props.onConfirm();
    expect(onDisconnectCanva).toHaveBeenCalledOnce();
  });
});
