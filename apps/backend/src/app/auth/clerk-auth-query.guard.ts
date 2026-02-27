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

const ADMIN_EMAIL = 'robert.victor.muresan@gmail.com';

@Injectable()
export class ClerkAuthQueryGuard implements CanActivate {
  private readonly logger = new Logger(ClerkAuthQueryGuard.name);

  constructor(private configService: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // If Clerk is not configured, use a default local user
    const clerkSecretKey = this.configService.get<string>('CLERK_SECRET_KEY');
    if (!clerkSecretKey || clerkSecretKey.trim() === '') {
      request['user'] = { email: 'local@localhost' };
      return true;
    }

    const token = this.extractTokenFromHeader(request) ?? this.extractTokenFromQuery(request);

    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }

    try {
      const sessionClaims = await verifyToken(token, {
        secretKey: this.configService.get<string>('CLERK_SECRET_KEY'),
      });
      request['user'] = sessionClaims;

      // Handle admin impersonation
      const impersonatedEmail = request.headers['x-admin-impersonation'];
      if (impersonatedEmail) {
        const email = (sessionClaims as any).email;
        if (email !== ADMIN_EMAIL) {
          throw new ForbiddenException('Only admin can impersonate users');
        }
        this.logger.log(`Admin impersonating user: ${impersonatedEmail}`);
        (sessionClaims as any).email = impersonatedEmail;
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

  private extractTokenFromQuery(request: any): string | undefined {
    const token = request.query?.token;
    return typeof token === 'string' ? token : undefined;
  }
}
