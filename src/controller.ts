import { Body, Controller, DefaultValuePipe, Get, Inject, Param, ParseBoolPipe, ParseIntPipe, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { Admin, AuthRequest, Public } from './auth';
import { AttendanceService } from './attendance';
import { AcademicProfileDto, ArchiveDto, ConfirmDto, CourseDto, ManualDto, SessionDto, StartDto, VoidDto } from './dto';
import { Database } from './db';
import { fail } from './errors';

function page(offset: number) { if (offset < 0 || offset > 1000000) fail('INVALID_OFFSET'); return offset; }
@Controller()
export class ApiController {
  constructor(@Inject(AttendanceService) private readonly service: AttendanceService, @Inject(Database) private readonly db: Database) {}
  @Public() @Get('health') health() { return { status: 'ok' }; }
  @Public() @Get('health/ready') async ready() { await this.db.query('SELECT 1'); return { status: 'ok' }; }
  @Get('me') me(@Req() request: AuthRequest) { return request.actor; }
  @Post('me/academic-profile') academicProfile(@Req() request: AuthRequest, @Body() body: AcademicProfileDto) {
    return this.service.saveAcademicProfile(request.actor, body.firstName, body.lastName);
  }
  @Post('me/teacher') async registerTeacher(@Req() request: AuthRequest) {
    // Explicit self-registration grants access only to this account's own courses.
    return (await this.db.query("UPDATE attendance_app.profiles SET role='ADMIN' WHERE id=$1 RETURNING id,role,name,email", [request.actor.id])).rows[0];
  }
  @Admin() @Get('courses') courses(@Req() r: AuthRequest, @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number, @Query('includeArchived', new DefaultValuePipe(false), ParseBoolPipe) includeArchived: boolean) { return this.service.courses(r.actor, page(offset), includeArchived); }
  @Admin() @Post('courses') createCourse(@Req() r: AuthRequest, @Body() body: CourseDto) { return this.service.createCourse(r.actor, body.name); }
  @Admin() @Get('courses/:id/classes') classes(@Req() r: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number) { return this.service.classes(r.actor, id, page(offset)); }
  @Admin() @Post('courses/:id/archive') archiveCourse(@Req() r: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: ArchiveDto) { return this.service.archive(r.actor, id, 'course', body.confirmWithAttendance); }
  @Admin() @Post('classes/:id/archive') archiveClass(@Req() r: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: ArchiveDto) { return this.service.archive(r.actor, id, 'class', body.confirmWithAttendance); }
  @Admin() @Post('attendance-sessions') createSession(@Req() r: AuthRequest, @Body() body: SessionDto) { return this.service.createSession(r.actor, body); }
  @Admin() @Get('attendance-sessions/:id') session(@Req() r: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.service.session(r.actor, id); }
  @Admin() @Get('attendance-sessions/:id/qr') qr(@Req() r: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.service.currentQr(r.actor, id); }
  @Admin() @Post('attendance-sessions/:id/close') close(@Req() r: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.service.close(r.actor, id); }
  @Admin() @Get('attendance-sessions/:id/attendance') attendees(@Req() r: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number) { return this.service.attendees(r.actor, id, page(offset)); }
  @Admin() @Get('students') students(@Query('q') q: unknown, @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number) {
    if (typeof q !== 'string' || q.trim().length < 2 || q.length > 100) fail('INVALID_SEARCH');
    return this.service.students(q.trim(), page(offset));
  }
  @Admin() @Post('attendance-sessions/:id/attendance/manual') async manual(@Req() r: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: ManualDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.manual(r.actor, id, body.userId); response.status(result.status === 'PRESENT' ? 201 : 200); return result;
  }
  @Admin() @Post('attendance/:id/void') voidAttendance(@Req() r: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: VoidDto) { return this.service.voidAttendance(r.actor, id, body.reason); }
  @Public() @Throttle({ default: { limit: 300, ttl: 60000 } }) @Post('attendance/check-in/start') start(@Body() body: StartDto) { return this.service.start(body.qrToken); }
  @Post('attendance/check-in/confirm') async confirm(@Req() r: AuthRequest, @Body() body: ConfirmDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.confirm(r.actor, body.attemptId, body.attemptSecret); response.status(result.status === 'PRESENT' ? 201 : 200); return result;
  }
}
