import { useEffect } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { App as AntApp, type MenuProps } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { useStudioClient } from "../../api/studio-client";
import { useUserMenu } from "./user-menu";

/**
 * The signed-in person's menu as every layout shows it (old screens and chat screens): their card, language, Canva
 * connect, log out. Also handles the return from a Canva OAuth round trip (`?canva=connected|error`) on any page.
 */
export function useAppUserMenu(extraItems: NonNullable<MenuProps["items"]> = []) {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const { user, logout } = useAuth0();
  const client = useStudioClient();
  const qc = useQueryClient();

  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => client.getMe(), staleTime: 5 * 60_000 });
  const { data: canva } = useQuery({ queryKey: ["canva-connection"], queryFn: () => client.getCanvaConnection() });
  const disconnectCanva = useMutation({
    mutationFn: () => client.disconnectCanva(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["canva-connection"] });
      void message.success(t("canva.disconnectDone"));
    },
  });
  const connectCanva = async () => {
    const { authorizeUrl } = await client.authorizeCanva(location.pathname + location.search);
    window.location.href = authorizeUrl;
  };

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const outcome = params.get("canva");
    if (!outcome) return;
    if (outcome === "connected") {
      void qc.invalidateQueries({ queryKey: ["canva-connection"] });
      void message.success(t("canva.connectedMessage"));
    } else {
      void message.error(t("canva.errorMessage"));
    }
    params.delete("canva");
    params.delete("reason");
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : "" }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  const email = user?.email ?? "";
  const initials = email.slice(0, 2).toUpperCase();
  const nickname = user?.name ?? email;
  const menu = useUserMenu({
    nickname, email, avatarUrl: user?.picture, initials,
    onLogout: () => void logout({ logoutParams: { returnTo: window.location.origin } }),
    canvaEnabled: canva?.enabled ?? false,
    canvaConnected: canva?.connected ?? false,
    canvaDisplayName: canva?.displayName ?? null,
    onConnectCanva: () => void connectCanva(),
    onDisconnectCanva: () => disconnectCanva.mutate(),
    extraItems,
  });
  return { menu, isAdmin: me?.isAdmin ?? false, picture: user?.picture, initials, nickname };
}
