"use strict";

/**
 * Persistence layer: Prisma schema, persistence models, mappers, repositories.
 *
 * Correctness rules encoded here:
 *  - the Prisma delegate name is camelCase(model name) (`purchaseOrder`), which
 *    is the actual Prisma Client API; the table name is snake_case;
 *  - no unsafe `as never` casts: rows are mapped explicitly;
 *  - nullable columns are `?` in Prisma, optional-only columns get a default;
 *  - decimal columns use @db.Decimal, dates map to DateTime, JSON to Json,
 *    enums to generated Prisma enums, and every UUID primary key is
 *    `@id @default(uuid())`;
 *  - every business table and every platform table carries `tenantId` (except
 *    the tenant table itself), because tenancy is part of the platform.
 */

const { snake, camel, constant, kebab } = require("../engine/naming");

// ---------------------------------------------------------------------------
// Prisma schema
// ---------------------------------------------------------------------------

function prismaScalarType(field) {
  switch (field.baseType) {
    case "string":
    case "text":
    case "uuid":
      return "String";
    case "boolean":
      return "Boolean";
    case "int":
      return "Int";
    case "float":
      return "Float";
    case "decimal":
      return "Decimal";
    case "date":
    case "datetime":
      return "DateTime";
    case "json":
      return "Json";
    case "enum":
      return field.enumName;
    default:
      throw new Error(
        "No Prisma mapping for type `" + field.baseType + "` (" + field.path + ")",
      );
  }
}

function prismaFieldLine(field, database) {
  let type = prismaScalarType(field);
  if (field.isArray) type += "[]";

  const optional = prismaOptional(field);
  const attributes = [];

  if (field.baseType === "uuid") {
    attributes.push(database === "mongodb" ? "@db.ObjectId" : "@db.Uuid");
  }
  if (field.baseType === "decimal") {
    attributes.push(database === "mongodb" ? "@db.Decimal128" : "@db.Decimal(18, 4)");
  }
  if (field.baseType === "text" && database !== "mongodb") attributes.push("@db.Text");
  if (field.unique) attributes.push("@unique");
  else if (field.index && !field.generatedByRelation) attributes.push("@index");

  if (field.optional && !field.nullable && !field.isArray && field.default === undefined) {
    // Optional (may be omitted) but not nullable: give the column a default so
    // `NOT NULL` and "can be omitted" stay consistent.
    switch (field.baseType) {
      case "string":
      case "text":
        attributes.push('@default("")');
        break;
      case "boolean":
        attributes.push("@default(false)");
        break;
      case "int":
        attributes.push("@default(0)");
        break;
      case "float":
      case "decimal":
        attributes.push("@default(0)");
        break;
      case "date":
      case "datetime":
        attributes.push("@default(now())");
        break;
      default:
        break;
    }
  }

  if (field.default !== undefined && !field.isArray) {
    const existing = attributes.some((attribute) => attribute.startsWith("@default"));
    if (!existing) {
      if (typeof field.default === "string") {
        attributes.push(
          field.enumName
            ? "@default(" + field.default + ")"
            : '@default("' + field.default + '")',
        );
      } else if (typeof field.default === "boolean" || typeof field.default === "number") {
        attributes.push("@default(" + field.default + ")");
      }
    }
  }

  return (
    "  " +
    field.name +
    " " +
    type +
    (optional ? "?" : "") +
    (attributes.length ? " " + attributes.join(" ") : "")
  );
}

/**
 * A Prisma column must be `?` (nullable) when the value may be null, omitted, or
 * when an optional non-nullable field could not receive a portable default.
 * Lists are never nullable in Prisma (they default to `[]`).
 */
function prismaOptional(field) {
  if (field.isArray) return false;
  if (field.nullable) return true;
  if (!field.optional) return false;
  if (field.baseType === "json" || field.baseType === "enum") return true;
  if (field.default !== undefined) return false;
  return ![
    "string",
    "text",
    "boolean",
    "int",
    "float",
    "decimal",
    "date",
    "datetime",
  ].includes(field.baseType);
}

function platformModel(schema, name, table, lines) {
  return [
    "model " + name + " {",
    ...lines.map((line) => "  " + line),
    "",
    '  @@map("' + table + '")',
    '  @@schema("' + schema + '")',
    "}",
    "",
  ];
}

/**
 * Platform tables. These are owned by the platform modules and use the
 * `Chemicalist` prefix / `chemicalist_*` table names so they can never collide
 * with business models (or with a Studio model called `User`).
 */
