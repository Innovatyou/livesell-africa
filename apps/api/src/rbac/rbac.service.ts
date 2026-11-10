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
    await this.addMissingSystemRoles();
  }

  /** Stores created before a system role existed get it (idempotent; existing roles and members are untouched). */
  private async addMissingSystemRoles() {
    const perms = await this.prisma.permission.findMany({ select: { id: true, key: true } });
    const idByKey = new Map(perms.map((p) => [p.key, p.id]));
    let added = 0;
    for (const [key, def] of Object.entries(SYSTEM_ROLES) as [SystemRoleKey, (typeof SYSTEM_ROLES)[SystemRoleKey]][]) {
      const tenants = await this.prisma.tenant.findMany({ where: { roles: { none: { key } } }, select: { id: true }, take: 5000 });
      for (const t of tenants) {
        await this.prisma.role.create({
          data: { tenantId: t.id, key, name: def.name, isSystem: true, permissions: { create: def.permissions.map((p) => ({ permissionId: idByKey.get(p)! })) } },
        }).catch(() => undefined); // another instance added it at the same moment (unique tenant+key)
        added++;
      }
    }
    if (added) this.logger.log(`Added ${added} missing system role(s) to existing stores`);
  }

  /** Creates every system role for a new tenant; returns roleId by key. */
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
