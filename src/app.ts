import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CONFIG, readConfig } from './config';
import { Database } from './db';
import { AuthGuard } from './auth';
import { QrTokens } from './qr';
import { AttendanceService } from './attendance';
import { ApiController } from './controller';
@Module({
  imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60000, limit: 1200 }])],
  controllers: [ApiController],
  providers: [{ provide: CONFIG, useFactory: readConfig }, Database, QrTokens, AttendanceService,
    { provide: APP_GUARD, useClass: ThrottlerGuard }, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
