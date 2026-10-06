import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import type { EpisodeRender } from "../../api/studio-client";
import { RenderFinalModal } from "./RenderFinalModal";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const info = (over: Partial<EpisodeRender>): EpisodeRender => ({ machine: null, defaultMachine: "nvenc", restartFrom: "render-final", job: null, farmStatus: null, ...over });

describe("RenderFinalModal", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("says what runs again and sends the machine type picked", () => {
    const onConfirm = vi.fn();
    render(<RenderFinalModal open render={info({})} onClose={vi.fn()} onConfirm={onConfirm} />);
    expect(screen.getByText("Chỉ render lại, giữ timeline và YouTube kit đã duyệt.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Máy có NVENC/ })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /Bất kỳ máy nào/ }));
    fireEvent.click(screen.getByRole("button", { name: "Render" }));
    expect(onConfirm).toHaveBeenCalledWith("any");
  });

  it("a timeline edited since approval is approved again first, and the run of a new episode starts from the top", () => {
    const { rerender } = render(<RenderFinalModal open render={info({ restartFrom: "approve-timeline" })} onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText("Timeline đã sửa sau khi duyệt: bạn sẽ duyệt lại timeline và YouTube kit trước khi render.")).toBeInTheDocument();
    rerender(<RenderFinalModal open render={info({ restartFrom: "start" })} onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText("Tập chưa chạy: dựng timeline, chờ bạn duyệt timeline và YouTube kit, rồi render.")).toBeInTheDocument();
  });
});
