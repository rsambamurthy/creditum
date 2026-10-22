import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { T } from '../../common/db-types';

@Entity({ name: 'tenants' })
export class Tenant {
  @PrimaryColumn(T.pk()) id: string;
  @Index('uq_tenants_code', { unique: true })
  @Column({ ...T.str(40), name: 'code' }) code: string;
  @Column({ ...T.str(200), name: 'name' }) name: string;
  @Column({ ...T.str(20), name: 'status' }) status: string;
  @Column({ ...T.ts(), name: 'created_at' }) createdAt: Date;
}

@Entity({ name: 'app_users' })
@Index('uq_app_users_login', ['tenantId', 'loginName'], { unique: true })
export class AppUser {
  @PrimaryColumn(T.pk()) id: string;
  @Column({ ...T.id(), name: 'tenant_id' }) tenantId: string;
  @Column({ ...T.str(120), name: 'login_name' }) loginName: string;
  @Column({ ...T.str(200), name: 'display_name' }) displayName: string;
  /** Comma-separated role codes (portable; no array types). */
  @Column({ ...T.str(500), name: 'role_codes' }) roleCodes: string;
  @Column({ ...T.bool(), name: 'is_active' }) isActive: boolean;
  @Column({ ...T.ts(), name: 'created_at' }) createdAt: Date;
}
