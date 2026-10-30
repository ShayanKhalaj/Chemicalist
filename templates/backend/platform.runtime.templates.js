"use strict";

/**
 * Platform layer templates — part 2: audit, notification, files, workflow,
 * module registry, feature flags, search, reporting, integration, internal
 * communication and the platform aggregate module.
 */

function auditFiles() {
  return {
    service: `import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';

export interface AuditRecordInput {
  tenantId?: string | null;
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  outcome?: 'SUCCESS' | 'FAILURE' | 'DENIED';
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditQuery {
  limit?: number;
  action?: string;
  actorId?: string;
  tenantId?: string;
}

import type { RequestIdentity } from '../../shared/context/request-context';

/** Audit owner: append-only record of sensitive operations and authorizations. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditRecordInput): Promise<void> {
    await this.prisma.chemicalistAuditEntry.create({
      data: {
        tenantId: input.tenantId ?? null,
        actorId: input.actorId ?? null,
        actorEmail: input.actorEmail ?? null,
        action: input.action,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        outcome: input.outcome ?? 'SUCCESS',
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        requestId: input.requestId ?? null,
        metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  list(query: AuditQuery, actor: RequestIdentity) {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    return this.prisma.chemicalistAuditEntry.findMany({
      where: {
        ...(actor.isPlatformAdmin
          ? (query.tenantId ? { tenantId: query.tenantId } : {})
          : { tenantId: actor.tenantId ?? null }),
        ...(query.action ? { action: query.action } : {}),
        ...(query.actorId ? { actorId: query.actorId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
`,
    interceptor: `import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  HttpException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, concatMap, dematerialize, materialize } from 'rxjs';
import { RequestContext, type RequestIdentity } from '../../shared/context/request-context';
import { AuditService } from './audit.service';

type AuditedRequest = Request & { user?: RequestIdentity; route?: { path?: string } };

/**
 * Records every HTTP action, including reads and failed requests. Audit writes
 * are awaited so a request is never reported as successful without its record.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<AuditedRequest>();

    const response = http.getResponse<Response>();
    const identity = request.user;
    const params = request.params as Record<string, string | undefined>;
    const startedAt = Date.now();
    const base = {
      tenantId: identity?.tenantId ?? RequestContext.tenantId() ?? null,
      actorId: identity?.userId ?? null,
      actorEmail: identity?.email ?? null,
      action: request.method + ' ' + request.path,
      resourceType: request.route?.path ?? null,
      resourceId: params && typeof params.id === 'string' ? params.id : null,
      ip: request.ip ?? null,
      userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
      requestId: identity?.requestId ?? null,
    };

    return next.handle().pipe(
      materialize(),
      concatMap(async (notification) => {
        if (notification.kind === 'C') return notification;
        const failed = notification.kind === 'E';
        const error = failed ? notification.error : undefined;
        const statusCode =
          error instanceof HttpException ? error.getStatus() : error ? 500 : response.statusCode;
        await this.audit.record({
          ...base,
          outcome: failed
            ? statusCode === 403
              ? 'DENIED'
              : 'FAILURE'
            : 'SUCCESS',
          metadata: { durationMs: Date.now() - startedAt, statusCode },
        });
        return notification;
      }),
      dematerialize(),
    );
  }
}
`,
    controller: `import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { RequirePermission } from '../authorization/permissions';
import { CurrentIdentity } from '../security/current-identity.decorator';
import type { RequestIdentity } from '../../shared/context/request-context';
import { AuditService } from './audit.service';

@Controller('platform/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission('platform.audit:read')
  list(
    @Query('limit') limit?: string,
    @Query('action') action?: string,
    @Query('actorId') actorId?: string,
    @Query('tenantId') tenantId?: string,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    if (limit !== undefined && !/^\\d+$/.test(limit)) {
      throw new BadRequestException({ code: 'INVALID_LIMIT', message: 'limit must be a positive integer' });
    }
    return this.audit.list({
      limit: limit === undefined ? undefined : Number(limit),
      action,
      actorId,
      tenantId,
    }, actor);
  }
}
`,
    module: `import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditInterceptor } from './audit.interceptor';

/** Audit owner. Global so any Lab can record a business audit trail. */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
  exports: [AuditService],
})
export class AuditModule {}
`,
  };
}

