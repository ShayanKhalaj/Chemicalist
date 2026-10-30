"use strict";

/**
 * Platform layer templates — part 1: configuration, identity & authentication,
 * authorization and tenancy.
 *
 * Every file generated from here is a real implementation, not a placeholder
 * interface: the contract in `docs/BACKEND_FOLDERING_RULES.md` says that
 * authentication is enabled by default, that a role alone is not enough (the
 * permission for the operation is checked too) and that the tenant always comes
 * from the verified identity, never from request data.
 */

function configurationFiles(ctx) {
  const corsOrigin = ctx.app.api.corsOrigin;
  const defaultDatabaseUrl =
    ctx.persistence.database === 'mongodb'
      ? 'mongodb://localhost:27017/' + ctx.app.name.replace(/-/g, '_')
      : 'postgresql://localhost:5432/postgres?schema=' + ctx.persistence.schema;
  return {
    envSchema: `import { z } from 'zod';

/**
 * Environment configuration. Unknown or invalid values fail fast at startup.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(${ctx.app.api.port}),
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgresql://postgres:postgres@localhost:5432/postgres?schema=${ctx.persistence.schema}'),
  CORS_ORIGIN: z.string().default('${corsOrigin}'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  JWT_SECRET: z.string().min(32).default('development-only-secret-change-before-deploy'),
  JWT_EXPIRES_IN: z.string().default('1h'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  BOOTSTRAP_USER_EMAIL: z.string().email().optional().or(z.literal('')),
  BOOTSTRAP_USER_PASSWORD: z.string().min(8).optional().or(z.literal('')),
  BOOTSTRAP_TENANT_SLUG: z.string().min(1).default('default'),
  BOOTSTRAP_TENANT_NAME: z.string().min(1).default('Default Tenant'),
  FILE_STORAGE_DIR: z.string().min(1).default('.storage/files'),
  INTEGRATION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(10000),
${ctx.has("cache") ? "  REDIS_URL: z.string().default('redis://localhost:6379'),\n" : ""}${ctx.has("messaging") ? "  RABBITMQ_URL: z.string().default('amqp://guest:guest@localhost:5672'),\n" : ""}${ctx.app.hasVersioning ? "  API_VERSION: z.string().default('" + ctx.app.api.version + "'),\n" : ""}});

const RuntimeEnvSchema = EnvSchema.superRefine((environment, context) => {
  if (
    environment.NODE_ENV === 'production' &&
    environment.JWT_SECRET.startsWith('development-only-')
  ) {
    context.addIssue({
      code: 'custom',
      path: ['JWT_SECRET'],
      message: 'Set a unique JWT_SECRET of at least 32 characters in production',
    });
  }
});

export type AppEnv = z.infer<typeof RuntimeEnvSchema>;

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const result = RuntimeEnvSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => '  - ' + issue.path.join('.') + ': ' + issue.message)
      .join('\\n');
    throw new Error('Invalid environment configuration:\\n' + issues);
  }
  return { ...config, ...result.data };
}

export const APP_CONFIG = 'APP_CONFIG';
export const appConfig = () => RuntimeEnvSchema.parse(process.env);
`.replace(
      /\.default\('postgresql:[^']*'\),/,
      '.default(' + JSON.stringify(defaultDatabaseUrl) + '),',
    ),
    configModule: `import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema';

/**
 * Platform configuration owner: environment loading + validation.
 * Feature flags (runtime configuration) live in ./feature-flag.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env', '.env.local'],
      validate: validateEnv,
    }),
  ],
})
export class ConfigurationModule {}
`,
  };
}

