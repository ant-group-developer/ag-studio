import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as crypto from 'node:crypto';

// --------------------------------------------------------------------------
// Inlined from @ag-farm/protocol (ticket.ts) to avoid ESM/CJS issues
// --------------------------------------------------------------------------
const TICKET_ISSUER = 'ag-farm';
const TICKET_TYP = 'farm-ticket+jwt';

interface TicketClaims {
  iss: string;
  sub: string;
  jti: string;
  job_id: string;
  owner: string;
  type: string;
  attempt: number;
  iat: number;
  exp: number;
}

class TicketError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'TicketError';
  }
}

function toPublicKey(key: string | crypto.KeyObject): crypto.KeyObject {
  return typeof key === 'string' ? crypto.createPublicKey(key) : key;
}

function extractTicketFromHeader(authorization: string | undefined | null): string | null {
  if (!authorization) return null;
  const parts = authorization.trim().split(/\s+/, 2);
  const scheme = parts[0];
  const token = parts[1];
  return scheme?.toLowerCase() === 'ticket' && token ? token : null;
}

function verifyTicket(
  token: string,
  publicKey: string | crypto.KeyObject,
  options: { owner: string; now?: number; clockToleranceSeconds?: number },
): TicketClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new TicketError('malformed', 'Ticket is not a JWT');
  }
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];

  let header: { alg?: unknown; typ?: unknown };
  let rawClaims: unknown;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as {
      alg?: unknown;
      typ?: unknown;
    };
    rawClaims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8'));
  } catch {
    throw new TicketError('malformed', 'Ticket is not valid base64url JSON');
  }

  if (header.alg !== 'EdDSA' || header.typ !== TICKET_TYP) {
    throw new TicketError('bad_header', 'Unsupported ticket header');
  }

  const signature = Buffer.from(encodedSignature, 'base64url');
  const ok = crypto.verify(
    null,
    Buffer.from(`${encodedHeader}.${encodedClaims}`),
    toPublicKey(publicKey),
    signature,
  );
  if (!ok) {
    throw new TicketError('bad_signature', 'Ticket signature mismatch');
  }

  const claims = rawClaims as TicketClaims;
  if (
    claims.iss !== TICKET_ISSUER ||
    typeof claims.sub !== 'string' ||
    typeof claims.job_id !== 'string' ||
    typeof claims.owner !== 'string' ||
    typeof claims.exp !== 'number'
  ) {
    throw new TicketError('bad_claims', 'Ticket claims are invalid');
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.clockToleranceSeconds ?? 30;
  if (claims.exp + tolerance <= now) {
    throw new TicketError('expired', 'Ticket is expired');
  }
  if (claims.owner !== options.owner) {
    throw new TicketError('wrong_owner', 'Ticket belongs to another owner');
  }
  return claims;
}
// --------------------------------------------------------------------------

export type { TicketClaims };

declare module 'express' {
  interface Request {
    ticketClaims?: TicketClaims;
  }
}

@Injectable()
export class TicketGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.headers.authorization;
    const token = extractTicketFromHeader(authorization);
    if (!token) {
      throw new UnauthorizedException('Missing Ticket authorization');
    }

    // Support keys passed with escaped newlines (\\n → \n) as is common in env files.
    const publicKeyRaw = this.config.get<string>('FARM_TICKET_PUBLIC_KEY') as string;
    const publicKey = publicKeyRaw.replace(/\\n/g, '\n');
    try {
      const claims = verifyTicket(token, publicKey, { owner: 'studio' });
      request.ticketClaims = claims;
      return true;
    } catch (err) {
      if (err instanceof TicketError) {
        throw new UnauthorizedException(`Ticket verification failed: ${err.message}`);
      }
      throw new UnauthorizedException('Ticket verification error');
    }
  }
}
