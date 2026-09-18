import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CONFIG, Config } from './config';
import { fail } from './errors';

interface QrPayload { v: 1; sessionId: string; nbf: number; exp: number; }
@Injectable()
export class QrTokens {
  constructor(@Inject(CONFIG) private readonly config: Config) {}
  issue(sessionId: string, startedAt: Date, expiresAt: Date, now: Date) {
    const width = this.config.rotationSeconds * 1000;
    const nbf = startedAt.getTime() + Math.floor((now.getTime() - startedAt.getTime()) / width) * width;
    const exp = Math.min(nbf + width, expiresAt.getTime());
    const payload: QrPayload = { v: 1, sessionId, nbf, exp };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = `${encoded}.${this.sign(encoded)}`;
    return { qrToken: token, qrUrl: `${this.config.frontendUrl}/a/${token}`, validFrom: new Date(nbf), expiresAt: new Date(exp), serverTime: now, rotationSeconds: this.config.rotationSeconds };
  }
  verify(token: string): QrPayload {
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token) || token.length > 2048) fail('INVALID_QR', 404);
    const [encoded, signature] = token.split('.');
    const expected = Buffer.from(this.sign(encoded));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) fail('INVALID_QR', 404);
    try {
      const data = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as QrPayload;
      if (data.v !== 1 || !/^[a-f0-9-]{36}$/i.test(data.sessionId) || !Number.isSafeInteger(data.nbf) || !Number.isSafeInteger(data.exp) || data.exp <= data.nbf) fail('INVALID_QR', 404);
      return data;
    } catch { fail('INVALID_QR', 404); }
  }
  private sign(encoded: string) { return createHmac('sha256', this.config.qrSecret).update(`attendance-qr:v1:${encoded}`).digest('base64url'); }
}