function identityFiles() {
  return {
    types: `/** A verified caller, built from the access token and the user record. */
export interface Principal {
  userId: string;
  email: string;
  tenantId?: string;
  isPlatformAdmin: boolean;
  roles: string[];
}

/** Public projection of a user; never contains the password hash. */
export interface UserView {
  id: string;
  email: string;
  username: string | null;
  displayName: string | null;
  tenantId: string | null;
  status: string;
  isPlatformAdmin: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface CreateUserInput {
  email: string;
  username?: string;
  password: string;
  displayName?: string;
  tenantId?: string;
}

export interface UserRecord {
  id: string;
  email: string;
  username: string | null;
  passwordHash: string;
  displayName: string | null;
  tenantId: string | null;
  status: string;
  isPlatformAdmin: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}
`,
    service: `import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { hash } from 'bcryptjs';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { ALL_PERMISSION_KEYS } from '../authorization/permission-catalog';
import type { RequestIdentity } from '../../shared/context/request-context';
import type { CreateUserInput, Principal, UserRecord, UserView } from './identity.types';

const BCRYPT_ROUNDS = 12;

/**
 * Identity owner: users, roles and permissions.
 *
 * Authentication (proving *who* the caller is) lives in ../security; this
 * service is the only place that reads user/role/permission rows.
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private static toView(user: UserRecord): UserView {
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
      tenantId: user.tenantId,
      status: user.status,
      isPlatformAdmin: user.isPlatformAdmin,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
  }

  private assertTenantAccess(tenantId: string | null, actor: RequestIdentity): void {
    if (!actor.isPlatformAdmin && tenantId !== (actor.tenantId ?? null)) {
      throw new ForbiddenException({
        code: 'TENANT_SCOPE_VIOLATION',
        message: 'User is outside this tenant',
      });
    }
  }

  async findById(id: string): Promise<UserRecord | null> {
    return this.prisma.chemicalistUser.findUnique({ where: { id } });
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.prisma.chemicalistUser.findUnique({ where: { email: email.toLowerCase() } });
  }

  async findByIdentifier(identifier: string): Promise<UserRecord | null> {
    const normalized = identifier.trim().toLowerCase();
    return this.prisma.chemicalistUser.findFirst({
      where: { OR: [{ email: normalized }, { username: normalized }] },
    });
  }

  async listUsers(tenantId: string | undefined, actor: RequestIdentity): Promise<UserView[]> {
    if (!actor.isPlatformAdmin && !actor.tenantId) return [];
    const scope = actor.isPlatformAdmin ? tenantId : actor.tenantId ?? null;
    const users = await this.prisma.chemicalistUser.findMany({
      where: scope === undefined ? {} : { tenantId: scope },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return users.map((user) => IdentityService.toView(user));
  }

  async createUser(input: CreateUserInput, actor: RequestIdentity): Promise<UserView> {
    const email = input.email.trim().toLowerCase();
    const username = input.username?.trim().toLowerCase() ?? null;
    const existing = await this.prisma.chemicalistUser.findFirst({
      where: { OR: [{ email }, ...(username ? [{ username }] : [])] },
    });
    if (existing) {
      throw new ConflictException({
        code: 'USER_EXISTS',
        message: 'A user with this email or username already exists',
      });
    }
    if (!actor.isPlatformAdmin && !actor.tenantId) {
      throw new ForbiddenException({
        code: 'TENANT_SCOPE_VIOLATION',
        message: 'A tenant-scoped identity is required to create users',
      });
    }
    const passwordHash = await hash(input.password, BCRYPT_ROUNDS);
    const tenantId = actor.isPlatformAdmin
      ? input.tenantId ?? actor.tenantId ?? null
      : actor.tenantId ?? null;
    if (
      tenantId &&
      !(await this.prisma.chemicalistTenant.findUnique({ where: { id: tenantId } }))
    ) {
      throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Tenant not found' });
    }
    const user = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.chemicalistUser.create({
        data: {
          email,
          username,
          passwordHash,
          displayName: input.displayName ?? null,
          tenantId,
          isPlatformAdmin: false,
        },
      });
      await transaction.chemicalistUserCredential.create({
        data: {
          userId: created.id,
          type: 'PASSWORD',
          provider: 'local',
          identifier: email,
          secretHash: passwordHash,
        },
      });
      return created;
    });
    return IdentityService.toView(user);
  }

  async setPassword(userId: string, password: string): Promise<void> {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    const passwordHash = await hash(password, BCRYPT_ROUNDS);
    await this.prisma.$transaction(async (transaction) => {
      await transaction.chemicalistUser.update({
        where: { id: userId },
        data: { passwordHash },
      });
      const credential = await transaction.chemicalistUserCredential.findFirst({
        where: { userId, type: 'PASSWORD' },
      });
      if (credential) {
        await transaction.chemicalistUserCredential.update({
          where: { id: credential.id },
          data: { secretHash: passwordHash },
        });
      } else {
        await transaction.chemicalistUserCredential.create({
          data: {
            userId,
            type: 'PASSWORD',
            provider: 'local',
            identifier: user.email,
            secretHash: passwordHash,
          },
        });
      }
      const revokedAt = new Date();
      await transaction.chemicalistRefreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt },
      });
      await transaction.chemicalistUserSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt },
      });
    });
  }

  async createEmailVerifyToken(userId: string): Promise<string> {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    const token = randomBytes(32).toString('base64url');
    await this.prisma.chemicalistEmailVerifyToken.create({
      data: {
        userId,
        email: user.email,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    return token;
  }

  async verifyEmailToken(token: string): Promise<{ verified: true }> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const record = await this.prisma.chemicalistEmailVerifyToken.findUnique({
      where: { tokenHash },
    });
    if (!record || record.verifiedAt || record.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException({
        code: 'INVALID_VERIFICATION_TOKEN',
        message: 'Email verification token is invalid or expired',
      });
    }
    const verifiedAt = new Date();
    const claimed = await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.chemicalistEmailVerifyToken.updateMany({
        where: { id: record.id, verifiedAt: null, expiresAt: { gt: verifiedAt } },
        data: { verifiedAt },
      });
      if (result.count !== 1) return false;
      await transaction.chemicalistUser.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: verifiedAt },
      });
      await transaction.chemicalistUserCredential.updateMany({
        where: { userId: record.userId, identifier: record.email },
        data: { verifiedAt },
      });
      return true;
    });
    if (!claimed) {
      throw new UnauthorizedException({
        code: 'INVALID_VERIFICATION_TOKEN',
        message: 'Email verification token was already used',
      });
    }
    return { verified: true };
  }

  async createMobileVerifyToken(userId: string, mobile: string): Promise<string> {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    const token = String(randomInt(100000, 1000000));
    await this.prisma.chemicalistMobileVerifyToken.create({
      data: {
        userId,
        mobile,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
    return token;
  }

  async verifyMobileToken(token: string): Promise<{ verified: true }> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const record = await this.prisma.chemicalistMobileVerifyToken.findUnique({
      where: { tokenHash },
    });
    if (!record || record.verifiedAt || record.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException({
        code: 'INVALID_VERIFICATION_TOKEN',
        message: 'Mobile verification token is invalid or expired',
      });
    }
    const verifiedAt = new Date();
    const claimed = await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.chemicalistMobileVerifyToken.updateMany({
        where: { id: record.id, verifiedAt: null, expiresAt: { gt: verifiedAt } },
        data: { verifiedAt },
      });
      if (result.count !== 1) return false;
      await transaction.chemicalistUser.update({
        where: { id: record.userId },
        data: { mobileVerifiedAt: verifiedAt },
      });
      await transaction.chemicalistUserProfile.upsert({
        where: { userId: record.userId },
        update: { phone: record.mobile },
        create: { userId: record.userId, phone: record.mobile },
      });
      await transaction.chemicalistUserCredential.upsert({
        where: { provider_identifier: { provider: 'mobile', identifier: record.mobile } },
        update: { verifiedAt },
        create: {
          userId: record.userId,
          type: 'PHONE',
          provider: 'mobile',
          identifier: record.mobile,
          verifiedAt,
        },
      });
      return true;
    });
    if (!claimed) {
      throw new UnauthorizedException({
        code: 'INVALID_VERIFICATION_TOKEN',
        message: 'Mobile verification token was already used',
      });
    }
    return { verified: true };
  }

  async profileOf(userId: string, actor: RequestIdentity) {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    this.assertTenantAccess(user.tenantId, actor);
    return this.prisma.chemicalistUserProfile.findUnique({ where: { userId } });
  }

  async updateProfile(
    userId: string,
    input: {
      firstName?: string;
      lastName?: string;
      phone?: string;
      avatarUrl?: string;
      locale?: string;
      timeZone?: string;
    },
    actor: RequestIdentity,
  ) {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    this.assertTenantAccess(user.tenantId, actor);
    return this.prisma.chemicalistUserProfile.upsert({
      where: { userId },
      update: input,
      create: { userId, tenantId: user.tenantId, ...input },
    });
  }

  async registerDevice(
    userId: string,
    input: { deviceKey: string; name?: string; platform?: string; userAgent?: string },
    actor: RequestIdentity,
  ) {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    this.assertTenantAccess(user.tenantId, actor);
    return this.prisma.chemicalistUserDevice.upsert({
      where: { userId_deviceKey: { userId, deviceKey: input.deviceKey } },
      update: { ...input, lastSeenAt: new Date(), revokedAt: null },
      create: { userId, ...input },
    });
  }

  async revokeDevice(
    userId: string,
    deviceId: string,
    actor: RequestIdentity,
  ): Promise<boolean> {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    this.assertTenantAccess(user.tenantId, actor);
    const result = await this.prisma.chemicalistUserDevice.updateMany({
      where: { id: deviceId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count > 0;
  }

  async activeSessionIdentity(
    userId: string,
    sessionId: string,
  ): Promise<Principal | null> {
    const [user, session] = await Promise.all([
      this.findById(userId),
      this.prisma.chemicalistUserSession.findFirst({
        where: {
          id: sessionId,
          userId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      }),
    ]);
    if (!user || user.status !== 'ACTIVE' || !session) return null;
    return this.principalOf(user);
  }

  listRoles(tenantId: string | undefined, platformAdmin: boolean) {
    return this.prisma.chemicalistRole.findMany({
      where: platformAdmin
        ? (tenantId ? { tenantId } : {})
        : tenantId
          ? { OR: [{ tenantId }, { tenantId: null }] }
          : { tenantId: null },
      orderBy: [{ tenantId: 'asc' }, { key: 'asc' }],
    });
  }

  listRoleGroups(tenantId: string | undefined, platformAdmin: boolean) {
    return this.prisma.chemicalistRoleGroup.findMany({
      where: platformAdmin
        ? (tenantId ? { tenantId } : {})
        : tenantId
          ? { OR: [{ tenantId }, { tenantId: null }] }
          : { tenantId: null },
      orderBy: [{ tenantId: 'asc' }, { key: 'asc' }],
    });
  }

  listPermissionGroups(tenantId: string | undefined, platformAdmin: boolean) {
    return this.prisma.chemicalistPermissionGroup.findMany({
      where: platformAdmin
        ? (tenantId ? { tenantId } : {})
        : tenantId
          ? { OR: [{ tenantId }, { tenantId: null }] }
          : { tenantId: null },
      orderBy: [{ tenantId: 'asc' }, { key: 'asc' }],
    });
  }

  private async roleIdsOf(userId: string): Promise<string[]> {
    const user = await this.findById(userId);
    if (!user) return [];
    const [assignments, groupAssignments] = await Promise.all([
      this.prisma.chemicalistUserRole.findMany({
        where: { userId, tenantId: user.tenantId },
      }),
      this.prisma.chemicalistUserRoleGroup.findMany({
        where: { userId, tenantId: user.tenantId },
      }),
    ]);
    const groupRoles = groupAssignments.length
      ? await this.prisma.chemicalistRoleGroupRole.findMany({
          where: { roleGroupId: { in: groupAssignments.map((item) => item.roleGroupId) } },
        })
      : [];
    const roleIds = [...new Set([
      ...assignments.map((item) => item.roleId),
      ...groupRoles.map((item) => item.roleId),
    ])];
    if (roleIds.length === 0) return [];
    const roles = await this.prisma.chemicalistRole.findMany({
      where: {
        id: { in: roleIds },
        OR: [{ tenantId: user.tenantId }, { tenantId: null }],
      },
      select: { id: true },
    });
    return roles.map((role) => role.id);
  }

  async roleKeysOf(userId: string): Promise<string[]> {
    const roleIds = await this.roleIdsOf(userId);
    if (roleIds.length === 0) return [];
    const roles = await this.prisma.chemicalistRole.findMany({
      where: { id: { in: roleIds } },
      orderBy: { key: 'asc' },
    });
    return roles.map((role) => role.key);
  }

  /**
   * Effective permissions of a user. Platform administrators get the wildcard,
   * which the permission guard understands as "every permission".
   */
  async permissionsOf(userId: string): Promise<string[]> {
    const user = await this.findById(userId);
    if (!user) return [];
    if (user.isPlatformAdmin) return ['*'];

    const roleIds = await this.roleIdsOf(userId);
    if (roleIds.length === 0) return [];
    const rolePermissions = await this.prisma.chemicalistRolePermission.findMany({
      where: { roleId: { in: roleIds } },
    });
    if (rolePermissions.length === 0) return [];
    const permissions = await this.prisma.chemicalistPermission.findMany({
      where: { id: { in: rolePermissions.map((row) => row.permissionId) } },
      orderBy: { key: 'asc' },
    });
    return [...new Set(permissions.map((permission) => permission.key))];
  }

  async permissionsForUser(
    userId: string,
    actor: RequestIdentity,
  ): Promise<string[]> {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    this.assertTenantAccess(user.tenantId, actor);
    return this.permissionsOf(userId);
  }

  async principalOf(user: UserRecord): Promise<Principal> {
    return {
      userId: user.id,
      email: user.email,
      tenantId: user.tenantId ?? undefined,
      isPlatformAdmin: user.isPlatformAdmin,
      roles: await this.roleKeysOf(user.id),
    };
  }

  async assignRole(
    userId: string,
    roleKey: string,
    actor?: RequestIdentity,
  ): Promise<void> {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    if (actor) this.assertTenantAccess(user.tenantId, actor);
    const role =
      (await this.prisma.chemicalistRole.findFirst({
        where: { key: roleKey, tenantId: user.tenantId },
      })) ??
      (user.tenantId
        ? await this.prisma.chemicalistRole.findFirst({
            where: { key: roleKey, tenantId: null },
          })
        : null);
    if (!role) throw new NotFoundException({ code: 'ROLE_NOT_FOUND', message: 'Role not found' });
    await this.prisma.chemicalistUserRole.upsert({
      where: { userId_roleId: { userId, roleId: role.id } },
      update: {},
      create: { userId, roleId: role.id, tenantId: user.tenantId },
    });
  }

  async revokeRole(
    userId: string,
    roleKey: string,
    actor: RequestIdentity,
  ): Promise<void> {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    this.assertTenantAccess(user.tenantId, actor);
    const role =
      (await this.prisma.chemicalistRole.findFirst({
        where: { key: roleKey, tenantId: user.tenantId },
      })) ??
      (user.tenantId
        ? await this.prisma.chemicalistRole.findFirst({
            where: { key: roleKey, tenantId: null },
          })
        : null);
    if (!role) throw new NotFoundException({ code: 'ROLE_NOT_FOUND', message: 'Role not found' });
    await this.prisma.chemicalistUserRole.deleteMany({
      where: { userId, roleId: role.id, tenantId: user.tenantId },
    });
  }

  async assignRoleGroup(
    userId: string,
    groupKey: string,
    actor: RequestIdentity,
  ): Promise<void> {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    this.assertTenantAccess(user.tenantId, actor);
    const group =
      (await this.prisma.chemicalistRoleGroup.findFirst({
        where: { key: groupKey, tenantId: user.tenantId },
      })) ??
      (user.tenantId
        ? await this.prisma.chemicalistRoleGroup.findFirst({
            where: { key: groupKey, tenantId: null },
          })
        : null);
    if (!group) {
      throw new NotFoundException({ code: 'ROLE_GROUP_NOT_FOUND', message: 'Role group not found' });
    }
    await this.prisma.chemicalistUserRoleGroup.upsert({
      where: { userId_roleGroupId: { userId, roleGroupId: group.id } },
      update: {},
      create: { userId, roleGroupId: group.id, tenantId: user.tenantId },
    });
  }

  async revokeRoleGroup(
    userId: string,
    groupKey: string,
    actor: RequestIdentity,
  ): Promise<void> {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    this.assertTenantAccess(user.tenantId, actor);
    const group =
      (await this.prisma.chemicalistRoleGroup.findFirst({
        where: { key: groupKey, tenantId: user.tenantId },
      })) ??
      (user.tenantId
        ? await this.prisma.chemicalistRoleGroup.findFirst({
            where: { key: groupKey, tenantId: null },
          })
        : null);
    if (!group) {
      throw new NotFoundException({ code: 'ROLE_GROUP_NOT_FOUND', message: 'Role group not found' });
    }
    await this.prisma.chemicalistUserRoleGroup.deleteMany({
      where: { userId, roleGroupId: group.id, tenantId: user.tenantId },
    });
  }

  async ensureRoleGroup(
    tenantId: string | null,
    key: string,
    name: string,
    roleKeys: string[],
  ): Promise<string> {
    const existing = await this.prisma.chemicalistRoleGroup.findFirst({
      where: { key, tenantId },
    });
    const group =
      existing ??
      (await this.prisma.chemicalistRoleGroup.create({
        data: { tenantId, key, name, isSystem: false },
      }));
    const availableRoles = await this.prisma.chemicalistRole.findMany({
      where: { key: { in: roleKeys }, OR: [{ tenantId }, { tenantId: null }] },
    });
    const roles = [...new Set(roleKeys)].map(
      (roleKey) =>
        availableRoles.find(
          (role) => role.key === roleKey && role.tenantId === tenantId,
        ) ??
        availableRoles.find(
          (role) => role.key === roleKey && role.tenantId === null,
        ),
    );
    if (roles.some((role) => !role)) {
      throw new BadRequestException({
        code: 'INVALID_ROLE_GROUP',
        message: 'One or more role keys are unknown or outside this tenant',
      });
    }
    if (roles.length) {
      await this.prisma.chemicalistRoleGroupRole.createMany({
        data: roles
          .filter((role): role is NonNullable<typeof role> => Boolean(role))
          .map((role) => ({ roleGroupId: group.id, roleId: role.id })),
        skipDuplicates: true,
      });
    }
    return group.id;
  }

  async replaceRoleGroupRoles(
    tenantId: string | null,
    groupKey: string,
    roleKeys: string[],
  ): Promise<void> {
    const group = await this.prisma.chemicalistRoleGroup.findFirst({
      where: { tenantId, key: groupKey },
    });
    if (!group) {
      throw new NotFoundException({ code: 'ROLE_GROUP_NOT_FOUND', message: 'Role group not found' });
    }
    if (group.isSystem) {
      throw new BadRequestException({
        code: 'SYSTEM_ROLE_GROUP_IMMUTABLE',
        message: 'Membership on system role groups cannot be replaced',
      });
    }
    const availableRoles = await this.prisma.chemicalistRole.findMany({
      where: { key: { in: roleKeys }, OR: [{ tenantId }, { tenantId: null }] },
    });
    const roles = [...new Set(roleKeys)].map(
      (roleKey) =>
        availableRoles.find(
          (role) => role.key === roleKey && role.tenantId === tenantId,
        ) ??
        availableRoles.find(
          (role) => role.key === roleKey && role.tenantId === null,
        ),
    );
    if (roles.some((role) => !role)) {
      throw new BadRequestException({
        code: 'INVALID_ROLE_GROUP',
        message: 'One or more role keys are unknown or outside this tenant',
      });
    }
    const selected = roles.filter(
      (role): role is NonNullable<typeof role> => Boolean(role),
    );
    await this.prisma.$transaction(async (transaction) => {
      await transaction.chemicalistRoleGroupRole.deleteMany({
        where: { roleGroupId: group.id },
      });
      if (selected.length) {
        await transaction.chemicalistRoleGroupRole.createMany({
          data: selected.map((role) => ({ roleGroupId: group.id, roleId: role.id })),
        });
      }
    });
  }

  async ensurePermissionGroup(
    tenantId: string | null,
    key: string,
    name: string,
    permissionKeys: string[],
  ): Promise<string> {
    const existing = await this.prisma.chemicalistPermissionGroup.findFirst({
      where: { key, tenantId },
    });
    const group =
      existing ??
      (await this.prisma.chemicalistPermissionGroup.create({
        data: { tenantId, key, name, isSystem: false },
      }));
    const permissions = await this.prisma.chemicalistPermission.findMany({
      where: { key: { in: permissionKeys } },
    });
    if (permissions.length !== new Set(permissionKeys).size) {
      throw new BadRequestException({
        code: 'INVALID_PERMISSION_GROUP',
        message: 'One or more permission keys are unknown',
      });
    }
    if (permissions.length) {
      await this.prisma.chemicalistPermissionGroupPermission.createMany({
        data: permissions.map((permission) => ({
          permissionGroupId: group.id,
          permissionId: permission.id,
        })),
        skipDuplicates: true,
      });
    }
    return group.id;
  }

  async replacePermissionGroupPermissions(
    tenantId: string | null,
    groupKey: string,
    permissionKeys: string[],
  ): Promise<void> {
    const group = await this.prisma.chemicalistPermissionGroup.findFirst({
      where: { tenantId, key: groupKey },
    });
    if (!group) {
      throw new NotFoundException({
        code: 'PERMISSION_GROUP_NOT_FOUND',
        message: 'Permission group not found',
      });
    }
    if (group.isSystem) {
      throw new BadRequestException({
        code: 'SYSTEM_PERMISSION_GROUP_IMMUTABLE',
        message: 'Membership on system permission groups cannot be replaced',
      });
    }
    const permissions = await this.prisma.chemicalistPermission.findMany({
      where: { key: { in: permissionKeys } },
    });
    if (permissions.length !== new Set(permissionKeys).size) {
      throw new BadRequestException({
        code: 'INVALID_PERMISSION_GROUP',
        message: 'One or more permission keys are unknown',
      });
    }
    await this.prisma.$transaction(async (transaction) => {
      await transaction.chemicalistPermissionGroupPermission.deleteMany({
        where: { permissionGroupId: group.id },
      });
      if (permissions.length) {
        await transaction.chemicalistPermissionGroupPermission.createMany({
          data: permissions.map((permission) => ({
            permissionGroupId: group.id,
            permissionId: permission.id,
          })),
        });
      }
    });
  }

  async grantPermissionGroup(
    roleKey: string,
    groupKey: string,
    tenantId: string | null,
  ): Promise<void> {
    const role =
      (await this.prisma.chemicalistRole.findFirst({
        where: { key: roleKey, tenantId },
      })) ??
      (tenantId
        ? await this.prisma.chemicalistRole.findFirst({
            where: { key: roleKey, tenantId: null },
          })
        : null);
    const group =
      (await this.prisma.chemicalistPermissionGroup.findFirst({
        where: { key: groupKey, tenantId },
      })) ??
      (tenantId
        ? await this.prisma.chemicalistPermissionGroup.findFirst({
            where: { key: groupKey, tenantId: null },
          })
        : null);
    if (!role) throw new NotFoundException({ code: 'ROLE_NOT_FOUND', message: 'Role not found' });
    if (!group) {
      throw new NotFoundException({ code: 'PERMISSION_GROUP_NOT_FOUND', message: 'Permission group not found' });
    }
    const members = await this.prisma.chemicalistPermissionGroupPermission.findMany({
      where: { permissionGroupId: group.id },
    });
    if (members.length) {
      await this.prisma.chemicalistRolePermission.createMany({
        data: members.map((member) => ({
          roleId: role.id,
          permissionId: member.permissionId,
        })),
        skipDuplicates: true,
      });
    }
  }

  async ensureRole(
    tenantId: string | null,
    key: string,
    name: string,
    permissionKeys: string[],
  ): Promise<string> {
    const existing = await this.prisma.chemicalistRole.findFirst({
      where: { key, tenantId },
    });
    const role =
      existing ??
      (await this.prisma.chemicalistRole.create({
        data: { key, name, tenantId, isSystem: true },
      }));
    const permissions = await this.prisma.chemicalistPermission.findMany({
      where: { key: { in: permissionKeys } },
    });
    if (permissions.length) {
      await this.prisma.chemicalistRolePermission.createMany({
        data: permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id })),
        skipDuplicates: true,
      });
    }
    return role.id;
  }

  async createRole(
      tenantId: string | null,
      key: string,
      name: string,
      permissionKeys: string[],
    ): Promise<string> {
      const existing = await this.prisma.chemicalistRole.findFirst({
        where: { tenantId, key },
      });
      if (existing) {
        throw new ConflictException({ code: 'ROLE_EXISTS', message: 'Role key already exists' });
      }
      const permissions = await this.prisma.chemicalistPermission.findMany({
        where: { key: { in: permissionKeys } },
      });
      if (permissions.length !== new Set(permissionKeys).size) {
        throw new BadRequestException({
          code: 'INVALID_PERMISSIONS',
          message: 'One or more permission keys are unknown',
        });
      }
      const role = await this.prisma.$transaction(async (transaction) => {
        const created = await transaction.chemicalistRole.create({
          data: { tenantId, key, name, isSystem: false },
        });
        if (permissions.length) {
          await transaction.chemicalistRolePermission.createMany({
            data: permissions.map((permission) => ({
              roleId: created.id,
              permissionId: permission.id,
            })),
          });
        }
        return created;
      });
      return role.id;
    }

  async replaceRolePermissions(
      tenantId: string | null,
      roleKey: string,
      permissionKeys: string[],
    ): Promise<void> {
      const role = await this.prisma.chemicalistRole.findFirst({
        where: { tenantId, key: roleKey },
      });
      if (!role) throw new NotFoundException({ code: 'ROLE_NOT_FOUND', message: 'Role not found' });
      if (role.isSystem) {
        throw new BadRequestException({
          code: 'SYSTEM_ROLE_IMMUTABLE',
          message: 'Permissions on system roles cannot be replaced',
        });
      }
      const permissions = await this.prisma.chemicalistPermission.findMany({
        where: { key: { in: permissionKeys } },
      });
      if (permissions.length !== new Set(permissionKeys).size) {
        throw new BadRequestException({
          code: 'INVALID_PERMISSIONS',
          message: 'One or more permission keys are unknown',
        });
      }
      await this.prisma.$transaction(async (transaction) => {
        await transaction.chemicalistRolePermission.deleteMany({
          where: { roleId: role.id },
        });
        if (permissions.length) {
          await transaction.chemicalistRolePermission.createMany({
            data: permissions.map((permission) => ({
              roleId: role.id,
              permissionId: permission.id,
            })),
          });
        }
      });
    }

  listPermissions() {
    return this.prisma.chemicalistPermission.findMany({
      orderBy: { key: 'asc' },
    });
  }

  /**
   * Creates the permission catalogue, the bootstrap tenant and the bootstrap
   * administrator. Without BOOTSTRAP_USER_EMAIL/PASSWORD no user is created, but
   * the permission catalogue and the tenant still exist.
   */
  async bootstrap(): Promise<void> {
    for (const key of ALL_PERMISSION_KEYS) {
      await this.prisma.chemicalistPermission.upsert({
        where: { key },
        update: {},
        create: { key },
      });
    }

    const tenantSlug = this.config.get<string>('BOOTSTRAP_TENANT_SLUG') ?? 'default';
    const tenantName = this.config.get<string>('BOOTSTRAP_TENANT_NAME') ?? 'Default Tenant';
    const tenant = await this.prisma.chemicalistTenant.upsert({
      where: { slug: tenantSlug },
      update: {},
      create: { slug: tenantSlug, name: tenantName },
    });

    const email = this.config.get<string>('BOOTSTRAP_USER_EMAIL');
    const password = this.config.get<string>('BOOTSTRAP_USER_PASSWORD');
    if (!email || !password) {
      this.logger.warn(
        'No BOOTSTRAP_USER_EMAIL/BOOTSTRAP_USER_PASSWORD configured: no administrator was created.',
      );
      return;
    }

    const user = await this.prisma.chemicalistUser.upsert({
      where: { email: email.toLowerCase() },
      update: { username: 'admin', isPlatformAdmin: true, tenantId: tenant.id },
      create: {
        email: email.toLowerCase(),
        username: 'admin',
        passwordHash: await hash(password, BCRYPT_ROUNDS),
        tenantId: tenant.id,
        isPlatformAdmin: true,
        displayName: 'Bootstrap Administrator',
      },
    });

    const credential = await this.prisma.chemicalistUserCredential.findFirst({
      where: { userId: user.id, type: 'PASSWORD' },
    });
    if (credential) {
      await this.prisma.chemicalistUserCredential.update({
        where: { id: credential.id },
        data: { identifier: user.email, secretHash: user.passwordHash },
      });
    } else {
      await this.prisma.chemicalistUserCredential.create({
        data: {
          userId: user.id,
          type: 'PASSWORD',
          provider: 'local',
          identifier: user.email,
          secretHash: user.passwordHash,
        },
      });
    }

    await this.ensureRole(tenant.id, 'admin', 'Administrator', [...ALL_PERMISSION_KEYS]);
    await this.assignRole(user.id, 'admin');
    this.logger.log('Bootstrap administrator ensured: ' + user.email);
  }
}
`,
    controller: `import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
    import { CurrentIdentity } from '../security/current-identity.decorator';
    import type { RequestIdentity } from '../../shared/context/request-context';
import { RequirePermission } from '../authorization/permissions';
import { IdentityService } from './identity.service';

const CreateUserSchema = z.object({
  email: z.string().email(),
  username: z.string().min(1).max(100).optional(),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(200).optional(),
  tenantId: z.string().min(1).max(100).optional(),
}).strict();

const AssignRoleSchema = z.object({
  roleKey: z.string().min(1).max(100),
});

const AssignRoleGroupSchema = z.object({
  roleGroupKey: z.string().min(1).max(100),
});

const CreateRoleSchema = z.object({
  key: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  permissionKeys: z.array(z.string().min(1).max(200)).default([]),
}).strict();

const ReplaceRolePermissionsSchema = z.object({
  permissionKeys: z.array(z.string().min(1).max(200)),
}).strict();

const CreateRoleGroupSchema = z.object({
  key: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  roleKeys: z.array(z.string().min(1).max(100)).min(1),
}).strict();

const CreatePermissionGroupSchema = z.object({
  key: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  permissionKeys: z.array(z.string().min(1).max(200)).min(1),
}).strict();

const ReplaceRoleGroupRolesSchema = z.object({
  roleKeys: z.array(z.string().min(1).max(100)),
}).strict();

const ReplacePermissionGroupPermissionsSchema = z.object({
  permissionKeys: z.array(z.string().min(1).max(200)),
}).strict();

const UpdateProfileSchema = z.object({
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  phone: z.string().max(40).optional(),
  avatarUrl: z.string().url().max(2048).optional(),
  locale: z.string().max(20).optional(),
  timeZone: z.string().max(80).optional(),
}).strict();

const RegisterDeviceSchema = z.object({
  deviceKey: z.string().min(1).max(200),
  name: z.string().max(200).optional(),
  platform: z.string().max(80).optional(),
  userAgent: z.string().max(500).optional(),
}).strict();

class CreateUserDto extends createZodDto(CreateUserSchema) {}
class AssignRoleDto extends createZodDto(AssignRoleSchema) {}
class AssignRoleGroupDto extends createZodDto(AssignRoleGroupSchema) {}
class CreateRoleDto extends createZodDto(CreateRoleSchema) {}
class ReplaceRolePermissionsDto extends createZodDto(ReplaceRolePermissionsSchema) {}
class CreateRoleGroupDto extends createZodDto(CreateRoleGroupSchema) {}
class CreatePermissionGroupDto extends createZodDto(CreatePermissionGroupSchema) {}
class ReplaceRoleGroupRolesDto extends createZodDto(ReplaceRoleGroupRolesSchema) {}
class ReplacePermissionGroupPermissionsDto extends createZodDto(ReplacePermissionGroupPermissionsSchema) {}
class UpdateProfileDto extends createZodDto(UpdateProfileSchema) {}
class RegisterDeviceDto extends createZodDto(RegisterDeviceSchema) {}

@Controller('platform/identity')
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  private tenantScope(actor: RequestIdentity, requestedTenantId?: string): string | null {
    return actor.isPlatformAdmin
      ? requestedTenantId || actor.tenantId || null
      : actor.tenantId ?? null;
  }

  @Get('users')
  @RequirePermission('platform.identity:read')
  listUsers(
    @Query('tenantId') tenantId: string | undefined,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.identity.listUsers(tenantId, actor);
  }

  @Post('users')
  @RequirePermission('platform.identity:write')
  createUser(
    @Body() body: CreateUserDto,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.identity.createUser(body, actor);
  }

  @Post('users/:id/roles')
  @RequirePermission('platform.identity:write')
  assignRole(
    @Param('id') id: string,
    @Body() body: AssignRoleDto,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.identity.assignRole(id, body.roleKey, actor);
  }

  @Delete('users/:id/roles/:roleKey')
  @RequirePermission('platform.identity:write')
  revokeRole(
    @Param('id') id: string,
    @Param('roleKey') roleKey: string,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.identity.revokeRole(id, roleKey, actor);
  }

  @Post('users/:id/role-groups')
  @RequirePermission('platform.authorization:write')
  assignRoleGroup(
    @Param('id') id: string,
    @Body() body: AssignRoleGroupDto,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.identity.assignRoleGroup(id, body.roleGroupKey, actor);
  }

  @Delete('users/:id/role-groups/:groupKey')
  @RequirePermission('platform.authorization:write')
  revokeRoleGroup(
    @Param('id') id: string,
    @Param('groupKey') groupKey: string,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.identity.revokeRoleGroup(id, groupKey, actor);
  }

  @Get('users/:id/profile')
  @RequirePermission('platform.identity:read')
  profile(@Param('id') id: string, @CurrentIdentity() actor: RequestIdentity) {
    return this.identity.profileOf(id, actor);
  }

  @Post('users/:id/profile')
  @RequirePermission('platform.identity:write')
  updateProfile(
    @Param('id') id: string,
    @Body() body: UpdateProfileDto,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.identity.updateProfile(id, body, actor);
  }

  @Post('users/:id/devices')
  @RequirePermission('platform.identity:write')
  registerDevice(
    @Param('id') id: string,
    @Body() body: RegisterDeviceDto,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.identity.registerDevice(id, body, actor);
  }

  @Post('users/:id/devices/:deviceId/revoke')
  @RequirePermission('platform.identity:write')
  revokeDevice(
    @Param('id') id: string,
    @Param('deviceId') deviceId: string,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.identity.revokeDevice(id, deviceId, actor);
  }

  @Get('roles')
  @RequirePermission('platform.authorization:read')
  roles(
    @Query('tenantId') tenantId: string | undefined,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.identity.listRoles(
      actor.isPlatformAdmin ? tenantId : actor.tenantId,
      actor.isPlatformAdmin,
    );
  }

  @Post('roles')
  @RequirePermission('platform.authorization:write')
  createRole(
    @Body() body: CreateRoleDto,
    @Query('tenantId') requestedTenantId: string | undefined,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.identity.createRole(
      this.tenantScope(actor, requestedTenantId),
      body.key,
      body.name,
      body.permissionKeys,
    );
  }

  @Get('permissions')
  @RequirePermission('platform.authorization:read')
  permissionsCatalog() {
    return this.identity.listPermissions();
  }

  @Put('roles/:roleKey/permissions')
  @RequirePermission('platform.authorization:write')
  replaceRolePermissions(
    @Param('roleKey') roleKey: string,
    @Body() body: ReplaceRolePermissionsDto,
    @Query('tenantId') requestedTenantId: string | undefined,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.identity.replaceRolePermissions(
      this.tenantScope(actor, requestedTenantId),
      roleKey,
      body.permissionKeys,
    );
  }

  @Get('role-groups')
  @RequirePermission('platform.authorization:read')
  roleGroups(
    @Query('tenantId') tenantId: string | undefined,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.identity.listRoleGroups(
      actor.isPlatformAdmin ? tenantId : actor.tenantId,
      actor.isPlatformAdmin,
    );
  }

  @Post('role-groups')
  @RequirePermission('platform.authorization:write')
  createRoleGroup(
    @Body() body: CreateRoleGroupDto,
    @Query('tenantId') requestedTenantId: string | undefined,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.identity.ensureRoleGroup(
      this.tenantScope(actor, requestedTenantId),
      body.key,
      body.name,
      body.roleKeys,
    );
  }

  @Put('role-groups/:groupKey/roles')
  @RequirePermission('platform.authorization:write')
  replaceRoleGroupRoles(
    @Param('groupKey') groupKey: string,
    @Body() body: ReplaceRoleGroupRolesDto,
    @Query('tenantId') requestedTenantId: string | undefined,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.identity.replaceRoleGroupRoles(
      this.tenantScope(actor, requestedTenantId),
      groupKey,
      body.roleKeys,
    );
  }

  @Get('permission-groups')
  @RequirePermission('platform.authorization:read')
  permissionGroups(
    @Query('tenantId') tenantId: string | undefined,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.identity.listPermissionGroups(
      actor.isPlatformAdmin ? tenantId : actor.tenantId,
      actor.isPlatformAdmin,
    );
  }

  @Post('permission-groups')
  @RequirePermission('platform.authorization:write')
  createPermissionGroup(
    @Body() body: CreatePermissionGroupDto,
    @Query('tenantId') requestedTenantId: string | undefined,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.identity.ensurePermissionGroup(
      this.tenantScope(actor, requestedTenantId),
      body.key,
      body.name,
      body.permissionKeys,
    );
  }

  @Put('permission-groups/:groupKey/permissions')
  @RequirePermission('platform.authorization:write')
  replacePermissionGroupPermissions(
    @Param('groupKey') groupKey: string,
    @Body() body: ReplacePermissionGroupPermissionsDto,
    @Query('tenantId') requestedTenantId: string | undefined,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.identity.replacePermissionGroupPermissions(
      this.tenantScope(actor, requestedTenantId),
      groupKey,
      body.permissionKeys,
    );
  }

  @Post('roles/:roleKey/permission-groups/:groupKey')
  @RequirePermission('platform.authorization:write')
  grantPermissionGroup(
    @Param('roleKey') roleKey: string,
    @Param('groupKey') groupKey: string,
    @Query('tenantId') requestedTenantId: string | undefined,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.identity.grantPermissionGroup(
      roleKey,
      groupKey,
      this.tenantScope(actor, requestedTenantId),
    );
  }

  @Get('users/:id/permissions')
  @RequirePermission('platform.identity:read')
  permissions(
    @Param('id') id: string,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.identity.permissionsForUser(id, actor);
  }
}
`,
    module: `import { Global, Module } from '@nestjs/common';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';

/** Global: authorization, audit and every studio need the identity owner. */
@Global()
@Module({
  controllers: [IdentityController],
  providers: [IdentityService],
  exports: [IdentityService],
})
export class IdentityModule {}
`,
  };
}