function locationFiles() {
  return {
    service: `import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import type { RequestIdentity } from '../../shared/context/request-context';

type CountryInput = { code: string; name: string; nativeName?: string; phoneCode?: string };
type RegionInput = { code: string; name: string };
type CityInput = { code: string; name: string };
type AddressInput = {
  title: string;
  countryId: string;
  regionId: string;
  cityId: string;
  addressLine1: string;
  addressLine2?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  isDefault?: boolean;
};

@Injectable()
export class LocationService {
  constructor(private readonly prisma: PrismaService) {}

  private tenant(actor: RequestIdentity): string {
    if (!actor.tenantId) {
      throw new ForbiddenException({
        code: 'TENANT_SCOPE_VIOLATION',
        message: 'A tenant-scoped identity is required for location data',
      });
    }
    return actor.tenantId;
  }

  listCountries(actor: RequestIdentity) {
    return this.prisma.chemicalistCountry.findMany({
      where: { tenantId: this.tenant(actor), isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async createCountry(input: CountryInput, actor: RequestIdentity) {
    const tenantId = this.tenant(actor);
    const code = input.code.trim().toUpperCase();
    const existing = await this.prisma.chemicalistCountry.findFirst({
      where: { tenantId, code },
    });
    if (existing) {
      throw new BadRequestException({ code: 'COUNTRY_EXISTS', message: 'Country code already exists in this tenant' });
    }
    return this.prisma.chemicalistCountry.create({
      data: { tenantId, ...input, code },
    });
  }

  listRegions(countryId: string, actor: RequestIdentity) {
    return this.prisma.chemicalistRegion.findMany({
      where: { tenantId: this.tenant(actor), countryId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async createRegion(countryId: string, input: RegionInput, actor: RequestIdentity) {
    const tenantId = this.tenant(actor);
    const country = await this.prisma.chemicalistCountry.findFirst({
      where: { id: countryId, tenantId, isActive: true },
    });
    if (!country) throw new NotFoundException({ code: 'COUNTRY_NOT_FOUND', message: 'Country not found' });
    const code = input.code.trim();
    const existing = await this.prisma.chemicalistRegion.findFirst({
      where: { tenantId, countryId, code },
    });
    if (existing) {
      throw new BadRequestException({
        code: 'REGION_EXISTS',
        message: 'Region code already exists in this country',
      });
    }
    return this.prisma.chemicalistRegion.create({
      data: { tenantId, countryId, ...input, code },
    });
  }

  listCities(regionId: string, actor: RequestIdentity) {
    return this.prisma.chemicalistCity.findMany({
      where: { tenantId: this.tenant(actor), regionId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async createCity(regionId: string, input: CityInput, actor: RequestIdentity) {
    const tenantId = this.tenant(actor);
    const region = await this.prisma.chemicalistRegion.findFirst({
      where: { id: regionId, tenantId, isActive: true },
    });
    if (!region) throw new NotFoundException({ code: 'REGION_NOT_FOUND', message: 'Region not found' });
    const code = input.code.trim();
    const existing = await this.prisma.chemicalistCity.findFirst({
      where: { tenantId, regionId, code },
    });
    if (existing) {
      throw new BadRequestException({
        code: 'CITY_EXISTS',
        message: 'City code already exists in this region',
      });
    }
    return this.prisma.chemicalistCity.create({
      data: { tenantId, regionId, ...input, code },
    });
  }

  listMyAddresses(actor: RequestIdentity) {
    return this.prisma.chemicalistUserAddress.findMany({
      where: { tenantId: this.tenant(actor), userId: actor.userId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  private async validateAddress(input: AddressInput, tenantId: string): Promise<void> {
    const [country, region, city] = await Promise.all([
      this.prisma.chemicalistCountry.findFirst({
        where: {
          id: input.countryId,
          tenantId,
          isActive: true,
        },
      }),
      this.prisma.chemicalistRegion.findFirst({
        where: {
          id: input.regionId,
          countryId: input.countryId,
          tenantId,
          isActive: true,
        },
      }),
      this.prisma.chemicalistCity.findFirst({
      where: {
        id: input.cityId,
        regionId: input.regionId,
        tenantId,
        isActive: true,
      },
      }),
    ]);
    if (!country || !region || !city) {
      throw new BadRequestException({
        code: 'INVALID_LOCATION_HIERARCHY',
        message: 'The selected country, region, and city do not form an active location in this tenant',
      });
    }
    if (
      input.latitude !== undefined &&
      (input.latitude < -90 || input.latitude > 90)
    ) {
      throw new BadRequestException({ code: 'INVALID_LATITUDE', message: 'Latitude must be between -90 and 90' });
    }
    if (
      input.longitude !== undefined &&
      (input.longitude < -180 || input.longitude > 180)
    ) {
      throw new BadRequestException({ code: 'INVALID_LONGITUDE', message: 'Longitude must be between -180 and 180' });
    }
  }

  async createMyAddress(input: AddressInput, actor: RequestIdentity) {
    const tenantId = this.tenant(actor);
    await this.validateAddress(input, tenantId);
    return this.prisma.$transaction(async (transaction) => {
      if (input.isDefault) {
        await transaction.chemicalistUserAddress.updateMany({
          where: { tenantId, userId: actor.userId, deletedAt: null },
          data: { isDefault: false },
        });
      }
      return transaction.chemicalistUserAddress.create({
        data: { ...input, tenantId, userId: actor.userId },
      });
    });
  }

  async updateMyAddress(id: string, input: AddressInput, actor: RequestIdentity) {
    const tenantId = this.tenant(actor);
    const existing = await this.prisma.chemicalistUserAddress.findFirst({
      where: { id, tenantId, userId: actor.userId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException({ code: 'ADDRESS_NOT_FOUND', message: 'Address not found' });
    await this.validateAddress(input, tenantId);
    return this.prisma.$transaction(async (transaction) => {
      if (input.isDefault) {
        await transaction.chemicalistUserAddress.updateMany({
          where: { tenantId, userId: actor.userId, deletedAt: null, id: { not: id } },
          data: { isDefault: false },
        });
      }
      return transaction.chemicalistUserAddress.update({
        where: { id },
        data: input,
      });
    });
  }

  async deleteMyAddress(id: string, actor: RequestIdentity) {
    const result = await this.prisma.chemicalistUserAddress.updateMany({
      where: {
        id,
        tenantId: this.tenant(actor),
        userId: actor.userId,
        deletedAt: null,
      },
      data: { deletedAt: new Date(), isDefault: false },
    });
    if (result.count !== 1) {
      throw new NotFoundException({ code: 'ADDRESS_NOT_FOUND', message: 'Address not found' });
    }
    return { deleted: true };
  }
}
`,
    controller: `import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { RequirePermission } from '../authorization/permissions';
import { CurrentIdentity } from '../security/current-identity.decorator';
import type { RequestIdentity } from '../../shared/context/request-context';
import { LocationService } from './location.service';

const CountrySchema = z.object({
  code: z.string().trim().min(2).max(3),
  name: z.string().trim().min(1).max(200),
  nativeName: z.string().trim().max(200).optional(),
  phoneCode: z.string().trim().max(10).optional(),
}).strict();
const RegionSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(200),
}).strict();
const CitySchema = RegionSchema;
const AddressSchema = z.object({
  title: z.string().trim().min(1).max(100),
  countryId: z.string().min(1).max(100),
  regionId: z.string().min(1).max(100),
  cityId: z.string().min(1).max(100),
  addressLine1: z.string().trim().min(1).max(500),
  addressLine2: z.string().trim().max(500).optional(),
  postalCode: z.string().trim().max(40).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  isDefault: z.boolean().optional(),
}).strict();

class CountryDto extends createZodDto(CountrySchema) {}
class RegionDto extends createZodDto(RegionSchema) {}
class CityDto extends createZodDto(CitySchema) {}
class AddressDto extends createZodDto(AddressSchema) {}

@Controller('platform/locations')
export class LocationController {
  constructor(private readonly locations: LocationService) {}

  @Get('countries')
  @RequirePermission('platform.location:read')
  countries(@CurrentIdentity() actor: RequestIdentity) {
    return this.locations.listCountries(actor);
  }

  @Post('countries')
  @RequirePermission('platform.location:write')
  createCountry(@Body() body: CountryDto, @CurrentIdentity() actor: RequestIdentity) {
    return this.locations.createCountry(body, actor);
  }

  @Get('countries/:countryId/regions')
  @RequirePermission('platform.location:read')
  regions(@Param('countryId') countryId: string, @CurrentIdentity() actor: RequestIdentity) {
    return this.locations.listRegions(countryId, actor);
  }

  @Post('countries/:countryId/regions')
  @RequirePermission('platform.location:write')
  createRegion(
    @Param('countryId') countryId: string,
    @Body() body: RegionDto,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.locations.createRegion(countryId, body, actor);
  }

  @Get('regions/:regionId/cities')
  @RequirePermission('platform.location:read')
  cities(@Param('regionId') regionId: string, @CurrentIdentity() actor: RequestIdentity) {
    return this.locations.listCities(regionId, actor);
  }

  @Post('regions/:regionId/cities')
  @RequirePermission('platform.location:write')
  createCity(
    @Param('regionId') regionId: string,
    @Body() body: CityDto,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.locations.createCity(regionId, body, actor);
  }

  @Get('me/addresses')
  addresses(@CurrentIdentity() actor: RequestIdentity) {
    return this.locations.listMyAddresses(actor);
  }

  @Post('me/addresses')
  createAddress(@Body() body: AddressDto, @CurrentIdentity() actor: RequestIdentity) {
    return this.locations.createMyAddress(body, actor);
  }

  @Post('me/addresses/:id')
  updateAddress(
    @Param('id') id: string,
    @Body() body: AddressDto,
    @CurrentIdentity() actor: RequestIdentity,
  ) {
    return this.locations.updateMyAddress(id, body, actor);
  }

  @Delete('me/addresses/:id')
  deleteAddress(@Param('id') id: string, @CurrentIdentity() actor: RequestIdentity) {
    return this.locations.deleteMyAddress(id, actor);
  }
}
`,
    module: `import { Global, Module } from '@nestjs/common';
import { LocationController } from './location.controller';
import { LocationService } from './location.service';

@Global()
@Module({
  controllers: [LocationController],
  providers: [LocationService],
  exports: [LocationService],
})
export class LocationModule {}
`,
  };
}

