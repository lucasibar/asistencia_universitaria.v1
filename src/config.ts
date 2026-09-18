import 'dotenv/config';

export interface Config {
  port: number; databaseUrl: string; databaseSsl: boolean; databaseCa?: string;
  supabaseUrl: string; supabaseKey: string; frontendUrl: string; origins: string[];
  qrSecret: string; rotationSeconds: number; attemptSeconds: number; proxyHops: number;
}
export const CONFIG = Symbol('CONFIG');
export function readConfig(env = process.env): Config {
  const required = (key: string) => { const v = env[key]; if (!v) throw new Error(`Missing ${key}`); return v; };
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
    return n;
  };
  const url = (key: string) => {
    const value = required(key); const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Invalid ${key}`);
    return parsed.origin;
  };
  const qrSecret = required('QR_SIGNING_SECRET');
  if (qrSecret.length < 32 || qrSecret.startsWith('replace-')) throw new Error('Set a random QR_SIGNING_SECRET of at least 32 characters');
  const origins = required('CORS_ORIGINS').split(',').map(v => new URL(v.trim()).origin);
  return {
    port: integer('PORT', 3000, 1, 65535), databaseUrl: required('DATABASE_URL'),
    databaseSsl: env.DATABASE_SSL !== 'false', databaseCa: env.DATABASE_CA?.replace(/\\n/g, '\n'),
    supabaseUrl: url('SUPABASE_URL'), supabaseKey: required('SUPABASE_PUBLISHABLE_KEY'),
    frontendUrl: url('FRONTEND_URL'), origins, qrSecret,
    rotationSeconds: integer('QR_ROTATION_SECONDS', 10, 5, 60),
    attemptSeconds: integer('ATTEMPT_TTL_SECONDS', 60, 30, 180),
    proxyHops: integer('TRUST_PROXY_HOPS', 0, 0, 5),
  };
}
