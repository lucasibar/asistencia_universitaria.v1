import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { HttpException, ValidationPipe } from '@nestjs/common';
import { AttendanceService } from '../src/attendance';
import { QrTokens } from '../src/qr';
import { Database } from '../src/db';
import { Config } from '../src/config';
import { Actor, AuthGuard } from '../src/auth';
import { Reflector } from '@nestjs/core';
import { SessionDto, ConfirmDto } from '../src/dto';

const config = { qrSecret: 'a'.repeat(64), rotationSeconds: 10, attemptSeconds: 60, frontendUrl: 'https://front.example' } as Config;
const pg = new PGlite();
const adapter = (client: any) => ({ query: async (text: string, values: unknown[] = []) => {
  const result = await client.query(text, values); return { rows: result.rows, rowCount: result.affectedRows || result.rows.length };
} });
const db = { ...adapter(pg), transaction: (fn: any) => pg.transaction(tx => fn(adapter(tx))) } as unknown as Database;
const qr = new QrTokens(config);
const service = new AttendanceService(db, qr, config);
const admin: Actor = { id: randomUUID(), role: 'ADMIN', name: 'Profesor', email: 'prof@example.com' };
const student: Actor = { id: randomUUID(), role: 'STUDENT', name: 'Alumno', email: 'alumno@example.com' };
const other: Actor = { id: randomUUID(), role: 'STUDENT', name: 'Otro', email: 'otro@example.com' };
const stranger: Actor = { id: randomUUID(), role: 'ADMIN', name: 'Otro profesor', email: 'prof2@example.com' };

before(async () => {
  await pg.exec(readFileSync('migrations/001_initial.sql', 'utf8'));
  await pg.exec(readFileSync('migrations/002_academic_name.sql', 'utf8'));
  for (const user of [admin, student, other, stranger]) await db.query('INSERT INTO attendance_app.profiles(id,google_subject,email,name,role) VALUES($1::uuid,$1::text,$2,$3,$4)', [user.id, user.email, user.name, user.role]);
  for (const user of [admin, student, other, stranger]) await service.saveAcademicProfile(user, user.name, 'Apellido');
});
after(async () => pg.close());
async function session() { return service.createSession(admin, { courseName: 'Coaching N1', name: 'Clase 1', durationMinutes: 5 }); }
async function attempt(id: string) { return service.start((await service.currentQr(admin, id)).qrToken); }
const code = (expected: string) => (error: unknown) => error instanceof HttpException && (error.getResponse() as any).code === expected;