function notificationFiles() {
  return {
    types: `import { Injectable, Logger } from '@nestjs/common';

export type NotificationChannelName = 'IN_APP' | 'EMAIL' | 'SMS';

export interface NotificationMessage {
  recipientId: string;
  template: string;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}

/** Port implemented by a real email/SMS provider in the deployment. */
export abstract class NotificationChannel {
  abstract readonly name: NotificationChannelName;
  abstract deliver(message: NotificationMessage): Promise<void>;
}

/**
 * Default outbound channel adapter. It logs instead of calling a provider so a
 * generated application has no hidden third-party dependency; replace the
 * provider binding to send real email or SMS.
 */
@Injectable()
export class LogNotificationChannel extends NotificationChannel {
  readonly name: NotificationChannelName = 'IN_APP';
  private readonly logger = new Logger(LogNotificationChannel.name);

  deliver(message: NotificationMessage): Promise<void> {
    this.logger.log(
      'Outbound notification (' + message.template + ') for ' + message.recipientId,
    );
    return Promise.resolve();
  }
}

export const NOTIFICATION_CHANNELS = Symbol('NOTIFICATION_CHANNELS');
export const NOTIFICATION_LOG_CHANNEL = Symbol('NOTIFICATION_LOG_CHANNEL');
`,
    service: `import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import {
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
  type NotificationChannelName,
  type NotificationMessage,
} from './notification.types';

export interface SendNotificationInput extends Omit<NotificationMessage, 'template'> {
  channel?: NotificationChannelName;
  tenantId?: string;
  template?: string;
}

/**
 * Notification owner: persists every notification and hands external channels
 * to their adapter. In-app notifications are stored and readable immediately.
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_CHANNELS) private readonly channels: NotificationChannel[],
  ) {}

  async send(input: SendNotificationInput) {
    const channel = input.channel ?? 'IN_APP';
    const notification = await this.prisma.chemicalistNotification.create({
      data: {
        tenantId: input.tenantId ?? null,
        recipientId: input.recipientId,
        channel,
        template: input.template ?? 'generic',
        title: input.title,
        body: input.body,
        status: 'QUEUED',
      },
    });

    const adapter = this.channels.find((candidate) => candidate.name === channel);
    try {
      if (adapter) {
        await adapter.deliver({
          recipientId: input.recipientId,
          template: input.template ?? 'generic',
          title: input.title,
          body: input.body,
          metadata: input.metadata,
        });
      }
      return await this.prisma.chemicalistNotification.update({
        where: { id: notification.id },
        data: { status: 'SENT', sentAt: new Date() },
      });
    } catch (error) {
      return this.prisma.chemicalistNotification.update({
        where: { id: notification.id },
        data: { status: 'FAILED', metadata: { error: (error as Error).message } },
      });
    }
  }

  listFor(recipientId: string, options: { unreadOnly?: boolean; limit?: number } = {}) {
    return this.prisma.chemicalistNotification.findMany({
      where: { recipientId, ...(options.unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(options.limit ?? 50, 1), 200),
    });
  }

  async markRead(id: string, recipientId: string) {
    const existing = await this.prisma.chemicalistNotification.findFirst({
      where: { id, recipientId },
    });
    if (!existing) {
      throw new NotFoundException({ code: 'NOTIFICATION_NOT_FOUND', message: 'Notification not found' });
    }
    return this.prisma.chemicalistNotification.update({
      where: { id },
      data: { readAt: new Date(), status: 'READ' },
    });
  }

  markAllRead(recipientId: string) {
    return this.prisma.chemicalistNotification.updateMany({
      where: { recipientId, readAt: null },
      data: { readAt: new Date(), status: 'READ' },
    });
  }
}
`,
    controller: `import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { CurrentIdentity } from '../security/current-identity.decorator';
import type { RequestIdentity } from '../../shared/context/request-context';
import { RequirePermission } from '../authorization/permissions';
import { NotificationService } from './notification.service';

const SendNotificationSchema = z.object({
  recipientId: z.string().uuid(),
  template: z.string().min(1).max(100).default('generic'),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  channel: z.enum(['IN_APP', 'EMAIL', 'SMS']).optional(),
});

class SendNotificationDto extends createZodDto(SendNotificationSchema) {}

@Controller('platform/notifications')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  mine(
    @CurrentIdentity() identity: RequestIdentity,
    @Query('unreadOnly') unreadOnly?: string,
  ) {
    return this.notifications.listFor(identity.userId, { unreadOnly: unreadOnly === 'true' });
  }

  @Post('read-all')
  readAll(@CurrentIdentity() identity: RequestIdentity) {
    return this.notifications.markAllRead(identity.userId);
  }

  @Post(':id/read')
  read(@CurrentIdentity() identity: RequestIdentity, @Param('id') id: string) {
    return this.notifications.markRead(id, identity.userId);
  }

  @Post()
  @RequirePermission('platform.notification:write')
  send(@Body() body: SendNotificationDto) {
    return this.notifications.send(body);
  }
}
`,
    module: `import { Global, Module } from '@nestjs/common';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import {
  LogNotificationChannel,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_LOG_CHANNEL,
} from './notification.types';

/** Notification owner: in-app notifications plus pluggable external channels. */
@Global()
@Module({
  controllers: [NotificationController],
  providers: [
    NotificationService,
    LogNotificationChannel,
    { provide: NOTIFICATION_LOG_CHANNEL, useExisting: LogNotificationChannel },
    {
      provide: NOTIFICATION_CHANNELS,
      useFactory: (log: LogNotificationChannel) => [log],
      inject: [LogNotificationChannel],
    },
  ],
  exports: [NotificationService],
})
export class NotificationModule {}
`,
  };
}

