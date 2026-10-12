import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import type { AgentPart } from "../../api/workspace-client";
import { ToolChip } from "./ToolChip";

const part = (over: Partial<Extract<AgentPart, { kind: "tool" }>>): Extract<AgentPart, { kind: "tool" }> => ({
  kind: "tool", id: "t1", name: "Write", input: { file_path: "/data/workspaces/p1/videos/v1/plan.md" },
  started_at: "2026-10-12T00:00:00Z", ended_at: "2026-10-12T00:00:02Z", ...over,
});

describe("tool chip", () => {
  it("opens the file it wrote straight from the chip, without unfolding it", async () => {
    await i18n.changeLanguage("vi");
    const onOpenFile = vi.fn();
    render(<ToolChip part={part({})} onOpenFile={onOpenFile} />);
    expect(screen.getByText("ghi file")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mở videos/v1/plan.md" }));
    expect(onOpenFile).toHaveBeenCalledWith("videos/v1/plan.md");
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
  });

  it("offers no file while the tool runs, when it failed, or for a tool without a file", async () => {
    await i18n.changeLanguage("vi");
    const { rerender } = render(<ToolChip part={part({ ended_at: undefined })} onOpenFile={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^Mở / })).toBeNull();
    rerender(<ToolChip part={part({ is_error: true })} onOpenFile={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^Mở / })).toBeNull();
    rerender(<ToolChip part={part({ name: "mcp__studio__footage_search", input: { q: "thuyền trên sông" } })} onOpenFile={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^Mở / })).toBeNull();
    expect(screen.getByText("tìm cảnh trong footage")).toBeInTheDocument();
    expect(screen.getByText("thuyền trên sông")).toBeInTheDocument();
  });
});
