import { renderHook } from "@testing-library/react";
import type { MenuProps } from "antd";
import { describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import { useUserMenu } from "./user-menu";

type Item = { key?: string; label?: unknown; onClick?: () => void; children?: Item[] };

function render(onLogout = vi.fn()) {
  const { result } = renderHook(() =>
    useUserMenu({ nickname: "Demo", email: "demo@example.com", initials: "DE", onLogout }),
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
});