function filesFiles() {
  return {
    storage: `import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Storage port. Production deployments bind an S3/MinIO adapter; the default is
 * a local directory so the generated application runs without extra services.
 */
export abstract class FileStoragePort {
  abstract put(storageKey: string, data: Buffer): Promise<void>;
  abstract get(storageKey: string): Promise<Buffer>;
  abstract remove(storageKey: string): Promise<void>;
}

@Injectable()
export class LocalDiskStorage extends FileStoragePort {
  private readonly logger = new Logger(LocalDiskStorage.name);
  private readonly root: string;

  constructor(config: ConfigService) {
    super();
    this.root = resolve(config.get<string>('FILE_STORAGE_DIR') ?? '.storage/files');
  }

  private pathFor(storageKey: string): string {
    const target = resolve(join(this.root, storageKey));
    if (!target.startsWith(this.root)) {
      throw new Error('Invalid storage key');
    }
    return target;
  }

  async put(storageKey: string, data: Buffer): Promise<void> {
    const target = this.pathFor(storageKey);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    this.logger.debug('Stored file at ' + target);
  }

  async get(storageKey: string): Promise<Buffer> {
    return readFile(this.pathFor(storageKey));
  }

  async remove(storageKey: string): Promise<void> {
    await rm(this.pathFor(storageKey), { force: true });
  }
}
`,
    service: `import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { FileStoragePort } from './file-storage';

export interface UploadFileInput {
  fileName: string;
  contentType: string;
  contentBase64: string;
  tenantId?: string;
  ownerId?: string;
}

/** File owner: metadata, access rules and the storage port. */
@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FileStoragePort) private readonly storage: FileStoragePort,
  ) {}

  async upload(input: UploadFileInput) {
    const data = Buffer.from(input.contentBase64, 'base64');
    const storageKey = randomUUID();
    await this.storage.put(storageKey, data);
    return this.prisma.chemicalistFileObject.create({
      data: {
        tenantId: input.tenantId ?? null,
        ownerId: input.ownerId ?? null,
        fileName: input.fileName,
        contentType: input.contentType,
        size: data.length,
        storageKey,
        checksum: createHash('sha256').update(data).digest('hex'),
      },
    });
  }

  list(tenantId?: string) {
    return this.prisma.chemicalistFileObject.findMany({
      where: tenantId ? { tenantId } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async metadata(id: string) {
    const file = await this.prisma.chemicalistFileObject.findUnique({ where: { id } });
    if (!file) throw new NotFoundException({ code: 'FILE_NOT_FOUND', message: 'File not found' });
    return file;
  }

  async download(id: string) {
    const file = await this.metadata(id);
    const data = await this.storage.get(file.storageKey);
    return {
      id: file.id,
      fileName: file.fileName,
      contentType: file.contentType,
      size: file.size,
      contentBase64: data.toString('base64'),
    };
  }

  async remove(id: string) {
    const file = await this.metadata(id);
    await this.storage.remove(file.storageKey);
    await this.prisma.chemicalistFileObject.delete({ where: { id } });
    return { deleted: true, id };
  }
}
`,
    controller: `import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { CurrentIdentity } from '../security/current-identity.decorator';
import type { RequestIdentity } from '../../shared/context/request-context';
import { RequirePermission } from '../authorization/permissions';
import { FilesService } from './files.service';

const UploadFileSchema = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1).max(150),
  contentBase64: z.string().min(1),
});

class UploadFileDto extends createZodDto(UploadFileSchema) {}

@Controller('platform/files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Get()
  @RequirePermission('platform.files:read')
  list() {
    return this.files.list();
  }

  @Get(':id')
  @RequirePermission('platform.files:read')
  metadata(@Param('id') id: string) {
    return this.files.metadata(id);
  }

  @Get(':id/content')
  @RequirePermission('platform.files:read')
  content(@Param('id') id: string) {
    return this.files.download(id);
  }

  @Post()
  @RequirePermission('platform.files:write')
  upload(@CurrentIdentity() identity: RequestIdentity, @Body() body: UploadFileDto) {
    return this.files.upload({
      ...body,
      tenantId: identity.tenantId,
      ownerId: identity.userId,
    });
  }

  @Delete(':id')
  @RequirePermission('platform.files:write')
  remove(@Param('id') id: string) {
    return this.files.remove(id);
  }
}
`,
    module: `import { Global, Module } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { FileStoragePort, LocalDiskStorage } from './file-storage';

/** File owner: metadata plus storage port (local disk by default). */
@Global()
@Module({
  controllers: [FilesController],
  providers: [FilesService, { provide: FileStoragePort, useClass: LocalDiskStorage }],
  exports: [FilesService, FileStoragePort],
})
export class FilesModule {}
`,
  };
}