function securityFiles() {
  return {
    publicDecorator: `import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'chemicalist:public';

/**
 * Marks a route as explicitly public. Every other route requires a valid access
 * token: authentication is on by default, opt-out must be deliberate.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
`,
    tokenService: `import { Injectable } from '@nestjs/common';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import type { Principal } from '../identity/identity.types';

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  email: string;
  roles: string[];
  tenantId?: string;
  adm: boolean;
}

export interface RefreshToken {
  token: string;
  hash: string;
  expiresAt: Date;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** Issues a signed access token carrying identity, tenant and admin flag. */
  async issueAccess(
    principal: Principal,
    sessionId: string,
  ): Promise<{ accessToken: string; expiresIn: string }> {
    const expiresIn = this.config.get<string>('JWT_EXPIRES_IN') ?? '1h';
    const options: JwtSignOptions = {
      secret: this.config.get<string>('JWT_SECRET'),
      expiresIn: expiresIn as JwtSignOptions['expiresIn'],
    };
    const claims: AccessTokenClaims = {
      sub: principal.userId,
      sid: sessionId,
      email: principal.email,
      roles: principal.roles,
      tenantId: principal.tenantId,
      adm: principal.isPlatformAdmin,
    };
    return { accessToken: await this.jwt.signAsync(claims, options), expiresIn };
  }

  async verifyAccess(token: string): Promise<AccessTokenClaims> {
    const payload = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
      secret: this.config.get<string>('JWT_SECRET'),
    });
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.sid !== 'string' ||
      !Array.isArray(payload.roles)
    ) {
      throw new Error('Malformed token payload');
    }
    return {
      sub: payload.sub,
      sid: payload.sid,
      email: typeof payload.email === 'string' ? payload.email : '',
      roles: payload.roles.filter((role): role is string => typeof role === 'string'),
      tenantId: typeof payload.tenantId === 'string' ? payload.tenantId : undefined,
      adm: payload.adm === true,
    };
  }

  createRefreshToken(): RefreshToken {
    const ttlDays = this.config.get<number>('REFRESH_TOKEN_TTL_DAYS') ?? 30;
    const token = randomBytes(48).toString('base64url');
    return {
      token,
      hash: TokenService.hashRefreshToken(token),
      expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
    };
  }

  static hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
`,
    jwtGuard: `import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RequestContext } from '../../shared/context/request-context';
import { IS_PUBLIC_KEY } from './public.decorator';
import { IdentityService } from '../identity/identity.service';
import { TokenService, type AccessTokenClaims } from './token.service';
import { AuditService } from '../audit/audit.service';

interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    email: string;
    roles: string[];
    tenantId?: string;
    isPlatformAdmin: boolean;
    requestId: string;
    sessionId: string;
  };
}

/**
 * Global authentication guard. Verifies the bearer token, publishes the identity
 * into AsyncLocalStorage (so repositories can read the tenant) and rejects
 * everything that is not explicitly marked @Public().
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly identity: IdentityService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      await this.audit.record({
        action: request.method + ' ' + request.path,
        resourceType: request.route?.path ?? null,
        ip: request.ip ?? null,
        userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
        requestId: typeof request.headers['x-request-id'] === 'string' ? request.headers['x-request-id'] : null,
        outcome: 'DENIED',
        metadata: { reason: 'MISSING_BEARER_TOKEN' },
      });
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Missing bearer token' });
    }

    let claims: AccessTokenClaims;
    try {
      claims = await this.tokens.verifyAccess(header.slice('Bearer '.length).trim());
    } catch {
      await this.audit.record({
        action: request.method + ' ' + request.path,
        resourceType: request.route?.path ?? null,
        ip: request.ip ?? null,
        userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
        requestId: typeof request.headers['x-request-id'] === 'string' ? request.headers['x-request-id'] : null,
        outcome: 'DENIED',
        metadata: { reason: 'INVALID_ACCESS_TOKEN' },
      });
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Invalid or expired token' });
    }

    const principal = await this.identity.activeSessionIdentity(claims.sub, claims.sid);
    if (!principal) {
      await this.audit.record({
        action: request.method + ' ' + request.path,
        resourceType: request.route?.path ?? null,
        ip: request.ip ?? null,
        userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
        requestId: typeof request.headers['x-request-id'] === 'string' ? request.headers['x-request-id'] : null,
        outcome: 'DENIED',
        metadata: { reason: 'INACTIVE_ACCOUNT_OR_SESSION' },
      });
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Account or session is no longer active' });
    }

    const identity = {
      userId: principal.userId,
      email: principal.email,
      roles: principal.roles,
      tenantId: principal.tenantId,
      isPlatformAdmin: principal.isPlatformAdmin,
      requestId: String(request.headers['x-request-id'] ?? ''),
      sessionId: claims.sid,
    };
    request.user = identity;
    RequestContext.assign(identity);
    return true;
  }
}
`,
    authService: `import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { compare } from 'bcryptjs';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { IdentityService } from '../../identity/identity.service';
import { TokenService } from '../token.service';

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: IdentityService,
    private readonly tokens: TokenService,
  ) {}

  /** Creates the permission catalogue, bootstrap tenant and administrator. */
  async bootstrap(): Promise<void> {
    await this.identity.bootstrap();
  }

  verifyEmail(token: string) {
    return this.identity.verifyEmailToken(token);
  }

  verifyMobile(token: string) {
    return this.identity.verifyMobileToken(token);
  }

  async login(
    identifier: string,
    password: string,
    client: { ip?: string; userAgent?: string } = {},
  ): Promise<LoginResult> {
    const user = await this.identity.findByIdentifier(identifier);
    if (!user || user.status !== 'ACTIVE' || !(await compare(password, user.passwordHash))) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }

    const principal = await this.identity.principalOf(user);
    const refresh = this.tokens.createRefreshToken();
    const session = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.chemicalistUserSession.create({
        data: {
          userId: user.id,
          expiresAt: refresh.expiresAt,
          ip: client.ip ?? null,
          userAgent: client.userAgent ?? null,
        },
      });
      await transaction.chemicalistRefreshToken.create({
        data: {
          userId: user.id,
          sessionId: created.id,
          tokenHash: refresh.hash,
          expiresAt: refresh.expiresAt,
        },
      });
      await transaction.chemicalistUser.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });
      return created;
    });
    const access = await this.tokens.issueAccess(principal, session.id);

    return {
      accessToken: access.accessToken,
      refreshToken: refresh.token,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
    };
  }

  /** Rotates the refresh token: the presented token is revoked, a new one is issued. */
  async refresh(refreshToken: string): Promise<LoginResult> {
    const hash = TokenService.hashRefreshToken(refreshToken);
    const storedToken = await this.prisma.chemicalistRefreshToken.findUnique({
      where: { tokenHash: hash },
    });
    if (!storedToken || storedToken.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException({
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Refresh token is invalid or expired',
      });
    }
    if (storedToken.revokedAt) {
      await this.prisma.$transaction([
        this.prisma.chemicalistRefreshToken.updateMany({
          where: { sessionId: storedToken.sessionId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
        this.prisma.chemicalistUserSession.updateMany({
          where: { id: storedToken.sessionId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);
      throw new UnauthorizedException({
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Refresh token reuse detected; session revoked',
      });
    }

    const session = await this.prisma.chemicalistUserSession.findUnique({
      where: { id: storedToken.sessionId },
    });
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException({
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Session is invalid or expired',
      });
    }

    const user = await this.identity.findById(storedToken.userId);
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException({ code: 'ACCOUNT_DISABLED', message: 'Account is not active' });
    }

    const principal = await this.identity.principalOf(user);
    const access = await this.tokens.issueAccess(principal, session.id);
    const next = this.tokens.createRefreshToken();
    const now = new Date();
    const rotated = await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.chemicalistRefreshToken.updateMany({
        where: {
          id: storedToken.id,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { revokedAt: now },
      });
      if (claimed.count !== 1) return false;
      const replacement = await transaction.chemicalistRefreshToken.create({
        data: {
          userId: user.id,
          sessionId: session.id,
          tokenHash: next.hash,
          expiresAt: next.expiresAt,
        },
      });
      await transaction.chemicalistRefreshToken.update({
        where: { id: storedToken.id },
        data: { replacedById: replacement.id },
      });
      await transaction.chemicalistUserSession.update({
        where: { id: session.id },
        data: { lastSeenAt: now, expiresAt: next.expiresAt },
      });
      return true;
    });
    if (!rotated) {
      const revokedAt = new Date();
      await this.prisma.$transaction([
        this.prisma.chemicalistRefreshToken.updateMany({
          where: { sessionId: storedToken.sessionId, revokedAt: null },
          data: { revokedAt },
        }),
        this.prisma.chemicalistUserSession.updateMany({
          where: { id: storedToken.sessionId, revokedAt: null },
          data: { revokedAt },
        }),
      ]);
      throw new UnauthorizedException({
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Refresh token was already used',
      });
    }

    return {
      accessToken: access.accessToken,
      refreshToken: next.token,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
    };
  }

  async logout(refreshToken: string, userId: string): Promise<{ revoked: true }> {
    const hash = TokenService.hashRefreshToken(refreshToken);
    const storedToken = await this.prisma.chemicalistRefreshToken.findUnique({
      where: { tokenHash: hash },
    });
    if (storedToken && storedToken.userId === userId) {
      const revokedAt = new Date();
      await this.prisma.$transaction([
        this.prisma.chemicalistRefreshToken.updateMany({
          where: { sessionId: storedToken.sessionId, revokedAt: null },
          data: { revokedAt },
        }),
        this.prisma.chemicalistUserSession.updateMany({
          where: { id: storedToken.sessionId, revokedAt: null },
          data: { revokedAt },
        }),
      ]);
    }
    return { revoked: true };
  }

  async listSessions(userId: string, currentSessionId?: string) {
    const sessions = await this.prisma.chemicalistUserSession.findMany({
      where: { userId },
      select: {
        id: true,
        deviceId: true,
        userAgent: true,
        ip: true,
        expiresAt: true,
        lastSeenAt: true,
        revokedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return sessions.map((session) => ({
      ...session,
      isCurrent: session.id === currentSessionId,
    }));
  }

  async revokeSession(userId: string, sessionId: string): Promise<{ revoked: true }> {
    const session = await this.prisma.chemicalistUserSession.findFirst({
      where: { id: sessionId, userId },
      select: { id: true },
    });
    if (!session) {
      throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Session not found' });
    }
    const revokedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.chemicalistRefreshToken.updateMany({
        where: { sessionId, userId, revokedAt: null },
        data: { revokedAt },
      }),
      this.prisma.chemicalistUserSession.updateMany({
        where: { id: sessionId, userId, revokedAt: null },
        data: { revokedAt },
      }),
    ]);
    return { revoked: true };
  }

  async logoutAll(userId: string): Promise<{ revoked: true }> {
    const revokedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.chemicalistRefreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt },
      }),
      this.prisma.chemicalistUserSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt },
      }),
    ]);
    return { revoked: true };
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ changed: true }> {
    const user = await this.identity.findById(userId);
    if (!user || !(await compare(currentPassword, user.passwordHash))) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Current password is incorrect',
      });
    }
    await this.identity.setPassword(userId, newPassword);
    return { changed: true };
  }

  async me(userId: string) {
    const user = await this.identity.findById(userId);
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        tenantId: user.tenantId,
        status: user.status,
        isPlatformAdmin: user.isPlatformAdmin,
      },
      roles: await this.identity.roleKeysOf(user.id),
      permissions: await this.identity.permissionsOf(user.id),
    };
  }
}
`,
    authController: `import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { CurrentIdentity } from '../current-identity.decorator';
import { Public } from '../public.decorator';
import type { RequestIdentity } from '../../../shared/context/request-context';
import { AuthService } from './auth.service';

const LoginSchema = z.object({
  identifier: z.string().min(1).max(320).optional(),
  username: z.string().min(1).max(100).optional(),
  email: z.string().email().optional(),
  password: z.string().min(8),
}).strict().refine((value) => Boolean(value.identifier || value.username || value.email), {
  message: 'username, email or identifier is required',
});

const RefreshSchema = z.object({
  refreshToken: z.string().min(20),
});

const VerificationTokenSchema = z.object({
  token: z.string().min(6).max(200),
}).strict();
const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(8).max(200),
  newPassword: z.string().min(12).max(200),
}).strict();

class LoginDto extends createZodDto(LoginSchema) {}
class RefreshDto extends createZodDto(RefreshSchema) {}
class VerificationTokenDto extends createZodDto(VerificationTokenSchema) {}
class ChangePasswordDto extends createZodDto(ChangePasswordSchema) {}

@Controller('platform/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() body: LoginDto, @Req() request: Request) {
    return this.auth.login(
      body.identifier ?? body.username ?? body.email!,
      body.password,
      {
        ip: request.ip,
        userAgent: typeof request.headers['user-agent'] === 'string'
          ? request.headers['user-agent']
          : undefined,
      },
    );
  }

  @Public()
  @Post('refresh')
  refresh(@Body() body: RefreshDto) {
    return this.auth.refresh(body.refreshToken);
  }

  @Public()
  @Post('verify-email')
  verifyEmail(@Body() body: VerificationTokenDto) {
    return this.auth.verifyEmail(body.token);
  }

  @Public()
  @Post('verify-mobile')
  verifyMobile(@Body() body: VerificationTokenDto) {
    return this.auth.verifyMobile(body.token);
  }

  @Post('logout')
  logout(
    @Body() body: RefreshDto,
    @CurrentIdentity() identity: RequestIdentity,
  ) {
    return this.auth.logout(body.refreshToken, identity.userId);
  }

  @Get('sessions')
  sessions(@CurrentIdentity() identity: RequestIdentity) {
    return this.auth.listSessions(identity.userId, identity.sessionId);
  }

  @Delete('sessions/:sessionId')
  revokeSession(
    @Param('sessionId') sessionId: string,
    @CurrentIdentity() identity: RequestIdentity,
  ) {
    return this.auth.revokeSession(identity.userId, sessionId);
  }

  @Post('logout-all')
  logoutAll(@CurrentIdentity() identity: RequestIdentity) {
    return this.auth.logoutAll(identity.userId);
  }

  @Post('change-password')
  changePassword(
    @Body() body: ChangePasswordDto,
    @CurrentIdentity() identity: RequestIdentity,
  ) {
    return this.auth.changePassword(
      identity.userId,
      body.currentPassword,
      body.newPassword,
    );
  }

  @Get('me')
  me(@CurrentIdentity() identity: RequestIdentity) {
    return this.auth.me(identity.userId);
  }
}
`,
    currentIdentityDecorator: `import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { RequestIdentity } from '../../shared/context/request-context';

/** Injects the verified identity resolved by the global authentication guard. */
export const CurrentIdentity = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestIdentity => {
    const request = context.switchToHttp().getRequest<Request & { user?: RequestIdentity }>();
    if (!request.user) {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'No identity' });
    }
    return request.user;
  },
);
`,
    module: `import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { IdentityModule } from '../identity/identity.module';
import { AuditModule } from '../audit/audit.module';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokenService } from './token.service';

/**
 * Authentication owner. The authentication guard is global: every route needs a
 * valid access token unless it is marked @Public().
 */
@Global()
@Module({
  imports: [
    IdentityModule,
    AuditModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    TokenService,
    AuthService,
    JwtAuthGuard,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [TokenService, AuthService, JwtAuthGuard],
})
export class SecurityModule {}
`,
  };
}

