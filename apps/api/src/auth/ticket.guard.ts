import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { TicketError, extractTicket, verifyTicket, type TicketClaims } from '@ag-farm/protocol';

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
    const token = extractTicket(authorization);
    if (!token) {
      throw new UnauthorizedException('Missing Ticket authorization');
    }

    // Support keys passed with escaped newlines (\\n → \n) as is common in env files.
    const publicKeyRaw = this.config.get<string>('FARM_TICKET_PUBLIC_KEY') as string;
    const publicKey = publicKeyRaw.replace(/\\n/g, '\n');
    try {
      // the protocol's own check (zod schema of the claims: iss, sub and job_id as uuids, a known job type, attempt)
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
