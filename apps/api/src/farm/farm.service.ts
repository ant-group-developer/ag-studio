import { ForbiddenException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StudioDbService } from '../db/studio-db.service';
import { AgGoClient } from '../ag-go/client';

interface FarmJobRow {
  id: string;
  farm_job_id: string;
  run_id: string;
  stage_key: string;
  attempt_id: string;
  production_id: string;
  job_type: string;
  is_final_render: number;
}

interface ProductionRow {
  id: string;
  team_id: string;
}

interface ProductionOwnerRow {
  user_id: string;
}

interface SignOp {
  op: string;
  input?: string;
  output?: string;
  upload_id?: string;
  parts?: unknown[];
  content_type?: string;
}

interface SignResult {
  op: string;
  input?: string;
  output?: string;
  url?: string;
  expires_at?: string;
  size_bytes?: number | null;
  content_type?: string | null;
  cache_key?: string | null;
  source?: { source_kind: string; watermarked: boolean; start_ms: number; end_ms: number } | null;
  headers?: Record<string, string>;
  upload_id?: string;
  urls?: unknown[];
}

@Injectable()
export class FarmService {
  private readonly logger = new Logger(FarmService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly urlTtlSeconds: number;
  private readonly agGoClient: AgGoClient;

  constructor(
    private readonly db: StudioDbService,
    private readonly config: ConfigService,
  ) {
    this.s3 = new S3Client({
      endpoint: config.get<string>('STUDIO_R2_ENDPOINT'),
      region: 'auto',
      credentials: {
        accessKeyId: config.get<string>('STUDIO_R2_ACCESS_KEY_ID') as string,
        secretAccessKey: config.get<string>('STUDIO_R2_SECRET_ACCESS_KEY') as string,
      },
    });
    this.bucket = config.get<string>('STUDIO_R2_BUCKET') as string;
    this.urlTtlSeconds = config.get<number>('FARM_URL_TTL_SECONDS', 3600);
    this.agGoClient = new AgGoClient({
      baseUrl: config.get<string>('AG_GO_API_URL') as string,
      serviceKey: config.get<string>('AG_GO_SERVICE_KEY') as string,
    });
  }

  /**
   * Process a sign request from a render worker.
   * - Looks up the farm job by job_id from ticket claims
   * - Authorizes all ops before executing any
   * - Executes authorized ops and returns signed URLs
   * - Audits each op
   */
  async handleSignRequest(
    jobId: string,
    ops: SignOp[],
    nodeId: string,
    ip: string | undefined,
  ): Promise<{ results: SignResult[] }> {
    // 1. Look up the farm job record
    const jobRow = this.db.get<FarmJobRow>(
      'SELECT * FROM studio_farm_jobs WHERE farm_job_id = ?',
      [jobId],
    );
    if (!jobRow) {
      throw new ForbiddenException(`Unknown farm job: ${jobId}`);
    }

    const productionId = jobRow.production_id;
    const isFinalRender = jobRow.is_final_render === 1;
    const resolvePurpose = isFinalRender ? 'final' : 'preview';
    const stageKey = jobRow.stage_key;

    // Look up production owner for act-as ag-go calls
    const ownerRow = this.db.get<ProductionOwnerRow>(
      `SELECT tm.user_id FROM team_members tm
       JOIN productions p ON p.team_id = tm.team_id
       WHERE p.id = ? AND tm.role = 'owner'
       LIMIT 1`,
      [productionId],
    );
    const ownerUserId = ownerRow?.user_id;

    // 2. Authorize ALL ops first — if any is forbidden, reject the whole request
    for (const op of ops) {
      this.authorizeOp(op, productionId, stageKey);
    }

    // 3. Execute each op and collect results
    const results: SignResult[] = [];
    for (const op of ops) {
      const result = await this.executeOp(op, productionId, stageKey, resolvePurpose, ownerUserId);
      results.push(result);

      // Audit log
      this.db.run(
        `INSERT INTO sign_audit_log (id, farm_job_id, production_id, op, result_url, actor_node_id, ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          jobId,
          productionId,
          JSON.stringify(op),
          result.url ?? null,
          nodeId,
          ip ?? null,
          new Date().toISOString(),
        ],
      );
    }

    return { results };
  }

  private authorizeOp(op: SignOp, productionId: string, stageKey: string): void {
    if (op.op === 'get') {
      const input = op.input ?? '';
      // Allow: stage:<path>, library:<path>, segment:<uuid>
      if (
        input.startsWith('stage:') ||
        input.startsWith('library:') ||
        /^segment:[0-9a-f-]{36}$/i.test(input)
      ) {
        return; // authorized
      }
      throw new ForbiddenException(`Unauthorized input: ${input}`);
    }

    if (['put', 'mp_create', 'mp_part_urls', 'mp_complete', 'mp_abort'].includes(op.op)) {
      const output = op.output ?? '';
      // Output must be under productions/<productionId>/
      const allowedPrefix = `productions/${productionId}/`;
      if (!output.startsWith(allowedPrefix) && !output.startsWith(`${productionId}/`)) {
        // Check if it's a relative path that resolves under the production prefix
        if (output.includes('..') || output.startsWith('/')) {
          throw new ForbiddenException(`Path traversal not allowed: ${output}`);
        }
        // Accept relative paths — they will be resolved under the production prefix
        return;
      }
      return;
    }

    throw new ForbiddenException(`Unsupported op: ${op.op}`);
  }

  private async executeOp(
    op: SignOp,
    productionId: string,
    stageKey: string,
    resolvePurpose: 'preview' | 'final',
    ownerUserId: string | undefined,
  ): Promise<SignResult> {
    const expiresAt = new Date(Date.now() + this.urlTtlSeconds * 1000).toISOString();

    if (op.op === 'get') {
      const input = op.input ?? '';

      if (input.startsWith('stage:')) {
        const relativePath = input.slice('stage:'.length);
        // NOTE: This service is currently unused (FarmModule only registers FarmController).
        // The key layout must include attempt_id to match FarmExecutor's upload prefix.
        // Without attempt_id from the job row we fall back to stageKey only here —
        // callers should migrate to FarmController which uses getStageInputPrefix properly.
        const key = `productions/${productionId}/jobs/${stageKey}/in/${relativePath}`;
        const url = await getSignedUrl(
          this.s3,
          new GetObjectCommand({ Bucket: this.bucket, Key: key }),
          { expiresIn: this.urlTtlSeconds },
        );
        return { op: 'get', input, url, expires_at: expiresAt, size_bytes: null, content_type: null, cache_key: null, source: null };
      }

      if (input.startsWith('library:')) {
        const relativePath = input.slice('library:'.length);
        const key = `library/${relativePath}`;
        const url = await getSignedUrl(
          this.s3,
          new GetObjectCommand({ Bucket: this.bucket, Key: key }),
          { expiresIn: this.urlTtlSeconds },
        );
        return { op: 'get', input, url, expires_at: expiresAt, size_bytes: null, content_type: null, cache_key: null, source: null };
      }

      if (/^segment:[0-9a-f-]{36}$/i.test(input)) {
        const segmentId = input.slice('segment:'.length);
        if (!ownerUserId) {
          throw new ForbiddenException('No production owner found for segment resolve');
        }
        const resolved = await this.agGoClient.resolveSegments(ownerUserId, {
          segmentIds: [segmentId],
          purpose: resolvePurpose,
        });
        const item = resolved.items[0];
        if (!item) {
          throw new NotFoundException(`Segment not found: ${segmentId}`);
        }
        return {
          op: 'get',
          input,
          url: item.url,
          expires_at: item.expiresAt,
          size_bytes: item.sizeBytes,
          content_type: item.contentType,
          cache_key: item.cacheKey,
          source: {
            source_kind: item.sourceKind,
            watermarked: item.watermarked,
            start_ms: item.startMs,
            end_ms: item.endMs,
          },
        };
      }
    }

    if (op.op === 'put') {
      const output = op.output ?? '';
      const key = this.resolveOutputKey(productionId, output);
      const url = await getSignedUrl(
        this.s3,
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: op.content_type ?? 'application/octet-stream',
        }),
        { expiresIn: this.urlTtlSeconds },
      );
      return { op: 'put', output, url, expires_at: expiresAt, headers: { 'Content-Type': op.content_type ?? 'application/octet-stream' } };
    }

    if (op.op === 'mp_create') {
      const output = op.output ?? '';
      const key = this.resolveOutputKey(productionId, output);
      const cmd = new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: op.content_type ?? 'application/octet-stream',
      });
      const res = await this.s3.send(cmd);
      return { op: 'mp_create', output, upload_id: res.UploadId ?? '' };
    }

    if (op.op === 'mp_part_urls') {
      const output = op.output ?? '';
      const key = this.resolveOutputKey(productionId, output);
      const parts = Array.isArray(op.parts) ? (op.parts as number[]) : [];
      const urls = await Promise.all(
        parts.map(async (partNumber) => {
          const url = await getSignedUrl(
            this.s3,
            new UploadPartCommand({
              Bucket: this.bucket,
              Key: key,
              UploadId: op.upload_id,
              PartNumber: partNumber,
            }),
            { expiresIn: this.urlTtlSeconds },
          );
          return { part_number: partNumber, url };
        }),
      );
      return { op: 'mp_part_urls', output, upload_id: op.upload_id ?? '', expires_at: expiresAt, urls };
    }

    if (op.op === 'mp_complete') {
      const output = op.output ?? '';
      const key = this.resolveOutputKey(productionId, output);
      const parts = Array.isArray(op.parts)
        ? (op.parts as Array<{ part_number: number; etag: string }>)
        : [];
      await this.s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: op.upload_id,
          MultipartUpload: {
            Parts: parts.map((p) => ({ PartNumber: p.part_number, ETag: p.etag })),
          },
        }),
      );
      return { op: 'mp_complete', output };
    }

    if (op.op === 'mp_abort') {
      const output = op.output ?? '';
      const key = this.resolveOutputKey(productionId, output);
      await this.s3.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: op.upload_id,
        }),
      );
      return { op: 'mp_abort', output };
    }

    throw new ForbiddenException(`Unsupported op: ${op.op}`);
  }

  private resolveOutputKey(productionId: string, relativePath: string): string {
    if (relativePath.includes('..') || relativePath.startsWith('/')) {
      throw new ForbiddenException(`Invalid output path: ${relativePath}`);
    }
    const prefix = `productions/${productionId}/`;
    return relativePath.startsWith(prefix) ? relativePath : `${prefix}${relativePath}`;
  }
}