function authorizationFiles() {
  return {
    permissions: `import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'chemicalist:required-permissions';

/**
 * Declares the permission(s) required to call a handler.
 *
 * Permissions are strings shaped '<lab>.<studio>.<resource>:<action>' for
 * business operations and 'platform.<area>:<action>' for platform operations.
 * Multiple permissions mean *all* of them are required.
 */
export const RequirePermission = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
`,
    policyService: `import { ForbiddenException, Injectable } from '@nestjs/common';
import { IdentityService } from '../identity/identity.service';

/**
 * Resource-level authorization.
 *
 * Guards answer "may this caller perform this kind of operation"; a use case
 * that mutates a specific record must additionally call this service when the
 * answer depends on the record (ownership, tenant, state).
 */
@Injectable()
export class PolicyService {
  constructor(private readonly identity: IdentityService) {}

  async can(userId: string, permission: string): Promise<boolean> {
    const granted = await this.identity.permissionsOf(userId);
    return granted.includes('*') || granted.includes(permission);
  }

  async assert(userId: string, permission: string): Promise<void> {
    if (!(await this.can(userId, permission))) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Missing permission: ' + permission,
      });
    }
  }
}
`,
    permissionGuard: `import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IdentityService } from '../identity/identity.service';
import { PERMISSIONS_KEY } from './permissions';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; tenantId?: string; roles: string[]; isPlatformAdmin: boolean };
}

import { AuditService } from '../audit/audit.service';

/**
 * Evaluates @RequirePermission metadata against the caller's effective
 * permissions. Having a role is never enough by itself.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identity: IdentityService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      await this.audit.record({
        action: request.method + ' ' + request.path,
        resourceType: request.route?.path ?? null,
        ip: request.ip ?? null,
        userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
        requestId: typeof request.headers['x-request-id'] === 'string' ? request.headers['x-request-id'] : null,
        outcome: 'DENIED',
        metadata: { reason: 'UNAUTHENTICATED', required },
      });
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'No identity' });
    }
    const granted = await this.identity.permissionsOf(request.user.userId);
    const allowed = required.every(
      (permission) => granted.includes('*') || granted.includes(permission),
    );
    if (!allowed) {
      await this.audit.record({
        tenantId: request.user.tenantId ?? null,
        actorId: request.user.userId,
        action: request.method + ' ' + request.path,
        resourceType: request.route?.path ?? null,
        ip: request.ip ?? null,
        userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
        requestId: typeof request.headers['x-request-id'] === 'string' ? request.headers['x-request-id'] : null,
        outcome: 'DENIED',
        metadata: { reason: 'FORBIDDEN', required },
      });
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Missing permission: ' + required.join(', '),
      });
    }
    return true;
  }
}
`,
    module: `import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { IdentityModule } from '../identity/identity.module';
import { AuditModule } from '../audit/audit.module';
import { PermissionGuard } from './permission.guard';
import { PolicyService } from './policy.service';

/** Authorization owner: permission guard (global) plus resource-level policy. */
@Global()
@Module({
  imports: [IdentityModule, AuditModule],
  providers: [
    PolicyService,
    PermissionGuard,
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
  exports: [PolicyService, PermissionGuard],
})
export class AuthorizationModule {}
`,
  };
}

