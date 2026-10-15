import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { isInternalHref, Markdown } from "./Markdown";

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname}{l.search}</p>;
}

describe("Markdown links", () => {
  it("opens a link of Studio through the router and others in a new tab", () => {
    render(
      <MemoryRouter initialEntries={["/p/p1/v/v1"]}>
        <Routes><Route path="*" element={<><Where /><Markdown text={"Đã xong. [Mở ở tab Xem trước](/p/p1/v/v1?tab=preview) · [YouTube](https://youtube.com/watch?v=x)"} /></>} /></Routes>
      </MemoryRouter>,
    );
    const outside = screen.getByRole("link", { name: "YouTube" });
    expect(outside).toHaveAttribute("target", "_blank");
    expect(outside).toHaveAttribute("rel", "noopener noreferrer");
    const inside = screen.getByRole("link", { name: "Mở ở tab Xem trước" });
    expect(inside).not.toHaveAttribute("target");
    fireEvent.click(inside);
    expect(screen.getByTestId("where")).toHaveTextContent("/p/p1/v/v1?tab=preview");
  });

  it("still renders a link outside a router", () => {
    render(<Markdown text="[Xem](/p/p1)" />);
    expect(screen.getByRole("link", { name: "Xem" })).toHaveAttribute("href", "/p/p1");
  });

  it("counts only this site's paths as inside", () => {
    expect(isInternalHref("/p/p1/v/v1?tab=preview")).toBe(true);
    expect(isInternalHref("//evil.test/x")).toBe(false);
    expect(isInternalHref("/\\evil.test")).toBe(false);
    expect(isInternalHref("https://studio.test/p/1")).toBe(false);
    expect(isInternalHref(undefined)).toBe(false);
  });
});
