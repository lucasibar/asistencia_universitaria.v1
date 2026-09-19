import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Request } from 'express';
import { CONFIG, Config } from './config';
import { Database } from './db';
import { fail } from './errors';

export interface Actor { id: string; role: 'ADMIN' | 'STUDENT'; name: string; email: string; academic_first_name?: string | null; academic_last_name?: string | null; }
export interface AuthRequest extends Request { actor: Actor; }
export const Public = () => SetMetadata('public', true);
export const Admin = () => SetMetadata('admin', true);

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly supabase: SupabaseClient;
  constructor(@Inject(CONFIG) config: Config, @Inject(Database) private readonly db: Database,
    @Inject(Reflector) private readonly reflector: Reflector) {
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(10000) }) },
    });
  }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride('public', targets)) return true;
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '');
    if (!match) fail('UNAUTHENTICATED', 401);
    const { data, error } = await this.supabase.auth.getUser(match[1]);
    if (error || !data.user) fail('UNAUTHENTICATED', 401);
    const user = data.user;
    const google = user.identities?.find(identity => identity.provider === 'google');
    if (!google || !user.email || !user.email_confirmed_at || !google.identity_data?.sub) fail('GOOGLE_IDENTITY_REQUIRED', 403);
    // Role is exclusively database-managed; user_metadata is never authorization input.
    const identity = google.identity_data;
    const { rows } = await this.db.query(`INSERT INTO attendance_app.profiles(id,google_subject,email,name,avatar_url)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET email=excluded.email,
      name=CASE WHEN profiles.academic_first_name IS NULL THEN excluded.name ELSE profiles.name END,
      avatar_url=excluded.avatar_url,last_login_at=clock_timestamp()
      RETURNING id,role,name,email,academic_first_name,academic_last_name`, [user.id, identity.sub, user.email,
      String(identity.full_name ?? identity.name ?? user.email).slice(0, 200), identity.avatar_url ?? null]);
    request.actor = rows[0];
    if (this.reflector.getAllAndOverride('admin', targets) && request.actor.role !== 'ADMIN') fail('FORBIDDEN', 403);
    return true;
  }
}
