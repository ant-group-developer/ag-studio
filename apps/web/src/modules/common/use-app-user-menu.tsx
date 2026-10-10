import { useAuth0 } from "@auth0/auth0-react";
import type { MenuProps } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useStudioClient } from "../../api/studio-client";
import { useUserMenu } from "./user-menu";

/** The signed-in person's menu as every layout shows it (workspace and team screens): their card, language, log out. */
export function useAppUserMenu(extraItems: NonNullable<MenuProps["items"]> = []) {
  const { user, logout } = useAuth0();
  const client = useStudioClient();

  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => client.getMe(), staleTime: 5 * 60_000 });
  const email = user?.email ?? "";
  const initials = email.slice(0, 2).toUpperCase();
  const nickname = user?.name ?? email;
  const menu = useUserMenu({
    nickname, email, avatarUrl: user?.picture, initials,
    onLogout: () => void logout({ logoutParams: { returnTo: window.location.origin } }),
    extraItems,
  });
  return { menu, isAdmin: me?.isAdmin ?? false, picture: user?.picture, initials, nickname };
}
