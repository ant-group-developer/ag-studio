import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import { RenderMachinePicker } from "./RenderMachinePicker";

describe("RenderMachinePicker", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("offers the three machine types, each explained, starting on the value given", () => {
    const onChange = vi.fn();
    render(<RenderMachinePicker value="nvenc" onChange={onChange} />);
    expect(screen.getByRole("radiogroup", { name: "Máy render" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Máy có NVENC/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Bất kỳ máy nào/ })).not.toBeChecked();
    expect(screen.getByText("Máy nào rảnh trước thì nhận.")).toBeInTheDocument();
    expect(screen.getByText(/Nếu không máy nào hợp, job sẽ chờ tới khi có máy; quá 2 giờ/)).toBeInTheDocument();
    // no farm machines given: nothing to pin
    expect(screen.queryByText("Máy cụ thể (không bắt buộc)")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /Máy có GPU/ }));
    expect(onChange).toHaveBeenCalledWith("gpu");
  });

  it("names each option by its machine type alone; the hint is its description", () => {
    render(<RenderMachinePicker value="any" onChange={vi.fn()} />);
    const nvenc = screen.getByRole("radio", { name: "Máy có NVENC" });
    expect(nvenc).toHaveAccessibleDescription("Encode bằng GPU NVIDIA, nhanh hơn với 4K.");
    expect(screen.getByRole("radio", { name: "Bất kỳ máy nào" })).toBeChecked();
  });

  it("with the farm's machines, pins the render to one, or to none", () => {
    const onNode = vi.fn();
    const nodes = [
      { id: "n1", name: "render-01", online: true, kinds: ["studio.render_final"], gpus: [{ name: "RTX 3060", vram_mb: 12288, nvenc: true }], running_jobs: 0, last_seen_at: null },
      { id: "n2", name: "render-02", online: false, kinds: ["studio.render_final"], gpus: [], running_jobs: 0, last_seen_at: null },
    ];
    render(<RenderMachinePicker value="any" onChange={vi.fn()} nodes={nodes} node={null} onNode={onNode} />);
    const select = screen.getByRole("combobox", { name: "Máy cụ thể (không bắt buộc)" });
    expect(screen.getByText("Không ghim: máy nào hợp thì nhận")).toBeInTheDocument();
    fireEvent.mouseDown(select);
    fireEvent.click(screen.getByText("render-01 · đang bật · NVENC"));
    expect(onNode).toHaveBeenCalledWith("n1");
    expect(screen.getByText("render-02 · đang tắt")).toBeInTheDocument();
  });
});
