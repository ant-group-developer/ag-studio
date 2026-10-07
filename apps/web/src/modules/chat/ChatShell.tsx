import { useRef, type CSSProperties, type ReactNode } from "react";
import { Avatar, Dropdown } from "antd";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAppUserMenu } from "../common/use-app-user-menu";
import { ClaudeChip } from "./ClaudeChip";
import { ColumnResizer, useColumnWidths } from "./ColumnResizer";
import { RenderChip } from "./RenderChip";
import { VideoTree } from "./VideoTree";
import "./chat.css";

/**
 * Chat-first layout (spec local-chat §2.6): header, then three columns — videos · the chat · the result of the step.
 * `children` is the chat column and the result column. The side columns can be dragged wider or narrower.
 */
export function ChatShell({ children, productionId, episodeId }: { children: ReactNode; productionId?: string | undefined; episodeId?: string | undefined }) {
  const { t } = useTranslation();
  const { menu, picture, initials, nickname } = useAppUserMenu([
    { key: "old-productions", label: <Link to="/productions">{t("chat.oldScreens")}</Link> },
    { key: "teams", label: <Link to="/teams">{t("menu.teams")}</Link> },
  ]);
  const body = useRef<HTMLDivElement>(null);
  const { widths, set } = useColumnWidths();
  const style = {
    ...(widths.nav ? { "--chat-nav-w": `${widths.nav}px` } : {}),
    ...(widths.aside ? { "--chat-aside-w": `${widths.aside}px` } : {}),
  } as CSSProperties;
  return (
    <div className="chat-app" style={style}>
      <header className="chat-header">
        <Link to="/" className="chat-header__brand"><img src="/favicon.png" alt="" />{t("app.title")}</Link>
        <div className="chat-header__right">
          <ClaudeChip />
          <RenderChip />
          <Dropdown menu={menu} trigger={["click"]} placement="bottomRight">
            <button type="button" className="chat-link-button" aria-label={nickname}>
              <Avatar src={picture} size="small">{picture ? undefined : initials}</Avatar>
            </button>
          </Dropdown>
        </div>
      </header>
      <div className="chat-body" ref={body}>
        <VideoTree productionId={productionId} episodeId={episodeId} />
        {children}
        <ColumnResizer column="nav" body={() => body.current} onResize={(w, persist) => set("nav", w, persist)} />
        <ColumnResizer column="aside" body={() => body.current} onResize={(w, persist) => set("aside", w, persist)} />
      </div>
    </div>
  );
}
