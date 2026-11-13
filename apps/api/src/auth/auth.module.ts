import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginRateLimitGuard, LoginRateLimiter } from './login-rate-limit';

/**
 * Global so `JwtAuthGuard` — registered as an `APP_GUARD` in the root module — can
 * inject `JwtService`. A guard registered at the root resolves its dependencies from
 * the root's imports, which is why the module that owns the token configuration is
 * global rather than imported only where it is used.
 *
 * The token is HS256 with a 15-minute TTL (contract §5). `expiresIn` is the only
 * place the TTL is decided; the login response reports the same number back so a
 * client does not have to hardcode it.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        secret: config.jwtSecret,
        signOptions: { algorithm: 'HS256', expiresIn: config.jwtTtlSeconds },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, LoginRateLimiter, LoginRateLimitGuard],
  exports: [JwtModule, AuthService],
})
export class AuthModule {}
