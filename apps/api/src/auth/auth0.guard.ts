import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as crypto from 'node:crypto';
import { IS_PUBLIC_KEY } from './public.decorator';

interface JwksKey {
  kty: string;
  use?: string;
  kid: string;
  n?: string;
  e?: string;
  x5c?: string[];
}

interface JwksResponse {
  keys: JwksKey[];
}

interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

interface JwtClaims {
  sub: string;
  iss: string;
  aud: string | string[];
  azp?: string;
  exp: number;
  iat: number;
  [key: string]: unknown;
}

export interface AuthContext {
  userId: string;
  accessToken: string;
}

declare module 'express' {
  interface Request {
    authContext?: AuthContext;
  }
}

@Injectable()
export class Auth0Guard implements CanActivate {
  private jwksCache: Map<string, { key: crypto.KeyObject; cachedAt: number }> = new Map();
  private readonly jwksCacheTtlMs = 5 * 60 * 1000; // 5 min

  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.headers.authorization;
    if (!authorization) {
      throw new UnauthorizedException('Authorization header is missing');
    }

    const [scheme, token] = authorization.split(' ', 2);
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Invalid authorization format');
    }

    const claims = await this.verifyToken(token);
    request.authContext = { userId: claims.sub, accessToken: token };
    return true;
  }

  private async verifyToken(token: string): Promise<JwtClaims> {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new UnauthorizedException('Invalid JWT format');
    }

    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    let header: JwtHeader;
    let claims: JwtClaims;
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as JwtHeader;
      claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as JwtClaims;
    } catch {
      throw new UnauthorizedException('Malformed JWT');
    }

    if (header.alg !== 'RS256') {
      throw new UnauthorizedException('Unsupported JWT algorithm');
    }

    const issuer = this.config.get<string>('AUTH0_ISSUER_URL');
    const audience = this.config.get<string>('AUTH0_AUDIENCE');
    const allowedClientIds = this.config.get<string>('AUTH0_ALLOWED_CLIENT_IDS', '');

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp && claims.exp < now) {
      throw new UnauthorizedException('Token expired');
    }

    // Check issuer
    if (claims.iss !== issuer) {
      throw new UnauthorizedException('Invalid token issuer');
    }

    // Check audience
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience as string)) {
      throw new UnauthorizedException('Invalid token audience');
    }

    // Check azp if CLIENT_IDS configured
    if (allowedClientIds && allowedClientIds.trim()) {
      const allowed = allowedClientIds.split(',').map((id) => id.trim()).filter(Boolean);
      if (allowed.length > 0 && !allowed.includes(claims.azp ?? '')) {
        throw new UnauthorizedException('Token client ID not allowed');
      }
    }

    // Verify signature
    const kid = header.kid;
    if (!kid) {
      throw new UnauthorizedException('JWT missing kid');
    }

    const publicKey = await this.getPublicKey(kid);
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = Buffer.from(signatureB64, 'base64url');

    const isValid = crypto.verify(
      'sha256',
      Buffer.from(signingInput),
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      signature,
    );

    if (!isValid) {
      throw new UnauthorizedException('Invalid JWT signature');
    }

    return claims;
  }

  private async getPublicKey(kid: string): Promise<crypto.KeyObject> {
    const cached = this.jwksCache.get(kid);
    if (cached && Date.now() - cached.cachedAt < this.jwksCacheTtlMs) {
      return cached.key;
    }

    const jwksUri = this.config.get<string>('AUTH0_JWKS_URI') as string;
    const response = await fetch(jwksUri);
    if (!response.ok) {
      throw new UnauthorizedException('Failed to fetch JWKS');
    }

    const jwks = (await response.json()) as JwksResponse;
    const jwk = jwks.keys.find((k) => k.kid === kid);
    if (!jwk) {
      throw new UnauthorizedException(`No JWKS key found for kid: ${kid}`);
    }

    const keyObject = crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: 'jwk' });
    this.jwksCache.set(kid, { key: keyObject, cachedAt: Date.now() });
    return keyObject;
  }
}