function workflowFiles() {
  return {
    types: `export interface WorkflowStepDefinition {
  /** Stable step key, unique inside the definition. */
  name: string;
  /** Optional role/permission that is allowed to advance this step. */
  assigneePermission?: string;
  requiresApproval?: boolean;
}

export interface DefineWorkflowInput {
  key: string;
  name: string;
  steps: WorkflowStepDefinition[];
  tenantId?: string;
}
`,
    service: `import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import type { DefineWorkflowInput, WorkflowStepDefinition } from './workflow.types';

/**
 * Workflow infrastructure owner.
 *
 * This engine runs *generic* process coordination (definition, instance, step
 * transitions). The business decision of a step belongs to the Lab that owns the
 * process — the engine never decides what a step means.
 */
@Injectable()
export class WorkflowService {
  constructor(private readonly prisma: PrismaService) {}

  async define(input: DefineWorkflowInput) {
    if (!input.steps.length) {
      throw new BadRequestException({ code: 'INVALID_WORKFLOW', message: 'At least one step is required' });
    }
    const scope = input.tenantId ?? 'global';
    const latest = await this.prisma.chemicalistWorkflowDefinition.findFirst({
      where: { scope, key: input.key },
      orderBy: { version: 'desc' },
    });
    return this.prisma.chemicalistWorkflowDefinition.create({
      data: {
        scope,
        tenantId: input.tenantId ?? null,
        key: input.key,
        name: input.name,
        version: (latest?.version ?? 0) + 1,
        steps: input.steps as unknown as Prisma.InputJsonValue,
      },
    });
  }

  listDefinitions(tenantId?: string) {
    return this.prisma.chemicalistWorkflowDefinition.findMany({
      where: { OR: [{ tenantId: tenantId ?? null }, { tenantId: null }] },
      orderBy: { createdAt: 'desc' },
    });
  }

  listInstances(status?: string) {
    return this.prisma.chemicalistWorkflowInstance.findMany({
      where: status ? { status } : {},
      orderBy: { startedAt: 'desc' },
      take: 200,
    });
  }

  async start(key: string, context: Record<string, unknown>, tenantId?: string) {
    const scope = tenantId ?? 'global';
    const definition = await this.prisma.chemicalistWorkflowDefinition.findFirst({
      where: { scope, key, active: true },
      orderBy: { version: 'desc' },
    });
    if (!definition) {
      throw new NotFoundException({ code: 'WORKFLOW_NOT_FOUND', message: 'Workflow definition not found' });
    }
    return this.prisma.chemicalistWorkflowInstance.create({
      data: {
        definitionId: definition.id,
        tenantId: tenantId ?? null,
        context: context as Prisma.InputJsonValue,
        history: [] as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async advance(id: string, note?: string) {
    const instance = await this.prisma.chemicalistWorkflowInstance.findUnique({ where: { id } });
    if (!instance) {
      throw new NotFoundException({ code: 'WORKFLOW_INSTANCE_NOT_FOUND', message: 'Instance not found' });
    }
    if (instance.status !== 'RUNNING' && instance.status !== 'PENDING') {
      throw new BadRequestException({ code: 'WORKFLOW_NOT_RUNNING', message: 'Instance is not running' });
    }

    const definition = await this.prisma.chemicalistWorkflowDefinition.findUnique({
      where: { id: instance.definitionId },
    });
    if (!definition) {
      throw new NotFoundException({ code: 'WORKFLOW_NOT_FOUND', message: 'Workflow definition not found' });
    }

    const steps = definition.steps as unknown as WorkflowStepDefinition[];
    const current = steps[instance.currentStep];
    if (!current) {
      throw new BadRequestException({ code: 'WORKFLOW_COMPLETED', message: 'No current step to advance' });
    }

    const nextStep = instance.currentStep + 1;
    const completed = nextStep >= steps.length;
    const history = Array.isArray(instance.history) ? (instance.history as unknown[]) : [];
    const entry = {
      step: current.name,
      completedAt: new Date().toISOString(),
      note: note ?? null,
    };

    return this.prisma.chemicalistWorkflowInstance.update({
      where: { id },
      data: {
        currentStep: nextStep,
        status: completed ? 'COMPLETED' : 'RUNNING',
        completedAt: completed ? new Date() : null,
        history: [...history, entry] as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async cancel(id: string, reason?: string) {
    const instance = await this.prisma.chemicalistWorkflowInstance.findUnique({ where: { id } });
    if (!instance) {
      throw new NotFoundException({ code: 'WORKFLOW_INSTANCE_NOT_FOUND', message: 'Instance not found' });
    }
    return this.prisma.chemicalistWorkflowInstance.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        completedAt: new Date(),
        lastError: reason ?? null,
      },
    });
  }
}
`,
    controller: `import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { RequirePermission } from '../authorization/permissions';
import { WorkflowService } from './workflow.service';

const DefineWorkflowSchema = z.object({
  key: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  steps: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        assigneePermission: z.string().min(1).max(200).optional(),
        requiresApproval: z.boolean().optional(),
      }),
    )
    .min(1),
});

const StartWorkflowSchema = z.object({
  key: z.string().min(1).max(100),
  context: z.record(z.string(), z.unknown()).default({}),
});

const AdvanceWorkflowSchema = z.object({
  note: z.string().max(1000).optional(),
});

class DefineWorkflowDto extends createZodDto(DefineWorkflowSchema) {}
class StartWorkflowDto extends createZodDto(StartWorkflowSchema) {}
class AdvanceWorkflowDto extends createZodDto(AdvanceWorkflowSchema) {}

@Controller('platform/workflows')
export class WorkflowController {
  constructor(private readonly workflows: WorkflowService) {}

  @Get('definitions')
  @RequirePermission('platform.workflow:read')
  definitions() {
    return this.workflows.listDefinitions();
  }

  @Post('definitions')
  @RequirePermission('platform.workflow:write')
  define(@Body() body: DefineWorkflowDto) {
    return this.workflows.define(body);
  }

  @Get('instances')
  @RequirePermission('platform.workflow:read')
  instances(@Query('status') status?: string) {
    return this.workflows.listInstances(status);
  }

  @Post('instances')
  @RequirePermission('platform.workflow:write')
  start(@Body() body: StartWorkflowDto) {
    return this.workflows.start(body.key, body.context);
  }

  @Post('instances/:id/advance')
  @RequirePermission('platform.workflow:write')
  advance(@Param('id') id: string, @Body() body: AdvanceWorkflowDto) {
    return this.workflows.advance(id, body.note);
  }

  @Post('instances/:id/cancel')
  @RequirePermission('platform.workflow:write')
  cancel(@Param('id') id: string, @Body() body: AdvanceWorkflowDto) {
    return this.workflows.cancel(id, body.note);
  }
}
`,
    module: `import { Global, Module } from '@nestjs/common';
import { WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';

/** Workflow owner: generic, persisted process coordination. */
@Global()
@Module({
  controllers: [WorkflowController],
  providers: [WorkflowService],
  exports: [WorkflowService],
})
export class WorkflowModule {}
`,
  };
}