function tenancyFiles() {
  return {
    tenantContext: `import { RequestContext } from '../../shared/context/request-context';
import { TenantScopeViolationError } from '../../shared/errors/domain.errors';

/**
 * Tenant context. The tenant always comes from the verified identity (token),
 * never from a header, query parameter or request body.
 */
export class TenantContext {
  static current(): string | undefined {
    return RequestContext.tenantId();
  }

  static require(): string {
    const tenantId = RequestContext.tenantId();
    if (!tenantId) throw new TenantScopeViolationError('Tenant context is required but missing');
    return tenantId;
  }
}
`,
    tenantGuard: `import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { TenantContext } from './tenant-context';

/**
 * Rejects requests that carry no verified tenant claim and blocks attempts to
 * override the tenant through headers, query string or body.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<
      Request & { user?: { tenantId?: string; isPlatformAdmin?: boolean }; body?: unknown }
    >();

    if (request.headers['x-tenant-id'] || request.headers['x-organization-id']) {
      throw new ForbiddenException({
        code: 'TENANT_SCOPE_VIOLATION',
        message: 'Tenant id must come from the access token',
      });
    }
    const body = request.body as { tenantId?: unknown } | undefined;
    if (body && Object.prototype.hasOwnProperty.call(body, 'tenantId')) {
      throw new ForbiddenException({
        code: 'TENANT_SCOPE_VIOLATION',
        message: 'tenantId is not a client-writable field',
      });
    }
    if (!request.user?.tenantId) {
      throw new ForbiddenException({
        code: 'TENANT_SCOPE_VIOLATION',
        message: 'Token has no tenant scope',
      });
    }
    if (TenantContext.current() === undefined) {
      throw new ForbiddenException({
        code: 'TENANT_SCOPE_VIOLATION',
        message: 'Tenant context is missing',
      });
    }
    return true;
  }
}
`,
    service: `import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import type { RequestIdentity } from '../../shared/context/request-context';

@Injectable()
export class TenancyService {
  constructor(private readonly prisma: PrismaService) {}

  listTenants(actor: RequestIdentity) {
    if (actor.isPlatformAdmin) {
      return this.prisma.chemicalistTenant.findMany({ orderBy: { createdAt: 'asc' } });
    }
    if (!actor.tenantId) return [];
    return this.prisma.chemicalistTenant.findMany({
      where: { id: actor.tenantId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createTenant(input: { slug: string; name: string }, actor: RequestIdentity) {
    if (!actor.isPlatformAdmin) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Only platform administrators can create tenants' });
    }
    const existing = await this.prisma.chemicalistTenant.findUnique({
      where: { slug: input.slug },
    });
    if (existing) {
      throw new ConflictException({ code: 'TENANT_EXISTS', message: 'Tenant slug already exists' });
    }
    return this.prisma.chemicalistTenant.create({ data: input });
  }

  listOrganizations(tenantId: string, actor: RequestIdentity) {
    if (!actor.isPlatformAdmin && actor.tenantId !== tenantId) {
      throw new ForbiddenException({ code: 'TENANT_SCOPE_VIOLATION', message: 'Organization is outside this tenant' });
    }
    return this.prisma.chemicalistOrganization.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
    });
  }

  async createOrganization(
    tenantId: string,
    input: { name: string; code?: string },
    actor: RequestIdentity,
  ) {
    if (!actor.isPlatformAdmin && actor.tenantId !== tenantId) {
      throw new ForbiddenException({ code: 'TENANT_SCOPE_VIOLATION', message: 'Organization is outside this tenant' });
    }
    const tenant = await this.prisma.chemicalistTenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Tenant not found' });
    return this.prisma.chemicalistOrganization.create({
      data: { tenantId, name: input.name, code: input.code ?? null },
    });
  }
}
`,
    controller: `import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { RequirePermission } from '../authorization/permissions';
import { CurrentIdentity } from '../security/current-identity.decorator';
import type { RequestIdentity } from '../../shared/context/request-context';
import { TenancyService } from './tenancy.service';

const CreateTenantSchema = z.object({
  slug: z.string().min(2).max(100),
  name: z.string().min(1).max(200),
});

const CreateOrganizationSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().min(1).max(50).optional(),
});

class CreateTenantDto extends createZodDto(CreateTenantSchema) {}
class CreateOrganizationDto extends createZodDto(CreateOrganizationSchema) {}

@Controller('platform/tenants')
export class TenancyController {
  constructor(private readonly tenancy: TenancyService) {}

  @Get()
  @RequirePermission('platform.tenant:read')
  list(@CurrentIdentity() actor: RequestIdentity) {
    return this.tenancy.listTenants(actor);
  }

  @Post()
  @RequirePermission('platform.tenant:write')
  create(
    @Body() body: CreateTenantDto,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.tenancy.createTenant(body, actor);
  }

  @Get(':id/organizations')
  @RequirePermission('platform.tenant:read')
  organizations(
    @Param('id') id: string,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.tenancy.listOrganizations(id, actor);
  }

  @Post(':id/organizations')
  @RequirePermission('platform.tenant:write')
  createOrganization(
    @Param('id') id: string,
    @Body() body: CreateOrganizationDto,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.tenancy.createOrganization(id, body, actor);
  }
}
`,
    module: `import { Global, Module } from '@nestjs/common';
import { TenancyController } from './tenancy.controller';
import { TenancyService } from './tenancy.service';
import { TenantGuard } from './tenant.guard';

/** Tenancy owner: tenant/organization context and management. */
@Global()
@Module({
  controllers: [TenancyController],
  providers: [TenancyService, TenantGuard],
  exports: [TenancyService, TenantGuard],
})
export class TenancyModule {}
`,
  };
}

module.exports = {
  configurationFiles,
  identityFiles,
  securityFiles,
  authorizationFiles,
  tenancyFiles,
};
