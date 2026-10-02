import { z } from 'zod';

export const envSchema = z.object({
  STUDIO_DB_PATH: z.string().default('./data/studio.db'),
  AUTH0_ISSUER_URL: z.string().url(),
  AUTH0_AUDIENCE: z.string(),
  AUTH0_JWKS_URI: z.string().url(),
  AUTH0_ALLOWED_CLIENT_IDS: z.string().optional(),
  ACCOUNT_API_URL: z.string().url(),
  ACCOUNT_API_KEY: z.string().optional(),
  /** Account API application whose ADMINs and permissions Studio uses (Studio users are ag-go users). */
  ACCOUNT_APPLICATION_CODE: z.string().optional(),
  AG_GO_API_URL: z.string().url(),
  AG_GO_SERVICE_KEY: z.string(),
  FARM_URL: z.string().url(),
  FARM_OWNER_KEY: z.string(),
  FARM_TICKET_PUBLIC_KEY: z.string(),
  STUDIO_R2_ENDPOINT: z.string().url(),
  STUDIO_R2_BUCKET: z.string(),
  STUDIO_R2_ACCESS_KEY_ID: z.string(),
  STUDIO_R2_SECRET_ACCESS_KEY: z.string(),
  FARM_URL_TTL_SECONDS: z.coerce.number().default(3600),
  /** Workspaces and artifacts of the Studio engine (the harness state itself lives in STUDIO_DB_PATH). */
  STUDIO_DATA_ROOT: z.string().default('./data/harness'),
  /** ffmpeg used to measure loudness when a gate or the worker verifies a render; unset = not measured. */
  STUDIO_FFMPEG_PATH: z.string().optional(),
  /** Lifetime of signed URLs handed to the browser (previews, exports, narration audio). */
  STUDIO_BROWSER_URL_TTL_SECONDS: z.coerce.number().default(3600),
  /** Canva Connect (public integration); Canva is off unless all four are set. */
  CANVA_CLIENT_ID: z.string().optional(),
  CANVA_CLIENT_SECRET: z.string().optional(),
  /** `https://<studio>/api/canva/oauth/callback`, as registered in the Canva Developer Portal. */
  CANVA_REDIRECT_URI: z.string().url().optional(),
  /** 32 bytes (64 hex characters or base64) encrypting the Canva tokens at rest. */
  CANVA_TOKEN_KEY: z.string().optional(),
  /** Origin of the web app the Canva callback sends the browser back to; empty = the API's own origin. */
  STUDIO_WEB_URL: z.string().url().optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): AppEnv {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Environment validation failed: ${errors}`);
  }
  return result.data;
}
