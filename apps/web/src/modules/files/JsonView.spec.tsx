import { fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp } from "antd";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import { jsonErrorAt, jsonErrorOffset, jsonPath, JsonView, parseJson } from "./JsonView";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const PLAN = JSON.stringify({ title: "Tràng An", clips: [{ in: 1.5, out: 4, src: "Hoa Lư 03.mp4", muted: false, note: null }], "tên có dấu cách": 1 }, null, 2);
const mount = (text: string, lines = false) => render(<AntApp><JsonView text={text} lines={lines} /></AntApp>);

describe("JSON viewer", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("writes paths as you would reach the value", () => {
    expect(jsonPath(jsonPath(jsonPath("$", "clips"), 3), "in")).toBe("$.clips[3].in");
    expect(jsonPath("$", "tên có dấu cách")).toBe('$["tên có dấu cách"]');
  });

  it("says where a file breaks, by position or by line and column", () => {
    expect(jsonErrorAt('{\n  "a": 1,\n}', "Unexpected token } in JSON at position 12")).toEqual({ line: 3, column: 1 });
    expect(jsonErrorAt("", "Expected ',' (line 4 column 7)")).toEqual({ line: 4, column: 7 });
    // Chrome only quotes the text around the error: Studio finds the place itself
    expect(jsonErrorAt('{\n  "clips": [1, 2,\n  oops\n}', `Unexpected token 'o', ..."[1, 2,\n  oops\n}" is not valid JSON`)).toEqual({ line: 3, column: 3 });
    expect(jsonErrorOffset('{"a": [1, {"b": "c\\u00e9"}], "d": -1.5e3, "e": null}')).toBe(-1);
    expect(jsonErrorOffset('{"a": 1,}')).toBe(8);
    expect(jsonErrorOffset('{"a": 1} x')).toBe(9);
    expect(parseJson('{"a":1}\n\n{"b":2}\n', true)).toEqual({ ok: true, values: [{ line: 1, value: { a: 1 } }, { line: 3, value: { b: 2 } }] });
    expect(parseJson('{"a":1}\n{oops}', true)).toMatchObject({ ok: false, at: { line: 2 } });
  });

  it("shows a tree three levels open, each value in its colour; nodes open and close, all at once too", () => {
    mount(PLAN);
    expect(screen.getByText('"Tràng An"')).toHaveClass("ws-json__str");
    expect(screen.getByText("1.5")).toHaveClass("ws-json__num");
    expect(screen.getByText("false")).toHaveClass("ws-json__bool");
    expect(screen.getByText("null")).toHaveClass("ws-json__null");
    fireEvent.click(screen.getByRole("button", { name: "Đóng $.clips" }));
    expect(screen.queryByText("1.5")).toBeNull();
    expect(screen.getByText("1 phần tử")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mở hết" }));
    expect(screen.getByText("1.5")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Đóng hết" }));
    expect(screen.queryByText('"Tràng An"')).toBeNull();
    expect(screen.getByText("3 khoá")).toBeInTheDocument();
  });

  it("copies a node's path or value", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mount(PLAN);
    fireEvent.click(screen.getByRole("button", { name: "Copy đường dẫn $.clips[0].src" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy giá trị $.clips[0].src" }));
    expect(writeText.mock.calls).toEqual([["$.clips[0].src"], ["Hoa Lư 03.mp4"]]);
  });

  it("shows the pretty text with line numbers, and a broken file as text with the bad line marked", () => {
    const { unmount } = mount(PLAN);
    fireEvent.click(screen.getByText("Thô"));
    expect(document.querySelector(".ws-json__raw")).toHaveTextContent('"title": "Tràng An"');
    unmount();
    mount('{\n  "a": 1,\n  oops\n}');
    expect(screen.getByRole("alert")).toHaveTextContent("JSON lỗi ở dòng 3");
    expect(document.querySelector(".ws-json__line--bad")).toHaveTextContent("oops");
  });

  it("reads JSON Lines one record per line", () => {
    mount('{"event":"start"}\n{"event":"end"}\n', true);
    expect(screen.getByText("2 dòng")).toBeInTheDocument();
    const second = screen.getByText("Dòng 2").parentElement!;
    expect(within(second).getByText('"end"')).toBeInTheDocument();
  });
});
