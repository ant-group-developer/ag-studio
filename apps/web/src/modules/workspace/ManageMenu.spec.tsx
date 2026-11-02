/**
 * The header's "Quản lý" menu: the Studio-wide screens behind one button. A team owner gets stats and the activity
 * log; a Studio admin also the Queue and the Claude accounts; everyone the music library. The button reads as current
 * on one of those pages.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, describe, expect, it } from "vitest";
import i18n from "../../i18n/config";
import { ManageMenu } from "./ManageMenu";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

beforeAll(async () => { await i18n.changeLanguage("vi"); });

function open(props: { canReview: boolean; isAdmin: boolean }, path = "/") {
  render(<MemoryRouter initialEntries={[path]}><ManageMenu {...props} /></MemoryRouter>);
  const button = screen.getByRole("button", { name: /Quản lý/ });
  fireEvent.click(button);
  return button;
}
const links = () => screen.getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")]);

describe("ManageMenu", () => {
  it("a Studio admin finds every Studio-wide screen in it", async () => {
    open({ canReview: true, isAdmin: true });
    await screen.findByRole("link", { name: "Tài khoản Claude" });
    expect(links()).toEqual([
      ["Thống kê", "/stats"], ["Nhật ký", "/audit"], ["Hàng đợi", "/queue"], ["Tài khoản Claude", "/claude-accounts"], ["Kho nhạc", "/music"],
    ]);
  });

  it("a team owner: stats, the log and the music; someone else: only the music", async () => {
    open({ canReview: true, isAdmin: false });
    await screen.findByRole("link", { name: "Kho nhạc" });
    expect(links().map(([, href]) => href)).toEqual(["/stats", "/audit", "/music"]);
  });

  it("reads as current on one of its pages", () => {
    expect(open({ canReview: false, isAdmin: true }, "/claude-accounts")).toHaveAttribute("aria-current", "page");
  });
});
