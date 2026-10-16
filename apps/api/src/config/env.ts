import { z } from 'zod';

export const envSchema = z.object({
  /** Studio's Postgres database: postgresql://user:password@host:5432/ag_studio (the worker uses the same). */
  DATABASE_URL: z.string().min(1),
  /** Most connections the API's pool opens (default 10). */
  STUDIO_DB_POOL_MAX: z.coerce.number().int().positive().optional(),
  /** Postgres schema of Studio's tables (default public; created at start when missing). The worker uses the same. */
  DATABASE_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, 'lower case letters, digits and _').optional(),
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
  /** Workspaces and artifacts of the Studio engine (voice store, scratch folders, workspaces by default). */
  STUDIO_DATA_ROOT: z.string().default('./data/harness'),
  /** Project workspaces (the agent works in <root>/<project id>); default <STUDIO_DATA_ROOT>/workspaces. The worker must see the same folder. */
  STUDIO_WORKSPACES_ROOT: z.string().optional(),
  /** Signs the token a running agent turn's MCP server calls /api/agent-tools with (the worker needs the same value). */
  STUDIO_AGENT_TOKEN_SECRET: z.string().min(16).optional(),
  /** Only whether it is set: the Research tab says if crawls use the YouTube Data API (quota) or yt-dlp. The worker crawls. */
  YOUTUBE_API_KEY: z.string().optional(),
  /** ffmpeg for audio people give (project voice and music, the music library); unset = no audio uploads. */
  STUDIO_FFMPEG_PATH: z.string().optional(),
  /** ffprobe (default: the one next to STUDIO_FFMPEG_PATH, as on the worker). */
  STUDIO_FFPROBE_PATH: z.string().optional(),
  /** Let audio links reach private addresses (the local stack, where ag-go is on localhost). Never on a deployed box. */
  STUDIO_AUDIO_ALLOW_PRIVATE_URLS: z.enum(['true', 'false', '1', '0']).optional().transform((v) => v === 'true' || v === '1'),
  /** Lifetime of signed URLs handed to the browser (previews, exports, narration audio). */
  STUDIO_BROWSER_URL_TTL_SECONDS: z.coerce.number().default(3600),
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
