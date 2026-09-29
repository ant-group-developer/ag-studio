import {
  Controller,
  Post,
  Body,
  Req,
  UseGuards,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
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
import { Public } from '../auth/public.decorator';
import { TicketGuard } from '../auth/ticket.guard';
import type { TicketClaims } from '../auth/ticket.guard';
import { StudioDbService } from '../db/studio-db.service';
import { AgGoClient } from '../ag-go/client';
import {
  SignRequestSchema,
  SignOp,
  SignResult,
  resolveOutputKey,
  getStageInputPrefix,
} from './sign-schemas';

interface FarmJobRow {
  id: string;
  farm_job_id: string;
  run_id: string;
  stage_key: string;
  attempt_id: string;
  production_id: string;
  job_type: string;
  is_final_render: number;
  created_at: string;
}

declare module 'express' {
  interface Request {
    ticketClaims?: TicketClaims;
  }
}

@Controller('farm')
export class FarmController {
  private readonly s3: S3Client;
  private readonly agGoClient: AgGoClient;
  private readonly bucket: string;
  private readonly urlTtl: number;

  constructor(
    private readonly db: StudioDbService,
    private readonly config: ConfigService,
  ) {
    this.bucket = this.config.get<string>('STUDIO_R2_BUCKET') as string;
    this.urlTtl = this.config.get<number>('FARM_URL_TTL_SECONDS') ?? 3600;

    this.s3 = new S3Client({
      endpoint: this.config.get<string>('STUDIO_R2_ENDPOINT') as string,
      region: 'auto',
      credentials: {
        accessKeyId: this.config.get<string>('STUDIO_R2_ACCESS_KEY_ID') as string,
        secretAccessKey: this.config.get<string>('STUDIO_R2_SECRET_ACCESS_KEY') as string,
      },
    });

    this.agGoClient = new AgGoClient({
      baseUrl: this.config.get<string>('AG_GO_API_URL') as string,
      serviceKey: this.config.get<string>('AG_GO_SERVICE_KEY') as string,
    });
  }

  @Post('sign')
  @Public()
  @UseGuards(TicketGuard)
  async sign(@Body() body: unknown, @Req() req: Request) {
    const ticketClaims = req.ticketClaims!;

    // 1. Parse request body with SignRequestSchema
    const parsed = SignRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(`Invalid sign request: ${parsed.error.message}`);
    }
    const { ops } = parsed.data;

    // 2. Look up farm job
    const job = this.db.get<FarmJobRow>(
      'SELECT * FROM studio_farm_jobs WHERE farm_job_id = ?',
      [ticketClaims.job_id],
    );
    if (!job) {
      throw new ForbiddenException(`Unknown farm job: ${ticketClaims.job_id}`);
    }

    const prodId = job.production_id;
    const isFinalRender = job.is_final_render === 1;

    // 3. Authorize ALL ops first (fail fast on any unauthorized op)
    const authorizations: Array<{
      op: SignOp;
      r2Key?: string;
      segmentId?: string;
    }> = [];

    for (const op of ops) {
      if (op.op === 'get') {
        const input = op.input;
        if (input.startsWith('stage:')) {
          const subPath = input.slice('stage:'.length);
          const inputPrefix = getStageInputPrefix(prodId, job.stage_key, job.attempt_id);
          const r2Key = `${inputPrefix}${subPath}`;
          authorizations.push({ op, r2Key });
        } else if (input.startsWith('library:')) {
          const subPath = input.slice('library:'.length);
          const r2Key = `library/${subPath}`;
          authorizations.push({ op, r2Key });
        } else if (input.startsWith('segment:')) {
          const segmentId = input.slice('segment:'.length);
          authorizations.push({ op, segmentId });
        } else {
          throw new ForbiddenException(`Unauthorized input: ${input}`);
        }
      } else if (
        op.op === 'put' ||
        op.op === 'mp_create' ||
        op.op === 'mp_part_urls' ||
        op.op === 'mp_complete' ||
        op.op === 'mp_abort'
      ) {
        // Output prefix: productions/<prodId>/ (trailing slash stripped by resolveOutputKey)
        const outputPrefix = `productions/${prodId}`;
        const r2Key = resolveOutputKey(outputPrefix, op.output);
        authorizations.push({ op, r2Key });
      } else {
        throw new ForbiddenException('Unknown op type');
      }
    }

    // 4. Execute all authorized ops
    const results: SignResult[] = [];
    const now = new Date().toISOString();

    for (const auth of authorizations) {
      const op = auth.op;
      let result: SignResult;
      let resultUrl: string | null = null;

      if (op.op === 'get' && auth.segmentId) {
        // Segment resolve via ag-go
        const purpose = isFinalRender ? 'final' : 'preview';
        const resolveResp = await this.agGoClient.resolveSegments(prodId, {
          segmentIds: [auth.segmentId],
          purpose,
        });
        const item = resolveResp.items[0];
        if (!item) {
          throw new ForbiddenException(`Segment not found: ${auth.segmentId}`);
        }
        resultUrl = item.url;
        result = {
          op: 'get',
          input: op.input,
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
      } else if (op.op === 'get' && auth.r2Key) {
        const expiresAt = new Date(Date.now() + this.urlTtl * 1000).toISOString();
        const getUrl = await getSignedUrl(
          this.s3,
          new GetObjectCommand({ Bucket: this.bucket, Key: auth.r2Key }),
          { expiresIn: this.urlTtl },
        );
        resultUrl = getUrl;
        result = {
          op: 'get',
          input: op.input,
          url: getUrl,
          expires_at: expiresAt,
          size_bytes: null,
          content_type: null,
          cache_key: null,
          source: null,
        };
      } else if (op.op === 'put' && auth.r2Key) {
        const expiresAt = new Date(Date.now() + this.urlTtl * 1000).toISOString();
        const url = await getSignedUrl(
          this.s3,
          new PutObjectCommand({ Bucket: this.bucket, Key: auth.r2Key }),
          { expiresIn: this.urlTtl },
        );
        resultUrl = url;
        result = {
          op: 'put',
          output: op.output,
          url,
          expires_at: expiresAt,
          headers: { 'Content-Type': op.content_type },
        };
      } else if (op.op === 'mp_create' && auth.r2Key) {
        const createResp = await this.s3.send(
          new CreateMultipartUploadCommand({
            Bucket: this.bucket,
            Key: auth.r2Key,
            ContentType: op.content_type,
          }),
        );
        result = {
          op: 'mp_create',
          output: op.output,
          upload_id: createResp.UploadId ?? '',
        };
      } else if (op.op === 'mp_part_urls' && auth.r2Key) {
        const expiresAt = new Date(Date.now() + this.urlTtl * 1000).toISOString();
        const urls: Array<{ part_number: number; url: string }> = [];
        for (const partNumber of op.parts) {
          const url = await getSignedUrl(
            this.s3,
            new UploadPartCommand({
              Bucket: this.bucket,
              Key: auth.r2Key,
              UploadId: op.upload_id,
              PartNumber: partNumber,
            }),
            { expiresIn: this.urlTtl },
          );
          urls.push({ part_number: partNumber, url });
        }
        result = {
          op: 'mp_part_urls',
          output: op.output,
          upload_id: op.upload_id,
          expires_at: expiresAt,
          urls,
        };
      } else if (op.op === 'mp_complete' && auth.r2Key) {
        await this.s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: this.bucket,
            Key: auth.r2Key,
            UploadId: op.upload_id,
            MultipartUpload: {
              Parts: op.parts.map((p) => ({
                PartNumber: p.part_number,
                ETag: p.etag,
              })),
            },
          }),
        );
        result = { op: 'mp_complete', output: op.output };
      } else if (op.op === 'mp_abort' && auth.r2Key) {
        await this.s3.send(
          new AbortMultipartUploadCommand({
            Bucket: this.bucket,
            Key: auth.r2Key,
            UploadId: op.upload_id,
          }),
        );
        result = { op: 'mp_abort', output: op.output };
      } else {
        throw new ForbiddenException('Op execution error');
      }

      results.push(result);

      // 5. Audit log
      this.db.run(
        'INSERT INTO sign_audit_log (id, farm_job_id, production_id, op, result_url, actor_node_id, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          crypto.randomUUID(),
          job.farm_job_id,
          prodId,
          JSON.stringify(op),
          resultUrl,
          ticketClaims.sub,
          (req.ip as string | null) ?? null,
          now,
        ],
      );
    }

    return { results };
  }
}
