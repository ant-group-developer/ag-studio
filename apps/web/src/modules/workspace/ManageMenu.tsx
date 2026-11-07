import { Dropdown, type MenuProps } from "antd";
import { Activity, BarChart3, ChevronDown, KeyRound, ListChecks, Music, Settings2, Stethoscope } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";

/**
 * The Studio-wide screens in one menu of the header instead of a button each: what a team owner reviews (stats,
 * activity log), the music library everyone uses, and what only a Studio admin runs (Queue, Claude accounts, Diagnostics).
 * The button reads as current while one of its pages is open.
 */
export function ManageMenu({ canReview, isAdmin }: { canReview: boolean; isAdmin: boolean }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const link = (to: string, label: string, icon: React.ReactNode) => ({ key: to, icon, label: <Link to={to}>{label}</Link> });
  const items: NonNullable<MenuProps["items"]> = [
    ...(canReview ? [{
      type: "group" as const, key: "review", label: t("ws.shell.menuReview"),
      children: [link("/stats", t("ws.shell.stats"), <BarChart3 size={14} />), link("/audit", t("ws.shell.audit"), <Activity size={14} />)],
    }] : []),
    {
      type: "group" as const, key: "studio", label: t("ws.shell.menuStudio"),
      children: [
        ...(isAdmin ? [link("/queue", t("ws.shell.queue"), <ListChecks size={14} />), link("/claude-accounts", t("ws.shell.claudeAccounts"), <KeyRound size={14} />),
          link("/diagnostics", t("ws.shell.diagnostics"), <Stethoscope size={14} />)] : []),
        link("/music", t("ws.shell.music"), <Music size={14} />),
      ],
    },
  ];
  const keys = ["/stats", "/audit", "/queue", "/claude-accounts", "/diagnostics", "/music"];
  const current = keys.find((k) => pathname === k || pathname.startsWith(`${k}/`));
  return (
    <Dropdown menu={{ items, selectedKeys: current ? [current] : [] }} trigger={["click"]} placement="bottomRight">
      <button type="button" className="ws-icon-button" aria-current={current ? "page" : undefined}>
        <Settings2 size={14} aria-hidden />{t("ws.shell.manage")}<ChevronDown size={12} aria-hidden />
      </button>
    </Dropdown>
  );
}
