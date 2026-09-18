import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
const Trim = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value);
export class CourseDto {
  @IsString() @Trim() @Length(1, 120) name!: string;
}
export class SessionDto {
  @IsOptional() @IsUUID() courseId?: string;
  @IsOptional() @IsString() @Trim() @Length(1, 120) courseName?: string;
  @IsString() @Trim() @Length(1, 120) name!: string;
  @IsInt() @IsIn([2, 5, 10]) durationMinutes = 5;
}
export class StartDto {
  @IsString() @Length(20, 2048) qrToken!: string;
}
export class ConfirmDto {
  @IsUUID() attemptId!: string;
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) attemptSecret!: string;
}
export class ManualDto {
  @IsUUID() userId!: string;
}
export class VoidDto {
  @IsOptional() @IsString() @Trim() @Length(1, 500) reason?: string;
}
export class ArchiveDto {
  @IsOptional() @IsBoolean() confirmWithAttendance = false;
}
