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
    expect(screen.getByText("Nếu không máy nào hợp, job sẽ chờ tới khi có máy.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Máy có GPU/ }));
    expect(onChange).toHaveBeenCalledWith("gpu");
  });

  it("names each option by its machine type alone; the hint is its description", () => {
    render(<RenderMachinePicker value="any" onChange={vi.fn()} />);
    const nvenc = screen.getByRole("radio", { name: "Máy có NVENC" });
    expect(nvenc).toHaveAccessibleDescription("Encode bằng GPU NVIDIA, nhanh hơn với 4K.");
    expect(screen.getByRole("radio", { name: "Bất kỳ máy nào" })).toBeChecked();
  });
});