function moduleRegistryFiles() {
  return {
    service: `import { ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { studios } from '../../manifest-registry';

/**
 * Module registry & entitlements owner.
 *
 * Installing a Lab/Studio is a platform concern: the registry records what is
 * installed, entitlements record what a tenant is commercially allowed to use.
 * Disabling a module never deletes business data.
 */
@Injectable()
export class ModuleRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ModuleRegistryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    for (const studio of studios) {
      const key = studio.labSlug + '/' + studio.studioSlug;
      await this.prisma.chemicalistModuleRegistration.upsert({
        where: { key },
        update: { lab: studio.lab, studio: studio.studio, title: studio.title },
        create: {
          key,
          lab: studio.lab,
          studio: studio.studio,
          title: studio.title,
          version: '1.0.0',
        },
      });
    }
    this.logger.log('Module registry synchronised: ' + studios.length + ' studio(s)');
  }

  list() {
    return this.prisma.chemicalistModuleRegistration.findMany({ orderBy: { key: 'asc' } });
  }

  entitlements(tenantId: string) {
    return this.prisma.chemicalistEntitlement.findMany({
      where: { tenantId },
      orderBy: { moduleKey: 'asc' },
    });
  }

  async grant(input: {
    tenantId: string;
    moduleKey: string;
    plan?: string;
    validUntil?: Date;
  }) {
    const module = await this.prisma.chemicalistModuleRegistration.findUnique({
      where: { key: input.moduleKey },
    });
    if (!module) {
      throw new NotFoundException({ code: 'MODULE_NOT_INSTALLED', message: 'Module is not installed' });
    }
    return this.prisma.chemicalistEntitlement.upsert({
      where: { tenantId_moduleKey: { tenantId: input.tenantId, moduleKey: input.moduleKey } },
      update: { plan: input.plan ?? 'standard', status: 'ACTIVE', validUntil: input.validUntil ?? null },
      create: {
        tenantId: input.tenantId,
        moduleKey: input.moduleKey,
        plan: input.plan ?? 'standard',
        validUntil: input.validUntil ?? null,
      },
    });
  }

  async assertEntitled(tenantId: string, moduleKey: string): Promise<void> {
    const entitlement = await this.prisma.chemicalistEntitlement.findUnique({
      where: { tenantId_moduleKey: { tenantId, moduleKey } },
    });
    if (!entitlement || entitlement.status !== 'ACTIVE') {
      throw new ConflictException({
        code: 'NOT_ENTITLED',
        message: 'Tenant has no active entitlement for module ' + moduleKey,
      });
    }
    if (entitlement.validUntil && entitlement.validUntil.getTime() < Date.now()) {
      throw new ConflictException({
        code: 'ENTITLEMENT_EXPIRED',
        message: 'Entitlement for module ' + moduleKey + ' has expired',
      });
    }
  }
}
`,
    controller: `import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { RequirePermission } from '../authorization/permissions';
import { ModuleRegistryService } from './module-registry.service';

const GrantEntitlementSchema = z.object({
  tenantId: z.string().uuid(),
  moduleKey: z.string().min(3).max(150),
  plan: z.string().min(1).max(50).optional(),
  validUntil: z.coerce.date().optional(),
});

class GrantEntitlementDto extends createZodDto(GrantEntitlementSchema) {}

@Controller('platform/modules')
export class ModuleRegistryController {
  constructor(private readonly modules: ModuleRegistryService) {}

  @Get()
  @RequirePermission('platform.modules:read')
  list() {
    return this.modules.list();
  }

  @Get('entitlements/:tenantId')
  @RequirePermission('platform.modules:read')
  entitlements(@Param('tenantId') tenantId: string) {
    return this.modules.entitlements(tenantId);
  }

  @Post('entitlements')
  @RequirePermission('platform.modules:write')
  grant(@Body() body: GrantEntitlementDto) {
    return this.modules.grant(body);
  }
}
`,
    module: `import { Global, Module } from '@nestjs/common';
import { ModuleRegistryController } from './module-registry.controller';
import { ModuleRegistryService } from './module-registry.service';

/** Module registry & licensing owner. */
@Global()
@Module({
  controllers: [ModuleRegistryController],
  providers: [ModuleRegistryService],
  exports: [ModuleRegistryService],
})
export class ModuleRegistryModule {}
`,
  };
}

function featureFlagFiles() {
  return {
    service: `import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

export interface SetFeatureFlagInput {
  key: string;
  enabled: boolean;
  tenantId?: string;
  description?: string;
  value?: Record<string, unknown>;
}

/**
 * Feature flags / runtime configuration owner.
 * A tenant-specific flag overrides the global flag with the same key.
 */
@Injectable()
export class FeatureFlagService {
  constructor(private readonly prisma: PrismaService) {}

  async get(key: string, tenantId?: string): Promise<boolean> {
    if (tenantId) {
      const tenantFlag = await this.prisma.chemicalistFeatureFlag.findUnique({
        where: { scope_key: { scope: tenantId, key } },
      });
      if (tenantFlag) return tenantFlag.enabled;
    }
    const globalFlag = await this.prisma.chemicalistFeatureFlag.findUnique({
      where: { scope_key: { scope: 'global', key } },
    });
    return globalFlag?.enabled ?? false;
  }

  list(tenantId?: string) {
    return this.prisma.chemicalistFeatureFlag.findMany({
      where: { scope: { in: ['global', ...(tenantId ? [tenantId] : [])] } },
      orderBy: [{ key: 'asc' }, { scope: 'asc' }],
    });
  }

  set(input: SetFeatureFlagInput) {
    const scope = input.tenantId ?? 'global';
    return this.prisma.chemicalistFeatureFlag.upsert({
      where: { scope_key: { scope, key: input.key } },
      update: {
        enabled: input.enabled,
        description: input.description ?? null,
        value: (input.value ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
      },
      create: {
        scope,
        tenantId: input.tenantId ?? null,
        key: input.key,
        enabled: input.enabled,
        description: input.description ?? null,
        value: (input.value ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
`,
    controller: `import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { RequirePermission } from '../../authorization/permissions';
import { FeatureFlagService } from './feature-flag.service';

const SetFeatureFlagSchema = z.object({
  enabled: z.boolean(),
  description: z.string().max(500).optional(),
  tenantId: z.string().uuid().optional(),
  value: z.record(z.string(), z.unknown()).optional(),
});

class SetFeatureFlagDto extends createZodDto(SetFeatureFlagSchema) {}

@Controller('platform/flags')
export class FeatureFlagController {
  constructor(private readonly flags: FeatureFlagService) {}

  @Get()
  @RequirePermission('platform.flags:read')
  list() {
    return this.flags.list();
  }

  @Get(':key')
  @RequirePermission('platform.flags:read')
  async get(@Param('key') key: string) {
    return { key, enabled: await this.flags.get(key) };
  }

  @Put(':key')
  @RequirePermission('platform.flags:write')
  set(@Param('key') key: string, @Body() body: SetFeatureFlagDto) {
    return this.flags.set({ key, ...body });
  }
}
`,
    module: `import { Global, Module } from '@nestjs/common';
import { FeatureFlagController } from './feature-flag.controller';
import { FeatureFlagService } from './feature-flag.service';

/** Feature flags / platform configuration owner. */
@Global()
@Module({
  controllers: [FeatureFlagController],
  providers: [FeatureFlagService],
  exports: [FeatureFlagService],
})
export class FeatureFlagModule {}
`,
  };
}

