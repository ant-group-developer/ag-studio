import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import { clampWidth, ColumnResizer } from "./ColumnResizer";

describe("column widths", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("keep their limits and leave the chat in the middle 380px", () => {
    expect(clampWidth("nav", 100, 1440, 432)).toBe(220);
    expect(clampWidth("nav", 300, 1440, 432)).toBe(300);
    expect(clampWidth("nav", 900, 1440, 432)).toBe(520);
    expect(clampWidth("nav", 900, 1440, 600)).toBe(460);
    expect(clampWidth("aside", 2000, 1600, 300)).toBe(900);
  });

  it("the handle widens with ←/→ and goes back to the default on a double click", () => {
    const onResize = vi.fn();
    const sized = (cls: string, width: number) => {
      const el = document.createElement("div");
      if (cls) el.className = cls;
      el.getBoundingClientRect = () => ({ width } as DOMRect);
      return el;
    };
    const body = sized("", 1440);
    body.append(sized("chat-nav", 300), sized("chat-aside", 400));
    render(<ColumnResizer column="aside" body={() => body} onResize={onResize} />);
    const handle = screen.getByRole("separator", { name: "Đổi độ rộng cột kết quả" });
    // the result pane sits on the right: ← makes it wider
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onResize).toHaveBeenLastCalledWith(416, true);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onResize).toHaveBeenLastCalledWith(384, true);
    fireEvent.doubleClick(handle);
    expect(onResize).toHaveBeenLastCalledWith(undefined, true);
  });
});
