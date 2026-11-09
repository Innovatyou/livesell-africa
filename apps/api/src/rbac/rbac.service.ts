import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PERMISSIONS, SYSTEM_ROLES, SystemRoleKey } from './permissions';

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

@Injectable()
export class RbacService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RbacService.name);
  constructor(private readonly prisma: PrismaService) {}

  /** Keeps the permissions table in sync with the code catalogue on every boot (idempotent). */
  async onApplicationBootstrap() {
    for (const [key, description] of Object.entries(PERMISSIONS)) {
      await this.prisma.permission.upsert({ where: { key }, create: { key, description }, update: { description } });
    }
    this.logger.log(`Permission catalogue synced (${Object.keys(PERMISSIONS).length})`);
  }

  /** Creates the four system roles for a new tenant; returns roleId by key. */
  async createSystemRoles(tx: Tx, tenantId: string): Promise<Record<SystemRoleKey, string>> {
    const perms = await tx.permission.findMany({ select: { id: true, key: true } });
    const idByKey = new Map(perms.map((p) => [p.key, p.id]));
    const out = {} as Record<SystemRoleKey, string>;
    for (const [key, def] of Object.entries(SYSTEM_ROLES) as [SystemRoleKey, (typeof SYSTEM_ROLES)[SystemRoleKey]][]) {
      const role = await tx.role.create({
        data: {
          tenantId, key, name: def.name, isSystem: true,
          permissions: {
            create: def.permissions.map((p) => {
              const permissionId = idByKey.get(p);
              if (!permissionId) throw new Error(`Permission ${p} not seeded`);
              return { permissionId };
            }),
          },
        },
      });
      out[key] = role.id;
    }
    return out;
  }
}