function searchFiles() {
  return {
    service: `import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';

export interface IndexDocumentInput {
  entityType: string;
  entityId: string;
  title: string;
  body: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Shared search owner. It never owns the source data: a Lab publishes a
 * projection of its data, and the platform answers cross-Lab queries.
 */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  index(input: IndexDocumentInput) {
    return this.prisma.chemicalistSearchDocument.upsert({
      where: { entityType_entityId: { entityType: input.entityType, entityId: input.entityId } },
      update: {
        title: input.title,
        body: input.body,
        metadata: (input.metadata ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
      },
      create: {
        entityType: input.entityType,
        entityId: input.entityId,
        title: input.title,
        body: input.body,
        tenantId: input.tenantId ?? null,
        metadata: (input.metadata ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
      },
    });
  }

  query(text: string, options: { entityType?: string; tenantId?: string; limit?: number } = {}) {
    const term = text.trim();
    if (!term) return Promise.resolve([]);
    return this.prisma.chemicalistSearchDocument.findMany({
      where: {
        ...(options.entityType ? { entityType: options.entityType } : {}),
        ...(options.tenantId ? { tenantId: options.tenantId } : {}),
        OR: [
          { title: { contains: term, mode: 'insensitive' } },
          { body: { contains: term, mode: 'insensitive' } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(Math.max(options.limit ?? 25, 1), 100),
    });
  }

  async remove(entityType: string, entityId: string): Promise<void> {
    await this.prisma.chemicalistSearchDocument.deleteMany({ where: { entityType, entityId } });
  }
}
`,
    controller: `import { Controller, Get, Query } from '@nestjs/common';
import { CurrentIdentity } from '../security/current-identity.decorator';
import type { RequestIdentity } from '../../shared/context/request-context';
import { RequirePermission } from '../authorization/permissions';
import { SearchService } from './search.service';

@Controller('platform/search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @RequirePermission('platform.search:read')
  query(
    @CurrentIdentity() identity: RequestIdentity,
    @Query('q') q?: string,
    @Query('entityType') entityType?: string,
    @Query('limit') limit?: string,
  ) {
    return this.search.query(q ?? '', {
      entityType,
      tenantId: identity.tenantId,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
`,
    module: `import { Global, Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

/** Search owner: shared search index and query API. */
@Global()
@Module({
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
`,
  };
}

function reportingFiles() {
  return {
    service: `import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { generatedReports, type ReportDescriptor } from './generated-reports';

/**
 * Reporting owner: read-only summaries over data owned by other modules.
 * It aggregates; it never writes business data.
 */
@Injectable()
export class ReportingService {
  constructor(private readonly prisma: PrismaService) {}

  list(): Array<Pick<ReportDescriptor, 'key' | 'title' | 'scope'>> {
    return generatedReports.map((report) => ({
      key: report.key,
      title: report.title,
      scope: report.scope,
    }));
  }

  async run(key: string) {
    const report = generatedReports.find((candidate) => candidate.key === key);
    if (!report) {
      throw new NotFoundException({ code: 'REPORT_NOT_FOUND', message: 'Report not found' });
    }
    return {
      key: report.key,
      title: report.title,
      scope: report.scope,
      generatedAt: new Date().toISOString(),
      data: await report.run(this.prisma),
    };
  }
}
`,
    controller: `import { Controller, Get, Param } from '@nestjs/common';
import { RequirePermission } from '../authorization/permissions';
import { ReportingService } from './reporting.service';

@Controller('platform/reports')
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  @Get()
  @RequirePermission('platform.reporting:read')
  list() {
    return this.reporting.list();
  }

  @Get(':key')
  @RequirePermission('platform.reporting:read')
  run(@Param('key') key: string) {
    return this.reporting.run(key);
  }
}
`,
    module: `import { Global, Module } from '@nestjs/common';
import { ReportingController } from './reporting.controller';
import { ReportingService } from './reporting.service';

/** Reporting owner: read-only, generated summaries. */
@Global()
@Module({
  controllers: [ReportingController],
  providers: [ReportingService],
  exports: [ReportingService],
})
export class ReportingModule {}
`,
  };
}

function integrationFiles() {
  return {
    service: `import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../../infrastructure/database/prisma.service';

export interface CreateEndpointInput {
  tenantId: string;
  key: string;
  url: string;
  secret: string;
  events?: string[];
}

export interface IntegrationEvent {
  eventId: string;
  eventType: string;
  payload: unknown;
}

/**
 * Integration owner: outbound endpoints, signed delivery and a delivery log.
 * The payload is produced by the owning Lab; this module only transports it.
 */
@Injectable()
export class IntegrationService {
  private readonly logger = new Logger(IntegrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  listEndpoints(tenantId: string) {
    return this.prisma.chemicalistIntegrationEndpoint.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  createEndpoint(input: CreateEndpointInput) {
    return this.prisma.chemicalistIntegrationEndpoint.create({
      data: {
        tenantId: input.tenantId,
        key: input.key,
        url: input.url,
        secret: input.secret,
        events: input.events ?? [],
      },
    });
  }

  listDeliveries(endpointId: string) {
    return this.prisma.chemicalistIntegrationDelivery.findMany({
      where: { endpointId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /** Delivers one event to every active endpoint subscribed to its type. */
  async dispatch(tenantId: string, event: IntegrationEvent): Promise<number> {
    const endpoints = await this.prisma.chemicalistIntegrationEndpoint.findMany({
      where: { tenantId, active: true },
    });
    let delivered = 0;
    for (const endpoint of endpoints) {
      if (endpoint.events.length && !endpoint.events.includes(event.eventType) && !endpoint.events.includes('*')) {
        continue;
      }
      const result = await this.send(endpoint.id, endpoint.url, endpoint.secret, event);
      if (result) delivered += 1;
    }
    return delivered;
  }

  async test(endpointId: string) {
    const endpoint = await this.prisma.chemicalistIntegrationEndpoint.findUnique({
      where: { id: endpointId },
    });
    if (!endpoint) {
      throw new NotFoundException({ code: 'ENDPOINT_NOT_FOUND', message: 'Endpoint not found' });
    }
    const ok = await this.send(endpoint.id, endpoint.url, endpoint.secret, {
      eventId: 'test-' + endpoint.id,
      eventType: 'endpoint.test',
      payload: { message: 'Chemicalist integration test' },
    });
    return { delivered: ok };
  }

  /** POSTs the event with an HMAC signature and records the attempt. */
  private async send(
    endpointId: string,
    url: string,
    secret: string,
    event: IntegrationEvent,
  ): Promise<boolean> {
    const delivery = await this.prisma.chemicalistIntegrationDelivery.create({
      data: { endpointId, eventId: event.eventId, eventType: event.eventType },
    });
    const body = JSON.stringify({
      eventId: event.eventId,
      eventType: event.eventType,
      occurredAt: new Date().toISOString(),
      payload: event.payload,
    });
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    const timeoutMs = this.config.get<number>('INTEGRATION_TIMEOUT_MS') ?? 10000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-chemicalist-signature': 'sha256=' + signature,
          'x-chemicalist-event': event.eventType,
        },
        body,
        signal: controller.signal,
      });
      await this.prisma.chemicalistIntegrationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: response.ok ? 'DELIVERED' : 'FAILED',
          attempts: 1,
          responseStatus: response.status,
          deliveredAt: response.ok ? new Date() : null,
          lastError: response.ok ? null : 'HTTP ' + response.status,
        },
      });
      return response.ok;
    } catch (error) {
      this.logger.warn('Integration delivery failed: ' + (error as Error).message);
      await this.prisma.chemicalistIntegrationDelivery.update({
        where: { id: delivery.id },
        data: { status: 'FAILED', attempts: 1, lastError: (error as Error).message },
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
`,
    controller: `import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { CurrentIdentity } from '../security/current-identity.decorator';
import type { RequestIdentity } from '../../shared/context/request-context';
import { RequirePermission } from '../authorization/permissions';
import { IntegrationService } from './integration.service';

const CreateEndpointSchema = z.object({
  key: z.string().min(1).max(100),
  url: z.string().url(),
  secret: z.string().min(16).max(200),
  events: z.array(z.string().min(1).max(200)).optional(),
});

class CreateEndpointDto extends createZodDto(CreateEndpointSchema) {}

@Controller('platform/integrations')
export class IntegrationController {
  constructor(private readonly integrations: IntegrationService) {}

  @Get('endpoints')
  @RequirePermission('platform.integration:read')
  list(@CurrentIdentity() identity: RequestIdentity) {
    return this.integrations.listEndpoints(identity.tenantId ?? '');
  }

  @Post('endpoints')
  @RequirePermission('platform.integration:write')
  create(@CurrentIdentity() identity: RequestIdentity, @Body() body: CreateEndpointDto) {
    if (!identity.tenantId) {
      throw new ForbiddenException({ code: 'TENANT_SCOPE_VIOLATION', message: 'Token has no tenant scope' });
    }
    return this.integrations.createEndpoint({ ...body, tenantId: identity.tenantId });
  }

  @Get('endpoints/:id/deliveries')
  @RequirePermission('platform.integration:read')
  deliveries(@Param('id') id: string) {
    return this.integrations.listDeliveries(id);
  }

  @Post('endpoints/:id/test')
  @RequirePermission('platform.integration:write')
  test(@Param('id') id: string) {
    return this.integrations.test(id);
  }
}
`,
    module: `import { Global, Module } from '@nestjs/common';
import { IntegrationController } from './integration.controller';
import { IntegrationService } from './integration.service';

/** Integration owner: outbound endpoints and signed webhook delivery. */
@Global()
@Module({
  controllers: [IntegrationController],
  providers: [IntegrationService],
  exports: [IntegrationService],
})
export class IntegrationModule {}
`,
  };
}

