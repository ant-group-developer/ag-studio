import { fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import type { VersionDiff } from "../../api/workspace-client";

const ws = {
  fileVersionDiff: vi.fn(),
  listFileVersions: vi.fn(),
  getFileVersion: vi.fn(),
  restoreFileVersion: vi.fn(),
};
vi.mock("../../api/workspace-client", async (orig) => ({ ...(await orig<object>()), useWorkspaceClient: () => ws }));

const { DiffView } = await import("./DiffView");
const { ChangedFiles } = await import("../agent-chat/ChangedFiles");
const { FileHistory } = await import("./FileHistory");

const wrap = (ui: ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AntApp>{ui}</AntApp></QueryClientProvider>,
);

const DIFF: VersionDiff = {
  path: "channel/plan.md", version_id: "v2", before_version_id: "v1", added: 1, removed: 1,
  hunks: [
    { old_start: 8, old_lines: 3, new_start: 8, new_lines: 3, lines: [{ kind: "context", text: "tám" }, { kind: "del", text: "chín" }, { kind: "add", text: "CHÍN" }, { kind: "context", text: "mười" }] },
    { old_start: 30, old_lines: 1, new_start: 30, new_lines: 1, lines: [{ kind: "context", text: "ba mươi" }] },
  ],
};

describe("what a file changed", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("shows added lines and removed ones with both line numbers, the unchanged lines between folded", () => {
    render(<DiffView diff={DIFF} />);
    const table = screen.getByRole("table", { name: "Xem thay đổi của channel/plan.md" });
    const rows = within(table).getAllByRole("row");
    expect(rows[0]).toHaveTextContent("⋯ 7 dòng không đổi");
    expect(rows[2]).toHaveClass("ws-diff__row--del");
    expect(rows[2]).toHaveTextContent("9−chín");
    expect(rows[3]).toHaveClass("ws-diff__row--add");
    expect(rows[3]).toHaveTextContent("9+CHÍN");
    expect(rows[5]).toHaveTextContent("⋯ 19 dòng không đổi");
    expect(screen.getByText("+1")).toBeInTheDocument();
  });

  it("says why a diff cannot be shown, or that nothing changed", () => {
    const { rerender } = render(<DiffView diff={{ path: "a.png", version_id: "v", before_version_id: null, unavailable: "binary" }} />);
    expect(screen.getByText("Tệp nhị phân: không so được từng dòng.")).toBeInTheDocument();
    rerender(<DiffView diff={{ path: "a.md", version_id: "v", before_version_id: null, unavailable: "too_large" }} />);
    expect(screen.getByText("Tệp quá lớn để so từng dòng.")).toBeInTheDocument();
    rerender(<DiffView diff={{ path: "a.md", version_id: "v", before_version_id: "u", hunks: [], added: 0, removed: 0 }} />);
    expect(screen.getByText("Không có dòng nào thay đổi.")).toBeInTheDocument();
  });

  it("lists a turn's changed files: open one, or see its changes in a drawer; a deleted one only has its changes", async () => {
    ws.fileVersionDiff.mockResolvedValue(DIFF);
    const onOpenFile = vi.fn();
    wrap(<ChangedFiles projectId="p1" onOpenFile={onOpenFile} files={[
      { path: "channel/plan.md", change: "modified", version_id: "v2", before_version_id: "v1", added: 1, removed: 1 },
      { path: "context/new.md", change: "added", version_id: "v3", before_version_id: null, added: 4, removed: 0 },
      { path: "context/old.md", change: "deleted", version_id: "v4", before_version_id: "v0" },
    ]} />);
    const card = screen.getByRole("region", { name: "3 file đã thay đổi" });
    expect(within(card).getByText("sửa")).toBeInTheDocument();
    expect(within(card).getByText("mới")).toBeInTheDocument();
    expect(within(card).getByText("xoá")).toBeInTheDocument();
    expect(within(card).getByText("+4")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Mở channel/plan.md" }));
    expect(onOpenFile).toHaveBeenCalledWith("channel/plan.md");
    expect(within(card).queryByRole("button", { name: "Mở context/old.md" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Xem thay đổi của context/new.md" }));
    expect(ws.fileVersionDiff).toHaveBeenCalledWith("p1", "v3", "none");
    fireEvent.click(within(card).getByRole("button", { name: "Xem thay đổi của context/old.md" }));
    expect(ws.fileVersionDiff).toHaveBeenLastCalledWith("p1", "v4", "v0");
    expect(await screen.findByText("Thay đổi · context/old.md")).toBeInTheDocument();
    expect(await screen.findByText("CHÍN")).toBeInTheDocument();
  });

  it("file history: a version compares with the one before it", async () => {
    ws.listFileVersions.mockResolvedValue({ versions: [
      { id: "v2", path: "channel/plan.md", sha256: "b", size: 10, author_kind: "agent", author_id: null, message_id: "m", created_at: new Date().toISOString(), has_content: 1 },
    ] });
    ws.getFileVersion.mockResolvedValue({ id: "v2", path: "channel/plan.md", sha256: "b", size: 10, author_kind: "agent", author_id: null, message_id: "m", created_at: "", has_content: 1, content: "x", issues: null });
    ws.fileVersionDiff.mockResolvedValue(DIFF);
    wrap(<FileHistory projectId="p1" path="channel/plan.md" currentSha="b" canRestore onRestored={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Agent|agent/ }));
    fireEvent.click(await screen.findByRole("button", { name: "So với bản trước" }));
    expect(await screen.findByText("CHÍN")).toBeInTheDocument();
    expect(ws.fileVersionDiff).toHaveBeenLastCalledWith("p1", "v2", undefined);
    fireEvent.click(screen.getByRole("button", { name: "Xem nội dung" }));
    expect(screen.queryByText("CHÍN")).toBeNull();
  });
});