function platformModelBlocks(ctx, schema) {
  const blocks = [];

  blocks.push(
    ...platformModel(schema, "ChemicalistTenant", "chemicalist_tenant", [
      'id        String   @id @default(uuid()) @db.Uuid',
      'slug      String   @unique',
      'name      String',
      'status    String   @default("ACTIVE")',
      'createdAt DateTime @default(now())',
      'updatedAt DateTime @updatedAt',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistOrganization", "chemicalist_organization", [
      'id        String   @id @default(uuid()) @db.Uuid',
      'tenantId  String   @db.Uuid',
      'name      String',
      'code      String?',
      'createdAt DateTime @default(now())',
      'updatedAt DateTime @updatedAt',
      '',
      '@@unique([tenantId, name])',
      '@@index([tenantId])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistUser", "chemicalist_user", [
      'id              String    @id @default(uuid()) @db.Uuid',
      'tenantId        String?   @db.Uuid',
      'email           String    @unique',
      'username        String?   @unique',
      'passwordHash    String',
      'displayName     String?',
      'status          String    @default("ACTIVE")',
      'isPlatformAdmin Boolean   @default(false)',
      'emailVerifiedAt DateTime?',
      'mobileVerifiedAt DateTime?',
      'lastLoginAt     DateTime?',
      'createdAt       DateTime  @default(now())',
      'updatedAt       DateTime  @updatedAt',
      '',
      '@@index([tenantId])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistUserProfile", "chemicalist_user_profile", [
      'id          String   @id @default(uuid()) @db.Uuid',
      'userId      String   @unique @db.Uuid',
      'tenantId    String?  @db.Uuid',
      'firstName   String?',
      'lastName    String?',
      'phone       String?',
      'avatarUrl   String?',
      'locale      String?',
      'timeZone    String?',
      'metadata    Json?',
      'createdAt   DateTime @default(now())',
      'updatedAt   DateTime @updatedAt',
      '',
      '@@index([tenantId])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistUserDevice", "chemicalist_user_device", [
      'id          String    @id @default(uuid()) @db.Uuid',
      'userId      String    @db.Uuid',
      'deviceKey   String',
      'name        String?',
      'platform    String?',
      'userAgent   String?',
      'lastSeenAt  DateTime  @default(now())',
      'revokedAt   DateTime?',
      'createdAt   DateTime  @default(now())',
      '',
      '@@unique([userId, deviceKey])',
      '@@index([userId, revokedAt])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistUserCredential", "chemicalist_user_credential", [
      'id           String    @id @default(uuid()) @db.Uuid',
      'userId       String    @db.Uuid',
      'type         String',
      'provider     String    @default("local")',
      'identifier   String',
      'secretHash   String?',
      'verifiedAt   DateTime?',
      'metadata     Json?',
      'createdAt    DateTime  @default(now())',
      'updatedAt    DateTime  @updatedAt',
      '',
      '@@unique([provider, identifier])',
      '@@index([userId, type])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistRole", "chemicalist_role", [
      'id        String   @id @default(uuid()) @db.Uuid',
      'tenantId  String?  @db.Uuid',
      'key       String',
      'name      String',
      'isSystem  Boolean  @default(false)',
      'createdAt DateTime @default(now())',
      '',
      '@@unique([tenantId, key])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistRoleGroup", "chemicalist_role_group", [
      'id          String   @id @default(uuid()) @db.Uuid',
      'tenantId    String?  @db.Uuid',
      'key         String',
      'name        String',
      'description String?',
      'isSystem    Boolean  @default(false)',
      'createdAt   DateTime @default(now())',
      'updatedAt   DateTime @updatedAt',
      '',
      '@@unique([tenantId, key])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistRoleGroupRole", "chemicalist_role_group_role", [
      'roleGroupId String @db.Uuid',
      'roleId      String @db.Uuid',
      '',
      '@@id([roleGroupId, roleId])',
      '@@index([roleId])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistUserRoleGroup", "chemicalist_user_role_group", [
      'userId      String   @db.Uuid',
      'roleGroupId String   @db.Uuid',
      'tenantId    String?  @db.Uuid',
      'createdAt   DateTime @default(now())',
      '',
      '@@id([userId, roleGroupId])',
      '@@index([roleGroupId])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistPermissionGroup", "chemicalist_permission_group", [
      'id          String   @id @default(uuid()) @db.Uuid',
      'tenantId    String?  @db.Uuid',
      'key         String',
      'name        String',
      'description String?',
      'isSystem    Boolean  @default(false)',
      'createdAt   DateTime @default(now())',
      'updatedAt   DateTime @updatedAt',
      '',
      '@@unique([tenantId, key])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistPermissionGroupPermission", "chemicalist_permission_group_permission", [
      'permissionGroupId String @db.Uuid',
      'permissionId      String @db.Uuid',
      '',
      '@@id([permissionGroupId, permissionId])',
      '@@index([permissionId])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistPermission", "chemicalist_permission", [
      'id          String  @id @default(uuid()) @db.Uuid',
      'key         String  @unique',
      'description String?',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistRolePermission", "chemicalist_role_permission", [
      'roleId       String @db.Uuid',
      'permissionId String @db.Uuid',
      '',
      '@@id([roleId, permissionId])',
      '@@index([roleId])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistUserRole", "chemicalist_user_role", [
      'userId   String  @db.Uuid',
      'roleId   String  @db.Uuid',
      'tenantId String? @db.Uuid',
      '',
      '@@id([userId, roleId])',
      '@@index([userId])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistUserSession", "chemicalist_user_session", [
      'id          String    @id @default(uuid()) @db.Uuid',
      'userId      String    @db.Uuid',
      'deviceId    String?   @db.Uuid',
      'userAgent   String?',
      'ip          String?',
      'expiresAt   DateTime',
      'lastSeenAt  DateTime  @default(now())',
      'revokedAt   DateTime?',
      'createdAt   DateTime  @default(now())',
      '',
      '@@index([userId])',
      '@@index([userId, revokedAt])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistRefreshToken", "chemicalist_refresh_token", [
      'id            String    @id @default(uuid()) @db.Uuid',
      'userId        String    @db.Uuid',
      'sessionId     String    @db.Uuid',
      'tokenHash     String    @unique',
      'expiresAt     DateTime',
      'revokedAt     DateTime?',
      'replacedById  String?   @db.Uuid',
      'createdAt     DateTime  @default(now())',
      '',
      '@@index([userId, revokedAt])',
      '@@index([sessionId])',
      '@@index([expiresAt])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistEmailVerifyToken", "chemicalist_email_verify_token", [
      'id          String    @id @default(uuid()) @db.Uuid',
      'userId      String    @db.Uuid',
      'tokenHash   String    @unique',
      'email       String',
      'expiresAt   DateTime',
      'verifiedAt  DateTime?',
      'createdAt   DateTime  @default(now())',
      '',
      '@@index([userId, expiresAt])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistMobileVerifyToken", "chemicalist_mobile_verify_token", [
      'id          String    @id @default(uuid()) @db.Uuid',
      'userId      String    @db.Uuid',
      'tokenHash   String    @unique',
      'mobile      String',
      'expiresAt   DateTime',
      'verifiedAt  DateTime?',
      'createdAt   DateTime  @default(now())',
      '',
      '@@index([userId, expiresAt])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistAuditEntry", "chemicalist_audit_entry", [
      'id           String   @id @default(uuid()) @db.Uuid',
      'tenantId     String?  @db.Uuid',
      'actorId      String?',
      'actorEmail   String?',
      'action       String',
      'resourceType String?',
      'resourceId   String?',
      'outcome      String   @default("SUCCESS")',
      'ip           String?',
      'userAgent    String?',
      'requestId    String?',
      'metadata     Json?',
      'createdAt    DateTime @default(now())',
      '',
      '@@index([tenantId, createdAt])',
      '@@index([action])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistCountry", "chemicalist_country", [
      'id        String   @id @default(uuid()) @db.Uuid',
      'tenantId  String   @db.Uuid',
      'code      String',
      'name      String',
      'nativeName String?',
      'phoneCode String?',
      'isActive  Boolean  @default(true)',
      'createdAt DateTime @default(now())',
      'updatedAt DateTime @updatedAt',
      '',
      '@@unique([tenantId, code])',
      '@@index([tenantId, name])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistRegion", "chemicalist_region", [
      'id        String   @id @default(uuid()) @db.Uuid',
      'tenantId  String   @db.Uuid',
      'countryId String   @db.Uuid',
      'code      String',
      'name      String',
      'isActive  Boolean  @default(true)',
      'createdAt DateTime @default(now())',
      'updatedAt DateTime @updatedAt',
      '',
      '@@unique([tenantId, countryId, code])',
      '@@index([tenantId, countryId, name])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistCity", "chemicalist_city", [
      'id        String   @id @default(uuid()) @db.Uuid',
      'tenantId  String   @db.Uuid',
      'regionId  String   @db.Uuid',
      'code      String',
      'name      String',
      'isActive  Boolean  @default(true)',
      'createdAt DateTime @default(now())',
      'updatedAt DateTime @updatedAt',
      '',
      '@@unique([tenantId, regionId, code])',
      '@@index([tenantId, regionId, name])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistUserAddress", "chemicalist_user_address", [
      'id           String    @id @default(uuid()) @db.Uuid',
      'tenantId     String    @db.Uuid',
      'userId       String    @db.Uuid',
      'title        String',
      'countryId    String    @db.Uuid',
      'regionId     String    @db.Uuid',
      'cityId       String    @db.Uuid',
      'addressLine1 String',
      'addressLine2 String?',
      'postalCode   String?',
      'latitude     Float?',
      'longitude    Float?',
      'isDefault    Boolean   @default(false)',
      'deletedAt    DateTime?',
      'createdAt    DateTime  @default(now())',
      'updatedAt    DateTime  @updatedAt',
      '',
      '@@index([tenantId, userId, deletedAt])',
      '@@index([tenantId, countryId, regionId, cityId])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistNotification", "chemicalist_notification", [
      'id          String    @id @default(uuid()) @db.Uuid',
      'tenantId    String?   @db.Uuid',
      'recipientId String',
      'channel     String    @default("IN_APP")',
      'template    String',
      'title       String',
      'body        String    @db.Text',
      'status      String    @default("QUEUED")',
      'readAt      DateTime?',
      'sentAt      DateTime?',
      'metadata    Json?',
      'createdAt   DateTime  @default(now())',
      '',
      '@@index([recipientId, createdAt])',
      '@@index([tenantId])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistFileObject", "chemicalist_file_object", [
      'id          String   @id @default(uuid()) @db.Uuid',
      'tenantId    String?  @db.Uuid',
      'ownerId     String?',
      'fileName    String',
      'contentType String',
      'size        Int',
      'storageKey  String   @unique',
      'checksum    String?',
      'metadata    Json?',
      'createdAt   DateTime @default(now())',
      '',
      '@@index([tenantId])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistWorkflowDefinition", "chemicalist_workflow_definition", [
      'id        String   @id @default(uuid()) @db.Uuid',
      'scope     String   @default("global")',
      'tenantId  String?  @db.Uuid',
      'key       String',
      'name      String',
      'version   Int      @default(1)',
      'steps     Json',
      'active    Boolean  @default(true)',
      'createdAt DateTime @default(now())',
      'updatedAt DateTime @updatedAt',
      '',
      '@@unique([scope, key, version])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistWorkflowInstance", "chemicalist_workflow_instance", [
      'id           String    @id @default(uuid()) @db.Uuid',
      'definitionId String    @db.Uuid',
      'tenantId     String?   @db.Uuid',
      'status       String    @default("RUNNING")',
      'currentStep  Int       @default(0)',
      'context      Json',
      'history      Json',
      'lastError    String?',
      'startedAt    DateTime  @default(now())',
      'completedAt  DateTime?',
      'updatedAt    DateTime  @updatedAt',
      '',
      '@@index([definitionId, status])',
      '@@index([tenantId])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistModuleRegistration", "chemicalist_module_registration", [
      'id          String   @id @default(uuid()) @db.Uuid',
      'key         String   @unique',
      'lab         String',
      'studio      String?',
      'title       String',
      'version     String   @default("1.0.0")',
      'status      String   @default("INSTALLED")',
      'installedAt DateTime @default(now())',
      'updatedAt   DateTime @updatedAt',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistEntitlement", "chemicalist_entitlement", [
      'id         String    @id @default(uuid()) @db.Uuid',
      'tenantId   String    @db.Uuid',
      'moduleKey  String',
      'plan       String    @default("standard")',
      'status     String    @default("ACTIVE")',
      'validFrom  DateTime  @default(now())',
      'validUntil DateTime?',
      '',
      '@@unique([tenantId, moduleKey])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistFeatureFlag", "chemicalist_feature_flag", [
      'id          String   @id @default(uuid()) @db.Uuid',
      'scope       String   @default("global")',
      'tenantId    String?  @db.Uuid',
      'key         String',
      'enabled     Boolean  @default(false)',
      'value       Json?',
      'description String?',
      'createdAt   DateTime @default(now())',
      'updatedAt   DateTime @updatedAt',
      '',
      '@@unique([scope, key])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistIntegrationEndpoint", "chemicalist_integration_endpoint", [
      'id        String   @id @default(uuid()) @db.Uuid',
      'tenantId  String   @db.Uuid',
      'key       String',
      'url       String',
      'secret    String',
      'events    String[]',
      'active    Boolean  @default(true)',
      'createdAt DateTime @default(now())',
      'updatedAt DateTime @updatedAt',
      '',
      '@@unique([tenantId, key])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistIntegrationDelivery", "chemicalist_integration_delivery", [
      'id             String    @id @default(uuid()) @db.Uuid',
      'endpointId     String    @db.Uuid',
      'eventId        String',
      'eventType      String',
      'status         String    @default("PENDING")',
      'attempts       Int       @default(0)',
      'responseStatus Int?',
      'lastError      String?',
      'createdAt      DateTime  @default(now())',
      'deliveredAt    DateTime?',
      '',
      '@@index([endpointId, createdAt])',
    ]),
  );

  blocks.push(
    ...platformModel(schema, "ChemicalistSearchDocument", "chemicalist_search_document", [
      'id         String   @id @default(uuid()) @db.Uuid',
      'tenantId   String?  @db.Uuid',
      'entityType String',
      'entityId   String',
      'title      String',
      'body       String   @db.Text',
      'metadata   Json?',
      'createdAt  DateTime @default(now())',
      'updatedAt  DateTime @updatedAt',
      '',
      '@@unique([entityType, entityId])',
      '@@index([tenantId])',
    ]),
  );

  if (ctx.has("outbox")) {
    blocks.push(
      ...platformModel(schema, "ChemicalistOutboxMessage", "chemicalist_outbox_message", [
        'id            String    @id @default(uuid()) @db.Uuid',
        'eventId       String    @unique',
        'eventType     String',
        'aggregateType String',
        'aggregateId   String',
        'tenantId      String?',
        'payload       Json',
        'status        String    @default("PENDING")',
        'attempts      Int       @default(0)',
        'lastError     String?',
        'occurredAt    DateTime  @default(now())',
        'availableAt   DateTime  @default(now())',
        'publishedAt   DateTime?',
        'createdAt     DateTime  @default(now())',
        '',
        '@@index([status, availableAt])',
      ]),
    );
  }

  if (ctx.has("inbox")) {
    blocks.push(
      ...platformModel(schema, "ChemicalistProcessedMessage", "chemicalist_processed_message", [
        'id          String   @id @default(uuid()) @db.Uuid',
        'consumer    String',
        'messageId   String',
        'processedAt DateTime @default(now())',
        '',
        '@@unique([consumer, messageId])',
      ]),
    );
  }

  if (ctx.has("saga")) {
    blocks.push(
      ...platformModel(schema, "ChemicalistSagaState", "chemicalist_saga_state", [
        'id          String   @id @default(uuid()) @db.Uuid',
        'sagaType    String',
        'status      String   @default("PENDING")',
        'currentStep Int      @default(0)',
        'context     Json',
        'lastError   String?',
        'attempts    Int      @default(0)',
        'createdAt   DateTime @default(now())',
        'updatedAt   DateTime @updatedAt',
        '',
        '@@index([sagaType, status])',
      ]),
    );
  }

  if (ctx.persistence.database !== "mongodb") return blocks;
  return blocks
    .map((line) =>
      line
        .replace(
          /\bid\s+String\s+@id\s+@default\(uuid\(\)\)\s+@db\.Uuid/g,
          'id String @id @default(auto()) @map("_id") @db.ObjectId',
        )
        .replace(/@db\.Uuid/g, "@db.ObjectId")
        .replace(
          /@@id\(\[([^\]]+)\]\)/g,
          'id String @id @default(auto()) @map("_id") @db.ObjectId\n  @@unique([$1])',
        )
        .replace(/\s+@@schema\("[^"]+"\)/g, ""),
    );
}

