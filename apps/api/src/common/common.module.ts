import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service';
import { CryptoService } from './crypto/crypto.service';
import { RbacService } from '../rbac/rbac.service';

@Global()
@Module({ providers: [CryptoService, AuditService, RbacService], exports: [CryptoService, AuditService, RbacService] })
export class CommonModule {}
