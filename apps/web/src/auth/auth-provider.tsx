import { Auth0Provider } from "@auth0/auth0-react";
import type { ReactNode } from "react";

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const domain = import.meta.env.VITE_AUTH0_DOMAIN as string;
  const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID as string;
  const audience = import.meta.env.VITE_AUTH0_AUDIENCE as string;

  return (
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience,
      }}
    >
      {children}
    </Auth0Provider>
  );
}
