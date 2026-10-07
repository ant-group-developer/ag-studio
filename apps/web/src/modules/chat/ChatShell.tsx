import type { ReactNode } from "react";
import { Avatar, Dropdown } from "antd";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAppUserMenu } from "../common/use-app-user-menu";
import { ClaudeChip } from "./ClaudeChip";
import { RenderChip } from "./RenderChip";
import { VideoTree } from "./VideoTree";
import "./chat.css";

/**
 * Chat-first layout (spec local-chat §2.6): header, then three columns — videos · the chat · the result of the step.
 * `children` is the chat column and the result column.
 */
export function ChatShell({ children, productionId, episodeId }: { children: ReactNode; productionId?: string | undefined; episodeId?: string | undefined }) {
  const { t } = useTranslation();
  const { menu, picture, initials, nickname } = useAppUserMenu([
    { key: "old-productions", label: <Link to="/productions">{t("chat.oldScreens")}</Link> },
    { key: "teams", label: <Link to="/teams">{t("menu.teams")}</Link> },
  ]);
  return (
    <div className="chat-app">
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
      <div className="chat-body">
        <VideoTree productionId={productionId} episodeId={episodeId} />
        {children}
      </div>
    </div>
  );
}
