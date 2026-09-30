import { useState } from "react";
import { Button, Dropdown } from "antd";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SortDirection } from "./compare-sort-values";

export type SortState<F extends string> = { sortBy: F; sortOrder: SortDirection };

type Props<F extends string> = {
  fields: readonly { value: F; label: string }[];
  sortBy: F;
  sortOrder: SortDirection;
  onChange: (change: Partial<SortState<F>>) => void;
  size?: "small" | "middle" | "large";
};

const DIRS: readonly SortDirection[] = ["asc", "desc"];

export function SortDropdown<F extends string>({ fields, sortBy, sortOrder, onChange, size }: Props<F>) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const iconSize = size === "small" ? 14 : 16;
  const activeLabel = fields.find((f) => f.value === sortBy)?.label ?? sortBy;

  return (
    <Dropdown
      trigger={["click"]}
      open={open}
      onOpenChange={(next, info) => { if ((info as { source?: string }).source === "trigger") setOpen(next); }}
      menu={{
        items: [
          {
            type: "group",
            label: t("common.sort"),
            children: fields.map((f) => ({
              key: `sortBy:${f.value}`,
              label: f.label,
              extra: sortBy === f.value ? <Check size={14} /> : null,
              onClick: () => onChange({ sortBy: f.value }),
            })),
          },
          { type: "divider" },
          ...DIRS.map((dir) => ({
            key: `sortOrder:${dir}`,
            icon: dir === "asc" ? <ArrowUpNarrowWide size={14} /> : <ArrowDownWideNarrow size={14} />,
            label: t(dir === "asc" ? "common.sortAsc" : "common.sortDesc"),
            extra: sortOrder === dir ? <Check size={14} /> : null,
            onClick: () => onChange({ sortOrder: dir }),
          })),
        ],
      }}
    >
      <Button size={size} icon={sortOrder === "asc" ? <ArrowUpNarrowWide size={iconSize} /> : <ArrowDownWideNarrow size={iconSize} />}>
        {activeLabel}
      </Button>
    </Dropdown>
  );
}
