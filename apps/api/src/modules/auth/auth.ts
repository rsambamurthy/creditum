import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { createRemoteJWKSet, jwtVerify, SignJWT, JWTPayload } from 'jose';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { ENV } from '../../database/database.module';
import { Env } from '../../config/env';
import { context } from '../../common/request-context';
import { ForbiddenError, DomainError } from '../../common/errors';
import { AppUser, Tenant } from '../tenancy/tenancy.entities';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const ROLES = 'roles';
/** Restrict an endpoint to users holding at least one of these roles. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES, roles);

export const ROLE = {
  relationshipOfficer: 'relationship_officer', creditAnalyst: 'credit_analyst', creditRisk: 'credit_risk', committee: 'committee_member',
  seniorCommittee: 'senior_committee_member', executiveCommittee: 'executive_committee_member', creditAdmin: 'credit_admin',
  configAdmin: 'config_admin', auditor: 'auditor',
} as const;

interface Principal { userId: string; displayName: string; roles: string[]; tenantId: string; tenantCode: string; sessionId: string }

@Injectable()
export class AuthService {
  private readonly log = new Logger('Auth');
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  constructor(@Inject(ENV) private readonly env: Env, private readonly ds: DataSource) {
    if (env.authMode === 'oidc') this.jwks = createRemoteJWKSet(new URL(env.oidc!.jwksUri));
    else this.log.warn('DEVELOPMENT SIGN-IN IS ENABLED (AUTH_MODE=dev). Never use this mode in a bank deployment.');
  }

  private secret() { return new TextEncoder().encode(this.env.devJwtSecret!); }

  /** Development / demo sign-in: pick a seeded user of a tenant. Disabled unless explicitly enabled. */
  async devLogin(tenantCode: string, loginName: string) {
    if (this.env.authMode !== 'dev') throw new ForbiddenError('Development sign-in is disabled');
    const tenant = await this.ds.getRepository(Tenant).findOne({ where: { code: tenantCode, status: 'active' } });
    if (!tenant) throw new DomainError('invalid_login', 'Unknown workspace', 401);
    const user = await this.ds.getRepository(AppUser).findOne({ where: { tenantId: tenant.id, loginName, isActive: true } });
    if (!user) throw new DomainError('invalid_login', 'Unknown user', 401);
    const token = await new SignJWT({ tid: tenant.id, tcode: tenant.code, name: user.displayName, roles: user.roleCodes.split(',').filter(Boolean) })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setJti(randomUUID()).setIssuedAt()
      .setExpirationTime(`${this.env.tokenTtlSeconds}s`).setIssuer('creditum-dev').setAudience('creditum').sign(this.secret());
    return { token, expiresIn: this.env.tokenTtlSeconds };
  }

  async devUsers(tenantCode: string) {
    if (this.env.authMode !== 'dev') throw new ForbiddenError('Development sign-in is disabled');
    const tenant = await this.ds.getRepository(Tenant).findOne({ where: { code: tenantCode, status: 'active' } });
    if (!tenant) return [];
    const users = await this.ds.getRepository(AppUser).find({ where: { tenantId: tenant.id, isActive: true }, order: { displayName: 'ASC' } });
    return users.map(u => ({ loginName: u.loginName, displayName: u.displayName, roles: u.roleCodes.split(',').filter(Boolean) }));
  }

  async verify(token: string): Promise<Principal> {
    let p: JWTPayload;
    try {
      if (this.env.authMode === 'dev') {
        p = (await jwtVerify(token, this.secret(), { issuer: 'creditum-dev', audience: 'creditum' })).payload;
        return { userId: p.sub!, displayName: String(p.name), roles: p.roles as string[], tenantId: String(p.tid), tenantCode: String(p.tcode), sessionId: String(p.jti) };
      }
      const o = this.env.oidc!;
      p = (await jwtVerify(token, this.jwks!, { issuer: o.issuer, audience: o.audience })).payload;
    } catch {
      throw new DomainError('unauthenticated', 'Sign-in is required or has expired', 401);
    }
    const o = this.env.oidc!;
    const tenantCode = String(p[o.tenantClaim] ?? '');
    const tenant = await this.ds.getRepository(Tenant).findOne({ where: { code: tenantCode, status: 'active' } });
    if (!tenant) throw new DomainError('unauthenticated', 'Your identity is not mapped to an active workspace', 401);
    const rolesClaim = p[o.rolesClaim];
    return { userId: p.sub!, displayName: String(p[o.nameClaim] ?? p.sub), roles: Array.isArray(rolesClaim) ? rolesClaim.map(String) : [],
      tenantId: tenant.id, tenantCode: tenant.code, sessionId: String(p.jti ?? p.sid ?? '') };
  }
}

/** Global guard: every endpoint requires a valid token unless marked @Public; then role checks. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) throw new DomainError('unauthenticated', 'Sign-in is required', 401);
    const p = await this.auth.verify(header.slice('Bearer '.length));
    const store = context();
    store.tenantId = p.tenantId; store.tenantCode = p.tenantCode; store.sessionId = p.sessionId;
    store.actor = { userId: p.userId, displayName: p.displayName, roles: p.roles };
    const needed = this.reflector.getAllAndOverride<string[]>(ROLES, targets);
    if (needed?.length && !needed.some(r => p.roles.includes(r))) throw new ForbiddenError('Your role does not allow this action');
    return true;
  }
}