function generatePrismaSchema(ctx) {
  const schema = ctx.persistence.schema;
  const enumBlocks = ctx.enums.map(
    (item) =>
      "enum " +
      item.name +
      " {\n" +
      item.values.map((value) => "  " + value).join("\n") +
      (ctx.persistence.database === "mongodb"
        ? ""
        : '\n  @@schema("' + schema + '")') +
      "\n}",
  );

  const modelBlocks = [];
  for (const manifest of ctx.appManifests) {
    for (const model of manifest.models) {
      const lines = ["model " + model.name + " {"];
      lines.push(
        ctx.persistence.database === "mongodb"
          ? '  id String @id @default(auto()) @map("_id") @db.ObjectId'
          : "  id String @id @default(uuid()) @db.Uuid",
      );
      // Tenancy is part of the platform: every business row is tenant-scoped.
      lines.push(
        ctx.persistence.database === "mongodb"
          ? "  tenantId String? @db.ObjectId"
          : "  tenantId String? @db.Uuid",
      );

      for (const field of model.writableFields) {
        lines.push(prismaFieldLine(field, ctx.persistence.database));
      }

      // Object side of every reference (Prisma requires both sides).
      for (const reference of (model.relations || []).filter(
        (relation) => relation.kind === "reference",
      )) {
        const ownerField = model.writableFields.find(
          (field) => field.name === reference.field,
        );
        const relationOptional = ownerField ? prismaOptional(ownerField) : false;
        const relationFieldName = reference.field.replace(/Id$/, "");
        lines.push(
          "  " +
            relationFieldName +
            " " +
            reference.to +
            (relationOptional ? "?" : "") +
            " @relation(fields: [" +
            reference.field +
            "], references: [id], onDelete: " +
            (relationOptional
              ? "SetNull"
              : ctx.persistence.database === "mongodb"
                ? "NoAction"
                : "Restrict") +
            ")",
        );
      }
      // Collection side of every relation pointing at this model.
      for (const collection of (model.relations || []).filter(
        (relation) => relation.kind === "collection",
      )) {
        lines.push("  " + collection.field + " " + collection.to + "[]");
      }

      lines.push(
        "  deletedAt DateTime?",
        "  createdAt DateTime @default(now())",
        "  updatedAt DateTime @updatedAt",
        "",
        "  @@index([tenantId])",
        '  @@map("' + snake(model.name) + '")',
        ...(ctx.persistence.database === "mongodb"
          ? []
          : ['  @@schema("' + schema + '")']),
        "}",
      );
      modelBlocks.push(lines.join("\n"));
    }
  }

  return [
    "// Prisma schema generated from the registered Chemicalist manifests.",
    "// Managed by the generator: edit manifests, then re-run `chemicalist generate`.",
    "",
    "generator client {",
    '  provider = "prisma-client-js"',
    "}",
    "",
    "datasource db {",
    '  provider = "' +
      (ctx.persistence.database === "mongodb" ? "mongodb" : "postgresql") +
      '"',
    '  url      = env("DATABASE_URL")',
    ...(ctx.persistence.database === "mongodb"
      ? []
      : ['  schemas  = ["' + schema + '"]']),
    "}",
    "",
    ...enumBlocks,
    "",
    ...modelBlocks,
    "",
    "// ---------------------------------------------------------------------------",
    "// Platform tables: identity, tenancy, audit, notification, files, workflow,",
    "// module registry, flags, search, integration and optional messaging.",
    "// ---------------------------------------------------------------------------",
    ...platformModelBlocks(ctx, schema),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Persistence model + mapper
// ---------------------------------------------------------------------------

function persistenceFieldType(field) {
  switch (field.baseType) {
    case "uuid":
    case "string":
    case "text":
      return "string";
    case "boolean":
      return "boolean";
    case "int":
    case "float":
      return "number";
    case "decimal":
      return "Prisma.Decimal";
    case "date":
    case "datetime":
      return "Date";
    case "json":
      return "Prisma.JsonValue";
    case "enum":
      return "Prisma" + field.enumName;
    default:
      return "unknown";
  }
}

function generatePersistenceModel(ctx, model) {
  const lines = ["import type { Prisma } from '@prisma/client';"];
  const relatedImports = new Set();
  for (const reference of model.references || []) {
    const related = ctx.modelFileByName(reference.model);
    relatedImports.add(
      "import type { " +
        related.names.persistenceModel +
        " } from '" +
        ctx.rel(model.paths.persistenceModel, related.paths.persistenceModel) +
        "';",
    );
  }
  for (const collection of model.collections || []) {
    const related = ctx.modelFileByName(collection.model);
    relatedImports.add(
      "import type { " +
        related.names.persistenceModel +
        " } from '" +
        ctx.rel(model.paths.persistenceModel, related.paths.persistenceModel) +
        "';",
    );
  }
  lines.push(...relatedImports);
  const enums = new Set();
  for (const field of model.writableFields) {
    if (field.enumName) enums.add(field.enumName);
  }
  if (enums.size) {
    lines.push(
      "import type { " +
        [...enums].sort().map((name) => name + " as Prisma" + name).join(", ") +
        " } from '@prisma/client';",
    );
  }
  lines.push(
    "",
    "/**",
    " * Row shape returned by Prisma for this model.",
    " * Kept separate from the domain model so the domain never imports Prisma.",
    " */",
    "export interface " + model.names.persistenceModel + " {",
    "  id: string;",
  );

  for (const field of model.writableFields) {
    const type = persistenceFieldType(field);
    const array = field.isArray ? "[]" : "";
    const nullable =
      !field.isArray && (field.nullable || field.optional) ? " | null" : "";
    lines.push("  " + field.name + ": " + type + array + nullable + ";");
  }
  for (const reference of model.references || []) {
    const related = ctx.modelFileByName(reference.model);
    lines.push("  " + reference.fieldName + "?: " + related.names.persistenceModel + " | null;");
  }
  for (const collection of model.collections || []) {
    const related = ctx.modelFileByName(collection.model);
    lines.push("  " + collection.field + "?: " + related.names.persistenceModel + "[];");
  }

  lines.push("  createdAt: Date;", "  updatedAt: Date;", "}");
  return lines.join("\n");
}

function generateMapper(ctx, model) {
  const enums = new Set();
  for (const field of model.writableFields) {
    if (field.enumName) enums.add(field.enumName);
  }
  const lines = [];
  if (enums.size) {
    lines.push(
      "import { " +
        [...enums].sort().join(", ") +
        " } from '" +
        ctx.rel(
          model.paths.prismaMapper,
          "src/labs/" +
            ctx.studio.manifest.labSlug +
            "/studios/" +
            ctx.studio.manifest.studioSlug +
            "/domain/enums/business-enums",
        ) +
        "';",
    );
  }
  lines.push(
    "import { Prisma } from '@prisma/client';",
    "import { " + model.name + " } from '" + ctx.rel(model.paths.prismaMapper, model.paths.domain) + "';",
    "import type { " + model.names.persistenceModel + " } from '" +
      ctx.rel(model.paths.prismaMapper, model.paths.persistenceModel) + "';",
  );
  if (model.fields.some((field) => field.baseType === "json")) {
    lines.push(
      "import type { JsonValue } from '" +
        ctx.rel(model.paths.prismaMapper, "src/shared/types/json") +
        "';",
    );
  }
  lines.push(
    "",
    "/** Explicit, type-safe mapping between the Prisma row and the domain model. */",
    "export class " + model.names.mapper + " {",
    "  static toDomain(row: " + model.names.persistenceModel + "): " + model.name + " {",
    "    const entity = new " + model.name + "();",
    "    entity.id = row.id;",
  );

  for (const field of model.writableFields) {
    const value = "row." + field.name;
    if (field.isArray) {
      lines.push("    entity." + field.name + " = [..." + value + "];");
    } else if (field.baseType === "decimal") {
      lines.push(
        "    entity." + field.name + " = " + value + " === null || " + value + " === undefined ? " +
          (field.nullable ? "null" : "0") + " : Number(" + value + ");",
      );
    } else if (field.baseType === "json") {
      lines.push(
        "    entity." + field.name + " = (" + value + " as unknown as JsonValue" +
          (field.nullable ? " | null" : "") + ");",
      );
    } else if (field.nullable) {
      lines.push(
        "    entity." + field.name + " = " + value +
          (field.baseType === "enum" ? " as " + linesSafeType(field) + " | null" : "") +
          ";",
      );
    } else {
      lines.push("    entity." + field.name + " = " + value + " as " + linesSafeType(field) + ";");
    }
  }

  for (const reference of model.references || []) {
    const related = ctx.modelFileByName(reference.model);
    const mapperImport = ctx.rel(model.paths.prismaMapper, related.paths.prismaMapper);
    if (!lines.includes("import { " + related.names.mapper + " } from '" + mapperImport + "';")) {
      lines.splice(
        lines.findIndex((line) => line.startsWith("import { Prisma }")),
        0,
        "import { " + related.names.mapper + " } from '" + mapperImport + "';",
      );
    }
    lines.push(
      "    entity." + reference.fieldName + " = row." + reference.fieldName +
        " ? " + related.names.mapper + ".toDomain(row." + reference.fieldName + ") : null;",
    );
  }
  for (const collection of model.collections || []) {
    const related = ctx.modelFileByName(collection.model);
    const mapperImport = ctx.rel(model.paths.prismaMapper, related.paths.prismaMapper);
    if (!lines.includes("import { " + related.names.mapper + " } from '" + mapperImport + "';")) {
      lines.splice(
        lines.findIndex((line) => line.startsWith("import { Prisma }")),
        0,
        "import { " + related.names.mapper + " } from '" + mapperImport + "';",
      );
    }
    lines.push(
      "    if (row." + collection.field + ") {",
      "      entity." + collection.field + " = row." + collection.field +
        ".map((item) => " + related.names.mapper + ".toDomain(item));",
      "    }",
    );
  }

  lines.push(
    "    entity.createdAt = row.createdAt;",
    "    entity.updatedAt = row.updatedAt;",
    "    return entity;",
    "  }",
    "",
    "  static toCreateData(entity: " + model.name + "): Prisma." + model.name + "CreateInput {",
    "    return {",
    ...(ctx.persistence.database === "mongodb" ? [] : ["      id: entity.id,"]),
    ...model.writableFields.map((field) => {
      if (field.baseType === "json") {
        return (
          "      " + field.name + ": (entity." + field.name + " ?? Prisma.JsonNull) as Prisma.InputJsonValue,"
        );
      }
      if (field.baseType === "decimal") {
        return "      " + field.name + ": entity." + field.name + " as unknown as Prisma.Decimal,";
      }
      return "      " + field.name + ": entity." + field.name + ",";
    }),
    "    } as unknown as Prisma." + model.name + "CreateInput;",
    "  }",
    "",
    "  static toUpdateData(changes: Partial<" + model.name + ">): Prisma." + model.name + "UpdateInput {",
    "    const data: Record<string, unknown> = {};",
    "    const patch = changes as Record<string, unknown>;",
    "    for (const key of " + JSON.stringify(model.writableFields.map((f) => f.name)) + ") {",
    "      if (patch[key] !== undefined) data[key] = patch[key];",
    "    }",
    "    return data as Prisma." + model.name + "UpdateInput;",
    "  }",
    "}",
    "",
  );
  return lines.join("\n");
}

function linesSafeType(field) {
  switch (field.baseType) {
    case "uuid":
    case "string":
    case "text":
      return "string";
    case "boolean":
      return "boolean";
    case "int":
    case "float":
      return "number";
    case "enum":
      return field.enumName;
    default:
      return "never";
  }
}

// ---------------------------------------------------------------------------
// Repository implementation
// ---------------------------------------------------------------------------

function generateRepository(ctx, model) {
  const delegate = camel(model.name);
  const fieldKeyType = model.writableFields.length
    ? model.writableFields.map((field) => "'" + field.name + "'").join(" | ")
    : "never";
  const customMethodLines = [];
  const customMethodEnums = new Set();
  for (const custom of model.customMethods) {
    const parameters = custom.fields
      .map((name) => {
        const field = model.writableFields.find((candidate) => candidate.name === name);
        if (field.baseType === "enum") customMethodEnums.add(field.enumName);
        return name + ": " + repositoryFieldType(field);
      })
      .join(", ");
    const where = custom.fields
      .map((name) => {
        const field = model.writableFields.find((candidate) => candidate.name === name);
        return (
          name +
          ": " +
          name +
          (field.baseType === "enum" ? " as Prisma" + field.enumName : "")
        );
      })
      .join(", ");
    const baseWhere = "this.where({ " + where + " })";
    if (custom.operation === "findOneBy") {
      customMethodLines.push(
        "  async " + custom.name + "(" + parameters + "): Promise<" + model.name + " | null> {",
        "    const row = await this.client." + delegate + ".findFirst({ where: " + baseWhere + ", include: " + JSON.stringify(includeObject(model)) + " });",
        "    return row ? " + model.names.mapper + ".toDomain(row) : null;",
        "  }",
        "",
      );
    } else if (custom.operation === "findManyBy") {
      customMethodLines.push(
        "  async " + custom.name + "(" + parameters + "): Promise<" + model.name + "[]> {",
        "    const rows = await this.client." + delegate + ".findMany({ where: " + baseWhere + ", include: " + JSON.stringify(includeObject(model)) + " });",
        "    return rows.map((row) => " + model.names.mapper + ".toDomain(row));",
        "  }",
        "",
      );
    } else if (custom.operation === "countBy") {
      customMethodLines.push(
        "  async " + custom.name + "(" + parameters + "): Promise<number> {",
        "    return this.client." + delegate + ".count({ where: " + baseWhere + " });",
        "  }",
        "",
      );
    } else {
      customMethodLines.push(
        "  async " + custom.name + "(" + parameters + "): Promise<boolean> {",
        "    return (await this.client." + delegate + ".count({ where: " + baseWhere + " })) > 0;",
        "  }",
        "",
      );
    }
  }
  const relationMethods = [];
  const relationFields = (model.references || []).map((reference) => reference.field);
  const relationKeyType = relationFields.length
    ? relationFields.map((field) => "'" + field + "'").join(" | ")
    : "never";
  for (const reference of model.references || []) {
    const targetDelegate = camel(reference.model);
    relationMethods.push(
      "      case '" + reference.field + "':",
      "        return (await this.client." + targetDelegate + ".count({ where: { id: relatedId, tenantId: TenantContext.require(), deletedAt: null } })) > 0;",
    );
  }
  const lines = [
    "import { Injectable } from '@nestjs/common';",
    "import type { Prisma } from '@prisma/client';",
    "import { PrismaService } from '" +
      ctx.rel(model.paths.repository, "src/infrastructure/database/prisma.service") +
      "';",
    "import { UnitOfWorkService } from '" +
      ctx.rel(model.paths.repository, "src/infrastructure/database/unit-of-work.service") +
      "';",
    "import { TenantContext } from '" +
      ctx.rel(model.paths.repository, "src/platform/tenancy/tenant-context") +
      "';",
    "import { " + model.name + " } from '" + ctx.rel(model.paths.repository, model.paths.domain) + "';",
      ...(customMethodEnums.size
        ? [
            "import type { " +
              [...customMethodEnums]
                .sort()
                .map((name) => name + " as Prisma" + name)
                .join(", ") +
              " } from '@prisma/client';",
          ]
        : []),
    "import type { " + model.names.repositoryContract + " } from '" +
      ctx.rel(model.paths.repository, model.paths.repositoryContract) + "';",
    "import { " + model.names.token + " } from '" +
      ctx.rel(model.paths.repository, model.paths.repositoryToken) + "';",
    "import type { " + model.name + "Filter } from '" +
      ctx.rel(model.paths.repository, model.paths.schema) + "';",
    "import { " + model.names.mapper + " } from '" +
      ctx.rel(model.paths.repository, model.paths.prismaMapper) + "';",
    "",
    "/**",
    " * Prisma implementation of the " + model.name + " repository contract.",
    " *",
    " * Every query is tenant-scoped from the verified identity and joins the active",
    " * unit of work (when one is open) instead of opening a second transaction.",
    " */",
    "@Injectable()",
    "export class " + model.names.repositoryImpl + " implements " + model.names.repositoryContract + " {",
    "  constructor(",
    "    private readonly prisma: PrismaService,",
    "    private readonly unitOfWork: UnitOfWorkService,",
    "  ) {}",
    "",
    "  private get client(): Prisma.TransactionClient {",
    "    return this.unitOfWork.client();",
    "  }",
    "",
    "  /** Tenant filter applied to every query; tenantId never comes from request data. */",
    "  private tenantWhere(): Prisma." + model.name + "WhereInput {",
    "    return { tenantId: TenantContext.require() };",
    "  }",
    "",
    "  private where(extra: Prisma." + model.name + "WhereInput): Prisma." + model.name + "WhereInput {",
    "    return { ...extra, ...this.tenantWhere(), deletedAt: null };",
    "  }",
    "",
    "  async findById(id: string): Promise<" + model.name + " | null> {",
    "    const row = await this.client." + delegate + ".findFirst({",
    "      where: this.where({ id }),",
    "      include: " + JSON.stringify(includeObject(model)) + ",",
    "    });",
    "    return row ? " + model.names.mapper + ".toDomain(row) : null;",
    "  }",
    "",
    "  async exists(id: string): Promise<boolean> {",
    "    const count = await this.client." + delegate + ".count({ where: this.where({ id }) });",
    "    return count > 0;",
    "  }",
    "",
    "  async findMany(filter: " + model.name + "Filter) {",
    "    const where = this.where(filter.where as Prisma." + model.name + "WhereInput);",
    "    const orderBy = [",
    "      ...filter.orderBy,",
    "    ] as Prisma." + model.name + "OrderByWithRelationInput[];",
    "    const [rows, total] = await Promise.all([",
    "      this.client." + delegate + ".findMany({",
    "        where,",
    "        skip: filter.skip,",
    "        take: filter.take,",
    "        orderBy,",
    "        include: " + JSON.stringify(includeObject(model)) + ",",
    "      }),",
    "      this.client." + delegate + ".count({ where }),",
    "    ]);",
    "    return { items: rows.map((row) => " + model.names.mapper + ".toDomain(row)), total };",
    "  }",
    "",
    "  async create(entity: " + model.name + "): Promise<" + model.name + "> {",
    "    const row = await this.client." + delegate + ".create({",
    "      data: {",
    "        ..." + model.names.mapper + ".toCreateData(entity),",
    "        tenantId: TenantContext.require(),",
    "      },",
    "      include: " + JSON.stringify(includeObject(model)) + ",",
    "    });",
    "    return " + model.names.mapper + ".toDomain(row);",
    "  }",
    "",
    "  async createOne(entity: " + model.name + "): Promise<" + model.name + "> {",
    "    return this.create(entity);",
    "  }",
    "",
    "  async createMany(entities: " + model.name + "[]): Promise<number> {",
    "    if (entities.length === 0) return 0;",
    "    const result = await this.client." + delegate + ".createMany({",
    "      data: entities.map((entity) => ({",
    "        ..." + model.names.mapper + ".toCreateData(entity),",
    "        tenantId: TenantContext.require(),",
    "      })) as Prisma." + model.name + "CreateManyInput[],",
    "    });",
    "    return result.count;",
    "  }",
    "",
    "  async update(id: string, changes: Partial<" + model.name + ">): Promise<" + model.name + " | null> {",
    "    const existing = await this.client." + delegate + ".findFirst({ where: this.where({ id }) });",
    "    if (!existing) return null;",
    "    const row = await this.client." + delegate + ".update({",
    "      where: { id: existing.id },",
    "      data: " + model.names.mapper + ".toUpdateData(changes),",
    "      include: " + JSON.stringify(includeObject(model)) + ",",
    "    });",
    "    return " + model.names.mapper + ".toDomain(row);",
    "  }",
    "",
    "  async updateOne(id: string, changes: Partial<" + model.name + ">): Promise<" + model.name + " | null> {",
    "    return this.update(id, changes);",
    "  }",
    "",
    "  async updateMany(where: Record<string, unknown>, changes: Partial<" + model.name + ">): Promise<number> {",
    "    const result = await this.client." + delegate + ".updateMany({",
    "      where: this.where(where as Prisma." + model.name + "WhereInput),",
    "      data: " + model.names.mapper + ".toUpdateData(changes),",
    "    });",
    "    return result.count;",
    "  }",
    "",
    "  async delete(id: string): Promise<boolean> {",
    "    return this.softDeleteOne(id);",
    "  }",
    "",
    "  async hardDeleteOne(id: string): Promise<boolean> {",
    "    const existing = await this.client." + delegate + ".findFirst({ where: { id, ...this.tenantWhere() } });",
    "    if (!existing) return false;",
    "    await this.client." + delegate + ".delete({ where: { id: existing.id } });",
    "    return true;",
    "  }",
    "",
    "  async hardDeleteMany(ids: string[]): Promise<number> {",
    "    if (ids.length === 0) return 0;",
    "    const result = await this.client." + delegate + ".deleteMany({ where: { id: { in: ids }, ...this.tenantWhere() } });",
    "    return result.count;",
    "  }",
    "",
    "  async softDeleteOne(id: string): Promise<boolean> {",
    "    const result = await this.client." + delegate + ".updateMany({",
    "      where: this.where({ id }),",
    "      data: { deletedAt: new Date() },",
    "    });",
    "    return result.count > 0;",
    "  }",
    "",
    "  async softDeleteMany(ids: string[]): Promise<number> {",
    "    if (ids.length === 0) return 0;",
    "    const result = await this.client." + delegate + ".updateMany({",
    "      where: this.where({ id: { in: ids } }),",
    "      data: { deletedAt: new Date() },",
    "    });",
    "    return result.count;",
    "  }",
    "",
    "  async restoreOne(id: string): Promise<boolean> {",
    "    const result = await this.client." + delegate + ".updateMany({",
    "      where: { id, ...this.tenantWhere(), deletedAt: { not: null } },",
    "      data: { deletedAt: null },",
    "    });",
    "    return result.count > 0;",
    "  }",
    "",
    "  async restoreMany(ids: string[]): Promise<number> {",
    "    if (ids.length === 0) return 0;",
    "    const result = await this.client." + delegate + ".updateMany({",
    "      where: { id: { in: ids }, ...this.tenantWhere(), deletedAt: { not: null } },",
    "      data: { deletedAt: null },",
    "    });",
    "    return result.count;",
    "  }",
    "",
    "  async getOneById(id: string): Promise<" + model.name + " | null> {",
    "    return this.findById(id);",
    "  }",
    "",
    "  async getAll(filter: " + model.name + "Filter) {",
    "    return this.findMany(filter);",
    "  }",
    "",
    "  async search(filter: " + model.name + "Filter) {",
    "    return this.findMany(filter);",
    "  }",
    "",
    "  async checkDuplicate(field: " + fieldKeyType + ", value: unknown, excludeId?: string): Promise<boolean> {",
    "    const where = { [field]: value, ...(excludeId ? { id: { not: excludeId } } : {}) };",
    "    return (await this.client." + delegate + ".count({ where: this.where(where as Prisma." + model.name + "WhereInput) })) > 0;",
    "  }",
    "",
    "  async checkRelation(field: " + relationKeyType + ", relatedId: string): Promise<boolean> {",
    "    switch (field) {",
    ...relationMethods,
    "      default:",
    "        return false;",
    "    }",
    "  }",
    "",
    "  async isExisted(id: string): Promise<boolean> {",
    "    return this.exists(id);",
    "  }",
    "",
    ...customMethodLines,
    "}",
    "",
  ];
  return lines.join("\n");
}

function repositoryFieldType(field) {
  switch (field.baseType) {
    case "string":
    case "text":
    case "uuid":
    case "enum":
      return "string";
    case "boolean":
      return "boolean";
    case "int":
    case "float":
    case "decimal":
      return "number";
    case "date":
    case "datetime":
      return "Date";
    default:
      return "unknown";
  }
}

function includeObject(model) {
  const include = {};
  for (const collection of model.collections || []) include[collection.field] = true;
  for (const reference of model.references || []) include[reference.fieldName] = true;
  return include;
}

module.exports = {
  generatePrismaSchema,
  generatePersistenceModel,
  generateMapper,
  generateRepository,
  prismaFieldLine,
  prismaScalarType,
};
