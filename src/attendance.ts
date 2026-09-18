import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { QueryResult } from 'pg';
import { CONFIG, Config } from './config';
import { Database } from './db';
import { Actor } from './auth';
import { SessionDto } from './dto';
import { fail } from './errors';
import { QrTokens } from './qr';

type Client = { query(text: string, values?: unknown[]): Promise<QueryResult> };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class AttendanceService {
  constructor(@Inject(Database) private readonly db: Database, @Inject(QrTokens) private readonly qr: QrTokens,
    @Inject(CONFIG) private readonly config: Config) {}

  async courses(actor: Actor, offset = 0, includeArchived = false) {
    return (await this.db.query(`SELECT c.*, (SELECT count(*)::int FROM attendance_app.classes cl WHERE cl.course_id=c.id AND cl.archived_at IS NULL) AS class_count
      FROM attendance_app.courses c WHERE created_by=$1 AND ($3::boolean OR archived_at IS NULL) ORDER BY created_at DESC,id LIMIT 100 OFFSET $2`, [actor.id, offset, includeArchived])).rows;
  }
  async createCourse(actor: Actor, name: string) {
    return (await this.db.query('INSERT INTO attendance_app.courses(name,created_by) VALUES($1,$2) RETURNING *', [name, actor.id])).rows[0];
  }
  async classes(actor: Actor, courseId: string, offset = 0) {
    await this.ownedCourse(this.db, courseId, actor);
    return (await this.db.query(`SELECT cl.*,s.id AS session_id,s.started_at,s.expires_at,s.closed_at,
      CASE WHEN s.status='OPEN' AND s.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE s.status END AS session_status,
      (SELECT count(*)::int FROM attendance_app.attendance a WHERE a.session_id=s.id AND a.status='PRESENT') AS present_count
      FROM attendance_app.classes cl LEFT JOIN attendance_app.attendance_sessions s ON s.class_id=cl.id
      WHERE cl.course_id=$1 ORDER BY cl.created_at DESC,cl.id LIMIT 100 OFFSET $2`, [courseId, offset])).rows;
  }
  async createSession(actor: Actor, input: SessionDto) {
    if (Boolean(input.courseId) === Boolean(input.courseName)) fail('PROVIDE_COURSE_ID_OR_NAME');
    return this.db.transaction(async tx => {
      const courseId = input.courseId ?? (await tx.query('INSERT INTO attendance_app.courses(name,created_by) VALUES($1,$2) RETURNING id', [input.courseName, actor.id])).rows[0].id;
      const course = await this.ownedCourse(tx, courseId, actor, true);
      if (course.archived_at) fail('COURSE_ARCHIVED', 409);
      const cls = (await tx.query('INSERT INTO attendance_app.classes(course_id,name,created_by) VALUES($1,$2,$3) RETURNING *', [courseId, input.name, actor.id])).rows[0];
      const now = await this.now(tx);
      const session = (await tx.query(`INSERT INTO attendance_app.attendance_sessions(class_id,started_at,expires_at,created_by)
        VALUES($1,$2,$2::timestamptz+($3 * interval '1 minute'),$4) RETURNING *`, [cls.id, now, input.durationMinutes, actor.id])).rows[0];
      return { ...session, course_id: courseId, class_name: cls.name, course_name: course.name, server_time: now };
    });
  }
  async session(actor: Actor, sessionId: string) {
    const result = (await this.db.query(`SELECT s.*,cl.name AS class_name,c.name AS course_name,c.id AS course_id,
      cl.archived_at AS class_archived_at,c.archived_at AS course_archived_at,
      CASE WHEN s.status='OPEN' AND s.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE s.status END AS effective_status,
      clock_timestamp() AS server_time,
      (SELECT count(*)::int FROM attendance_app.attendance a WHERE a.session_id=s.id AND a.status='PRESENT') AS present_count
      FROM attendance_app.attendance_sessions s JOIN attendance_app.classes cl ON cl.id=s.class_id
      JOIN attendance_app.courses c ON c.id=cl.course_id WHERE s.id=$1 AND c.created_by=$2`, [sessionId, actor.id])).rows[0];
    if (!result) fail('SESSION_NOT_FOUND', 404);
    return result;
  }
  async currentQr(actor: Actor, sessionId: string) {
    return this.db.transaction(async tx => {
      const session = await this.lockSession(tx, sessionId, actor);
      const now = await this.now(tx);
      this.requireOpen(session, now);
      return this.qr.issue(session.id, session.started_at, session.expires_at, now);
    });
  }
  async close(actor: Actor, sessionId: string) {
    return this.db.transaction(async tx => {
      const session = await this.lockSession(tx, sessionId, actor);
      if (session.status !== 'OPEN') return session;
      return (await tx.query("UPDATE attendance_app.attendance_sessions SET status='CLOSED',closed_at=clock_timestamp() WHERE id=$1 RETURNING *", [sessionId])).rows[0];
    });
  }
  async start(qrToken: string) {
    const payload = this.qr.verify(qrToken);
    return this.db.transaction(async tx => {
      const session = await this.lockSession(tx, payload.sessionId);
      const now = await this.now(tx);
      this.requireOpen(session, now);
      if (now.getTime() < payload.nbf || now.getTime() >= payload.exp) fail('QR_EXPIRED', 410);
      const secret = randomBytes(32).toString('base64url');
      const attempt = (await tx.query(`INSERT INTO attendance_app.check_in_attempts(session_id,secret_hash,created_at,expires_at)
        VALUES($1,$2,$3,$3::timestamptz+($4 * interval '1 second')) RETURNING id,expires_at`,
        [session.id, hash(secret), now, this.config.attemptSeconds])).rows[0];
      return { attemptId: attempt.id, attemptSecret: secret, expiresAt: attempt.expires_at, serverTime: now };
    });
  }
  async confirm(actor: Actor, attemptId: string, secret: string) {
    return this.db.transaction(async tx => {
      const initial = (await tx.query('SELECT session_id FROM attendance_app.check_in_attempts WHERE id=$1', [attemptId])).rows[0];
      if (!initial) fail('INVALID_ATTEMPT', 404);
      const session = await this.lockSession(tx, initial.session_id);
      const attempt = (await tx.query('SELECT * FROM attendance_app.check_in_attempts WHERE id=$1 FOR UPDATE', [attemptId])).rows[0];
      if (!timingSafeEqual(Buffer.from(attempt.secret_hash, 'hex'), Buffer.from(hash(secret), 'hex'))) fail('INVALID_ATTEMPT', 404);
      if (session.class_archived_at || session.course_archived_at || session.status === 'CANCELLED') fail('SESSION_CANCELLED', 410);
      // Completed retries are safe only for the original authenticated user.
      if (attempt.status === 'COMPLETED') {
        if (attempt.user_id !== actor.id) fail('ATTEMPT_USED', 409);
        const attendance = (await tx.query('SELECT * FROM attendance_app.attendance WHERE session_id=$1 AND user_id=$2', [session.id, actor.id])).rows[0];
        if (attendance.status === 'VOIDED') fail('ATTENDANCE_VOIDED', 409);
        return { status: 'ALREADY_PRESENT', attendance };
      }
      const now = await this.now(tx);
      if (now >= attempt.expires_at) fail('ATTEMPT_EXPIRED', 410);
      // Session closure/expiry does not invalidate a previously issued, live attempt.
      const inserted = await tx.query(`INSERT INTO attendance_app.attendance(session_id,user_id,source,created_by)
        VALUES($1,$2,'QR',$2) ON CONFLICT(session_id,user_id) DO NOTHING RETURNING *`, [session.id, actor.id]);
      const attendance = inserted.rows[0] ?? (await tx.query('SELECT * FROM attendance_app.attendance WHERE session_id=$1 AND user_id=$2', [session.id, actor.id])).rows[0];
      if (attendance.status === 'VOIDED') fail('ATTENDANCE_VOIDED', 409);
      await tx.query("UPDATE attendance_app.check_in_attempts SET status='COMPLETED',used_at=clock_timestamp(),user_id=$2 WHERE id=$1", [attemptId, actor.id]);
      return { status: inserted.rowCount ? 'PRESENT' : 'ALREADY_PRESENT', attendance };
    });
  }
  async attendees(actor: Actor, sessionId: string, offset = 0) {
    await this.session(actor, sessionId);
    return (await this.db.query(`SELECT a.*,p.name,p.email FROM attendance_app.attendance a
      JOIN attendance_app.profiles p ON p.id=a.user_id WHERE session_id=$1 ORDER BY checked_in_at,id LIMIT 100 OFFSET $2`, [sessionId, offset])).rows;
  }
  async students(search: string, offset = 0) {
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    return (await this.db.query(`SELECT id,name,email FROM attendance_app.profiles WHERE name ILIKE $1 OR email ILIKE $1
      ORDER BY name,id LIMIT 50 OFFSET $2`, [pattern, offset])).rows;
  }
  async manual(actor: Actor, sessionId: string, userId: string) {
    return this.db.transaction(async tx => {
      const session = await this.lockSession(tx, sessionId, actor);
      if (session.class_archived_at || session.course_archived_at || session.status === 'CANCELLED') fail('SESSION_CANCELLED', 410);
      if (!(await tx.query('SELECT id FROM attendance_app.profiles WHERE id=$1', [userId])).rowCount) fail('STUDENT_NOT_FOUND', 404);
      const inserted = await tx.query(`INSERT INTO attendance_app.attendance(session_id,user_id,source,created_by)
        VALUES($1,$2,'MANUAL',$3) ON CONFLICT(session_id,user_id) DO NOTHING RETURNING *`, [sessionId, userId, actor.id]);
      const attendance = inserted.rows[0] ?? (await tx.query('SELECT * FROM attendance_app.attendance WHERE session_id=$1 AND user_id=$2', [sessionId, userId])).rows[0];
      if (attendance.status === 'VOIDED') fail('ATTENDANCE_VOIDED', 409);
      return { status: inserted.rowCount ? 'PRESENT' : 'ALREADY_PRESENT', attendance };
    });
  }
  async voidAttendance(actor: Actor, id: string, reason?: string) {
    return this.db.transaction(async tx => {
      const row = (await tx.query('SELECT session_id FROM attendance_app.attendance WHERE id=$1', [id])).rows[0];
      if (!row) fail('ATTENDANCE_NOT_FOUND', 404);
      await this.lockSession(tx, row.session_id, actor);
      await tx.query(`UPDATE attendance_app.attendance SET status='VOIDED',voided_at=clock_timestamp(),voided_by=$2,reason=$3 WHERE id=$1 AND status='PRESENT'`, [id, actor.id, reason ?? null]);
      return (await tx.query('SELECT * FROM attendance_app.attendance WHERE id=$1', [id])).rows[0];
    });
  }
  async archive(actor: Actor, id: string, kind: 'course' | 'class', confirmed: boolean) {
    return this.db.transaction(async tx => {
      let courseId = id;
      if (kind === 'class') {
        const cls = (await tx.query('SELECT course_id FROM attendance_app.classes WHERE id=$1', [id])).rows[0];
        if (!cls) fail('CLASS_NOT_FOUND', 404);
        courseId = cls.course_id;
      }
      await this.ownedCourse(tx, courseId, actor, true);
      const condition = kind === 'course' ? 'cl.course_id=$1' : 'cl.id=$1';
      const existing = await tx.query(`SELECT 1 FROM attendance_app.attendance a JOIN attendance_app.attendance_sessions s ON s.id=a.session_id
        JOIN attendance_app.classes cl ON cl.id=s.class_id WHERE ${condition} LIMIT 1`, [id]);
      if (existing.rowCount && !confirmed) fail('ARCHIVE_CONFIRMATION_REQUIRED', 409);
      await tx.query(`UPDATE attendance_app.attendance_sessions s SET status='CANCELLED',closed_at=COALESCE(closed_at,clock_timestamp())
        FROM attendance_app.classes cl WHERE s.class_id=cl.id AND ${condition}`, [id]);
      await tx.query(`UPDATE attendance_app.classes cl SET archived_at=COALESCE(archived_at,clock_timestamp()) WHERE ${condition}`, [id]);
      if (kind === 'course') await tx.query('UPDATE attendance_app.courses SET archived_at=COALESCE(archived_at,clock_timestamp()),updated_at=clock_timestamp() WHERE id=$1', [id]);
      return { status: 'ARCHIVED' };
    });
  }
  private async ownedCourse(tx: Client, id: string, actor: Actor, lock = false) {
    const row = (await tx.query(`SELECT * FROM attendance_app.courses WHERE id=$1 AND created_by=$2 ${lock ? 'FOR UPDATE' : ''}`, [id, actor.id])).rows[0];
    if (!row) fail('COURSE_NOT_FOUND', 404);
    return row;
  }
  private async lockSession(tx: Client, id: string, actor?: Actor) {
    const initial = (await tx.query(`SELECT cl.course_id FROM attendance_app.attendance_sessions s
      JOIN attendance_app.classes cl ON cl.id=s.class_id WHERE s.id=$1`, [id])).rows[0];
    if (!initial) fail('SESSION_NOT_FOUND', 404);
    // Every mutation locks course first, then session, then attempt. This also
    // serializes archive/close versus in-flight check-ins with a consistent order.
    const course = (await tx.query('SELECT * FROM attendance_app.courses WHERE id=$1 FOR UPDATE', [initial.course_id])).rows[0];
    if (actor && course.created_by !== actor.id) fail('SESSION_NOT_FOUND', 404);
    return (await tx.query(`SELECT s.*,cl.archived_at AS class_archived_at,$2::timestamptz AS course_archived_at
      FROM attendance_app.attendance_sessions s JOIN attendance_app.classes cl ON cl.id=s.class_id WHERE s.id=$1 FOR UPDATE OF s`, [id, course.archived_at])).rows[0];
  }
  private async now(tx: Client): Promise<Date> { return (await tx.query('SELECT clock_timestamp() AS now')).rows[0].now; }
  private requireOpen(session: any, now: Date) {
    if (session.class_archived_at || session.course_archived_at || session.status !== 'OPEN' || now >= session.expires_at) fail('SESSION_CLOSED', 410);
  }
}
