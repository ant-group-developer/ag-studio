/** The API's CORS: any origin as before, and a preflight the browser keeps 2 hours. */
import { afterEach, describe, expect, it } from 'vitest';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CORS_OPTIONS } from './cors';

@Controller('ping')
class PingController {
  @Get()
  ping() {
    return { ok: true };
  }
}

describe('CORS', () => {
  let app: INestApplication;
  afterEach(async () => { await app.close(); });

  it('answers a preflight from any origin, to be kept 2 hours', async () => {
    const mod = await Test.createTestingModule({ controllers: [PingController] }).compile();
    app = mod.createNestApplication({ logger: false });
    app.enableCors(CORS_OPTIONS);
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    const pre = await fetch(`${base}/ping`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://studio.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-max-age')).toBe('7200');
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-headers')).toContain('authorization');
    const get = await fetch(`${base}/ping`, { headers: { Origin: 'https://studio.example' } });
    expect(get.headers.get('access-control-allow-origin')).toBe('*');
  });
});
