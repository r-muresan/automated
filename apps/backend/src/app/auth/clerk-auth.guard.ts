import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verifyToken } from '@clerk/backend';
import { PrismaService } from '../prisma.service';

const ADMIN_EMAIL = 'robert.victor.muresan@gmail.com';

@Injectable()
export class ClerkAuthGuard implements CanActivate {
  private readonly logger = new Logger(ClerkAuthGuard.name);

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // If Clerk is not configured, use a default local user
    const clerkSecretKey = this.configService.get<string>('CLERK_SECRET_KEY');
    if (!clerkSecretKey || clerkSecretKey.trim() === '') {
      const email = 'local@localhost';
      request['user'] = { email };
      await this.prisma.user.upsert({
        where: { email },
        update: {},
        create: { email },
      }).catch(() => {});
      return true;
    }

    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }

    try {
      const sessionClaims = await verifyToken(token, {
        secretKey: this.configService.get<string>('CLERK_SECRET_KEY'),
      });
      request['user'] = sessionClaims;

      // Ensure User row exists for this Clerk user
      const email = (sessionClaims as any).email;
      if (email) {
        await this.prisma.user.upsert({
          where: { email },
          update: {},
          create: { email },
        }).catch(() => {}); // ignore race conditions
      }

      // Handle admin impersonation
      const impersonatedEmail = request.headers['x-admin-impersonation'];
      if (impersonatedEmail) {
        if (email !== ADMIN_EMAIL) {
          throw new ForbiddenException('Only admin can impersonate users');
        }
        this.logger.log(`Admin impersonating user: ${impersonatedEmail}`);
        // Override the email in session claims so downstream code sees the impersonated user
        (sessionClaims as any).email = impersonatedEmail;
        // Ensure impersonated user exists
        await this.prisma.user.upsert({
          where: { email: impersonatedEmail },
          update: {},
          create: { email: impersonatedEmail },
        }).catch(() => {});
      }

      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }
      console.error('Clerk verification error:', error);
      throw new UnauthorizedException('Invalid token');
    }
  }

  private extractTokenFromHeader(request: any): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