function communicationFiles() {
  return {
    domainEvent: `/** Base class of every domain event published by a Lab. */
export abstract class DomainEvent {
  abstract readonly eventType: string;

  constructor(
    readonly eventId: string,
    readonly aggregateId: string,
    readonly aggregateType: string,
    readonly occurredAt: Date = new Date(),
  ) {}

  abstract get payload(): unknown;
}
`,
    eventBus: `import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../../shared/context/request-context';
import { DomainEvent } from '../contracts/domain-event';

/** Transport-neutral event envelope; the same shape is used by the outbox. */
export interface DomainEventEnvelope {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  tenantId?: string;
  correlationId?: string;
  occurredAt: string;
  payload: unknown;
}

export type DomainEventHandler = (envelope: DomainEventEnvelope) => Promise<void>;

/**
 * In-process event bus used inside the modular monolith.
 *
 * Outbox/RabbitMQ (when enabled) is the durable transport between processes;
 * this bus is the local fan-out so a Lab can react to an event without a broker.
 */
@Injectable()
export class EventBus {
  private readonly handlers = new Map<string, DomainEventHandler[]>();

  subscribe(eventType: string, handler: DomainEventHandler): () => void {
    const current = this.handlers.get(eventType) ?? [];
    this.handlers.set(eventType, [...current, handler]);
    return () => {
      this.handlers.set(
        eventType,
        (this.handlers.get(eventType) ?? []).filter((candidate) => candidate !== handler),
      );
    };
  }

  async publish(event: DomainEvent): Promise<void> {
    const envelope: DomainEventEnvelope = {
      eventId: event.eventId,
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      tenantId: RequestContext.tenantId(),
      occurredAt: event.occurredAt.toISOString(),
      payload: event.payload,
    };
    await this.publishEnvelope(envelope);
  }

  async publishEnvelope(envelope: DomainEventEnvelope): Promise<void> {
    const handlers = this.handlers.get(envelope.eventType) ?? [];
    for (const handler of handlers) {
      await handler(envelope);
    }
  }
}
`,
    module: `import { Global, Module } from '@nestjs/common';
import { EventBus } from './eda/event-bus';

/** Communication owner (transport-neutral part): contracts and the local bus. */
@Global()
@Module({
  providers: [EventBus],
  exports: [EventBus],
})
export class CommunicationModule {}
`,
  };
}

function platformModule() {
  return `import { Module } from '@nestjs/common';
import { AuthorizationModule } from './authorization/authorization.module';
import { AuditModule } from './audit/audit.module';
import { CommunicationModule } from './communication/communication.module';
import { ConfigurationModule } from './configuration/config.module';
import { FeatureFlagModule } from './configuration/feature-flag/feature-flag.module';
import { FilesModule } from './files/files.module';
import { IdentityModule } from './identity/identity.module';
import { IntegrationModule } from './integration/integration.module';
import { LocationModule } from './location/location.module';
import { ModuleRegistryModule } from './modules/module-registry.module';
import { NotificationModule } from './notification/notification.module';
import { ReportingModule } from './reporting/reporting.module';
import { SearchModule } from './search/search.module';
import { SecurityModule } from './security/security.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { WorkflowModule } from './workflow/workflow.module';

/**
 * The Chemicalist platform layer.
 *
 * Every Lab/Studio depends on this module and none of it owns business data:
 *  - identity + authentication + authorization + tenancy (who is calling, what
 *    may they do, in which organization),
 *  - audit + notification + communication (observability and messaging),
 *  - files + workflow + search + reporting + integration (shared capabilities),
 *  - module registry/entitlements + feature flags (licensing and configuration).
 */
@Module({
  imports: [
    ConfigurationModule,
    IdentityModule,
    SecurityModule,
    AuthorizationModule,
    TenancyModule,
    AuditModule,
    CommunicationModule,
    NotificationModule,
    FilesModule,
    WorkflowModule,
    ModuleRegistryModule,
    FeatureFlagModule,
    SearchModule,
    ReportingModule,
    IntegrationModule,
    LocationModule,
  ],
  exports: [
    IdentityModule,
    SecurityModule,
    AuthorizationModule,
    TenancyModule,
    AuditModule,
    CommunicationModule,
    NotificationModule,
    FilesModule,
    WorkflowModule,
    ModuleRegistryModule,
    FeatureFlagModule,
    SearchModule,
    ReportingModule,
    IntegrationModule,
    LocationModule,
  ],
})
export class PlatformModule {}
`;
}

module.exports = {
  auditFiles,
  locationFiles,
  notificationFiles,
  filesFiles,
  workflowFiles,
  moduleRegistryFiles,
  featureFlagFiles,
  searchFiles,
  reportingFiles,
  integrationFiles,
  communicationFiles,
  platformModule,
};