test('new course + class + session are created atomically with server duration', async () => {
  const row = await session(); assert.equal(row.expires_at - row.started_at, 300000);
  assert.equal((await service.classes(admin, row.course_id)).length, 1);
  await assert.rejects(service.createSession(admin, { courseId: row.course_id, courseName: 'Invalid', name: 'x', durationMinutes: 5 }), code('PROVIDE_COURSE_ID_OR_NAME'));
});
test('QR rotates deterministically every ten seconds and tampering fails', () => {
  const id = randomUUID(); const start = new Date('2026-09-18T00:00:00Z');
  const end = new Date(+start + 300000);
  const first = qr.issue(id, start, end, new Date(+start + 1000));
  assert.equal(first.qrToken, qr.issue(id, start, end, new Date(+start + 9000)).qrToken);
  assert.notEqual(first.qrToken, qr.issue(id, start, end, new Date(+start + 10000)).qrToken);
  assert.equal(qr.verify(first.qrToken).sessionId, id);
  assert.throws(() => qr.verify(first.qrToken.slice(1)), code('INVALID_QR'));
});
test('present, repeat confirmation and second scan do not duplicate', async () => {
  const s = await session(); const a = await attempt(s.id);
  assert.equal((await service.confirm(student, a.attemptId, a.attemptSecret)).status, 'PRESENT');
  assert.equal((await service.confirm(student, a.attemptId, a.attemptSecret)).status, 'ALREADY_PRESENT');
  const b = await attempt(s.id);
  assert.equal((await service.confirm(student, b.attemptId, b.attemptSecret)).status, 'ALREADY_PRESENT');
  assert.equal((await service.attendees(admin, s.id)).length, 1);
});
test('concurrent confirmation requests return one attendance', async () => {
  const s = await session(); const a = await attempt(s.id); const b = await attempt(s.id);
  const results = await Promise.all([service.confirm(student, a.attemptId, a.attemptSecret), service.confirm(student, b.attemptId, b.attemptSecret)]);
  assert.deepEqual(results.map(x => x.status).sort(), ['ALREADY_PRESENT','PRESENT']);
  assert.equal((await service.attendees(admin, s.id)).length, 1);
});
test('DB unique constraint prevents duplicate inserts independently of service checks', async () => {
  const s = await session(); await service.manual(admin, s.id, student.id);
  await assert.rejects(db.query("INSERT INTO attendance_app.attendance(session_id,user_id,source,created_by) VALUES($1,$2,'QR',$2)", [s.id, student.id]), (e: any) => e.code === '23505');
});
test('expired QR and invalid signature are rejected', async () => {
  const s = await session(); const old = new Date(Date.now() - 120000);
  const token = qr.issue(s.id, old, new Date(+old + 300000), old).qrToken;
  await assert.rejects(service.start(token), code('QR_EXPIRED'));
  await assert.rejects(service.start('invalid'), code('INVALID_QR'));
});
test('closing blocks new attempts but accepts existing live attempt', async () => {
  const s = await session(); const token = (await service.currentQr(admin, s.id)).qrToken; const a = await service.start(token);
  await service.close(admin, s.id);
  await assert.rejects(service.start(token), code('SESSION_CLOSED'));
  assert.equal((await service.confirm(student, a.attemptId, a.attemptSecret)).status, 'PRESENT');
});
test('automatic session expiry blocks starts but allows live attempts', async () => {
  const s = await session(); const a = await attempt(s.id); const token = (await service.currentQr(admin, s.id)).qrToken;
  await db.query("UPDATE attendance_app.attendance_sessions SET started_at=clock_timestamp()-interval '6 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [s.id]);
  await assert.rejects(service.start(token), code('SESSION_CLOSED'));
  assert.equal((await service.session(admin, s.id)).effective_status, 'EXPIRED');
  assert.equal((await service.confirm(student, a.attemptId, a.attemptSecret)).status, 'PRESENT');
});
test('expired attempt is rejected without attendance', async () => {
  const s = await session(); const a = await attempt(s.id);
  await db.query("UPDATE attendance_app.check_in_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [a.attemptId]);
  await assert.rejects(service.confirm(student, a.attemptId, a.attemptSecret), code('ATTEMPT_EXPIRED'));
  assert.equal((await service.attendees(admin, s.id)).length, 0);
});
test('attempt secret and original user are enforced', async () => {
  const s = await session(); const a = await attempt(s.id);
  await assert.rejects(service.confirm(student, a.attemptId, 'wrong'), code('INVALID_ATTEMPT'));
  await service.confirm(student, a.attemptId, a.attemptSecret);
  await assert.rejects(service.confirm(other, a.attemptId, a.attemptSecret), code('ATTEMPT_USED'));
});
test('another professor cannot read, close, add to or archive this course', async () => {
  const s = await session();
  await assert.rejects(service.session(stranger, s.id), code('SESSION_NOT_FOUND'));
  await assert.rejects(service.close(stranger, s.id), code('SESSION_NOT_FOUND'));
  await assert.rejects(service.manual(stranger, s.id, student.id), code('SESSION_NOT_FOUND'));
  await assert.rejects(service.archive(stranger, s.course_id, 'course', true), code('COURSE_NOT_FOUND'));
});
test('manual attendance and void preserve audit and cannot be reinstated by scanning', async () => {
  const s = await session(); const a = await attempt(s.id);
  const result = await service.manual(admin, s.id, student.id); assert.equal(result.attendance.source, 'MANUAL');
  const voided = await service.voidAttendance(admin, result.attendance.id, 'Corrección');
  assert.equal(voided.voided_by, admin.id); assert.equal(voided.reason, 'Corrección');
  await assert.rejects(service.confirm(student, a.attemptId, a.attemptSecret), code('ATTENDANCE_VOIDED'));
  assert.equal((await service.session(admin, s.id)).present_count, 0);
  assert.equal((await service.attendees(admin, s.id)).length, 1);
});
test('archive requires confirmation for history, keeps records and cancels attempts', async () => {
  const s = await session(); const a = await attempt(s.id); await service.manual(admin, s.id, other.id);
  await assert.rejects(service.archive(admin, s.class_id, 'class', false), code('ARCHIVE_CONFIRMATION_REQUIRED'));
  await service.archive(admin, s.class_id, 'class', true);
  await assert.rejects(service.confirm(student, a.attemptId, a.attemptSecret), code('SESSION_CANCELLED'));
  assert.equal((await service.attendees(admin, s.id)).length, 1);
});
test('course archive blocks new sessions and keeps accessible history', async () => {
  const s = await session(); await service.archive(admin, s.course_id, 'course', false);
  await assert.rejects(service.createSession(admin, { courseId: s.course_id, name: 'Clase 2', durationMinutes: 5 }), code('COURSE_ARCHIVED'));
  assert.equal((await service.classes(admin, s.course_id)).length, 1);
  assert.equal((await service.courses(admin)).some(c => c.id === s.course_id), false);
  assert.equal((await service.courses(admin, 0, true)).some(c => c.id === s.course_id), true);
});
test('HTTP DTO validation rejects arbitrary identity and invalid durations', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  await assert.rejects(pipe.transform({ courseName: 'N1', name: 'Clase', durationMinutes: 100 }, { type: 'body', metatype: SessionDto }));
  await assert.rejects(pipe.transform({ attemptId: randomUUID(), attemptSecret: 'a'.repeat(43), email: 'forged@example.com' }, { type: 'body', metatype: ConfirmDto }));
});

test('academic identity is required, persists separately and appears in attendance', async () => {
  const learner: Actor = { id: randomUUID(), role: 'STUDENT', name: 'Google Nickname', email: 'personal@example.com' };
  await db.query('INSERT INTO attendance_app.profiles(id,google_subject,email,name) VALUES($1::uuid,$1::text,$2,$3)', [learner.id, learner.email, learner.name]);
  const s = await session(); const a = await attempt(s.id);
  await assert.rejects(service.confirm(learner, a.attemptId, a.attemptSecret), code('ACADEMIC_PROFILE_REQUIRED'));
  await assert.rejects(service.manual(admin, s.id, learner.id), code('ACADEMIC_PROFILE_REQUIRED'));
  assert.equal((await service.attendees(admin, s.id)).length, 0);
  const profile = await service.saveAcademicProfile(learner, 'María José', 'Pérez Gómez');
  assert.equal(profile.email, learner.email); assert.equal(profile.name, 'María José Pérez Gómez');
  const guard = new AuthGuard({ ...config, supabaseUrl: 'https://example.supabase.co', supabaseKey: 'test-key' }, db, new Reflector());
  (guard as any).supabase.auth.getUser = async () => ({ data: { user: { id: learner.id, email: learner.email, email_confirmed_at: new Date().toISOString(), identities: [{ provider: 'google', identity_data: { sub: learner.id, full_name: 'Changed Google Alias' } }] } }, error: null });
  const request: any = { headers: { authorization: 'Bearer test' } };
  await guard.canActivate({ getHandler: () => function handler() {}, getClass: () => class Controller {}, switchToHttp: () => ({ getRequest: () => request }) } as any);
  assert.equal(request.actor.name, 'María José Pérez Gómez');
  assert.equal(request.actor.academic_first_name, 'María José');
  assert.equal((await service.confirm(learner, a.attemptId, a.attemptSecret)).status, 'PRESENT');
  const rows = await service.attendees(admin, s.id);
  assert.equal(rows[0].name, profile.name); assert.equal(rows[0].email, learner.email);
  const next = await session(); const nextAttempt = await attempt(next.id);
  assert.equal((await service.confirm(learner, nextAttempt.attemptId, nextAttempt.attemptSecret)).status, 'PRESENT');
});
