import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector, APP_GUARD } from '@nestjs/core';
// Use production-compiled controllers to verify emitted DTO metadata and guards.
const { ApiController } = require('../dist/controller');
const { AuthGuard } = require('../dist/auth');
const { Database } = require('../dist/db');
const { AttendanceService } = require('../dist/attendance');
const { ApiErrors } = require('../dist/errors');
const userId = '58fdf1ae-f8c0-4824-b92d-64e4a1f392cb';
let currentRole = 'STUDENT';
let identity: any = { id: userId, email: 'alumno@example.com', email_confirmed_at: new Date().toISOString(),
  identities: [{ provider: 'google', identity_data: { sub: 'google-id', name: 'Alumno' } }], user_metadata: { role: 'ADMIN' } };
const database = { query: async () => ({ rows: [{ id: userId, name: 'Alumno', email: 'alumno@example.com', role: currentRole }] }) };
const guard = new AuthGuard({ supabaseUrl: 'https://example.supabase.co', supabaseKey: 'test-key' }, database, new Reflector());
guard.supabase.auth.getUser = async (token: string) => token === 'valid' ? { data: { user: identity }, error: null } : { data: { user: null }, error: new Error('invalid') };
const service = { courses: async () => [], createSession: async (actor: any, body: any) => ({ name: body.name }), start: async () => ({ attemptId: userId }) };
@Module({ controllers: [ApiController], providers: [
  { provide: Database, useValue: database }, { provide: AttendanceService, useValue: service }, { provide: APP_GUARD, useValue: guard },
] })
class TestApp {}
let app: any; let base: string;
before(async () => {
  app = await NestFactory.create(TestApp, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new ApiErrors());
  await app.listen(0, '127.0.0.1'); base = await app.getUrl();
});
after(async () => app?.close());
test('HTTP health is public, protected routes reject absent or forged JWT', async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/courses`)).status, 401);
  assert.equal((await fetch(`${base}/me`, { headers: { Authorization: 'Bearer forged' } })).status, 401);
});
test('HTTP never grants admin from user-controlled metadata', async () => {
  currentRole = 'STUDENT';
  const response = await fetch(`${base}/courses`, { headers: { Authorization: 'Bearer valid' } });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'FORBIDDEN');
});
test('HTTP requires Google identity and verified email', async () => {
  const original = identity;
  identity = { ...original, identities: [] };
  assert.equal((await fetch(`${base}/me`, { headers: { Authorization: 'Bearer valid' } })).status, 403);
  identity = { ...original, email_confirmed_at: null };
  assert.equal((await fetch(`${base}/me`, { headers: { Authorization: 'Bearer valid' } })).status, 403);
  identity = original;
});
test('HTTP admin routes accept DB role and reject malformed DTOs', async () => {
  currentRole = 'ADMIN';
  const headers = { Authorization: 'Bearer valid', 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/courses`, { headers })).status, 200);
  const bad = await fetch(`${base}/attendance-sessions`, { method: 'POST', headers, body: JSON.stringify({ name: 'Clase', courseName: 'N1', durationMinutes: 999, role: 'ADMIN' }) });
  assert.equal(bad.status, 400);
  const good = await fetch(`${base}/attendance-sessions`, { method: 'POST', headers, body: JSON.stringify({ name: 'Clase', courseName: 'N1', durationMinutes: 5 }) });
  assert.equal(good.status, 201);
});
test('HTTP start is public but validates its DTO', async () => {
  const response = await fetch(`${base}/attendance/check-in/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qrToken: 'x' }) });
  assert.equal(response.status, 400);
});
