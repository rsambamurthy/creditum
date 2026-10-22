import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { T } from '../../common/db-types';

/** Tenant currency catalog (SDD Section 18.4). Scale and rounding are configuration, never code. */
@Entity({ name: 'tenant_currencies' })
@Index('uq_tenant_currencies', ['tenantId', 'code'], { unique: true })
export class TenantCurrency {
  @PrimaryColumn(T.pk()) id: string;
  @Column({ ...T.id(), name: 'tenant_id' }) tenantId: string;
  @Column({ ...T.str(3), name: 'currency_code' }) code: string;
  @Column({ ...T.str(120), name: 'currency_name' }) name: string;
  @Column({ ...T.int(), name: 'minor_units' }) minorUnits: number;
  @Column({ ...T.str(20), name: 'rounding_mode' }) roundingMode: string;
  @Column({ ...T.bool(), name: 'is_base' }) isBase: boolean;
  @Column({ ...T.bool(), name: 'is_active' }) isActive: boolean;
}

@Entity({ name: 'tenant_fx_rates' })
@Index('ix_tenant_fx_rates', ['tenantId', 'fromCode', 'toCode', 'asOf'])
export class FxRate {
  @PrimaryColumn(T.pk()) id: string;
  @Column({ ...T.id(), name: 'tenant_id' }) tenantId: string;
  @Column({ ...T.str(3), name: 'from_code' }) fromCode: string;
  @Column({ ...T.str(3), name: 'to_code' }) toCode: string;
  @Column({ ...T.dec(28, 12), name: 'rate' }) rate: string;
  @Column({ ...T.ts(), name: 'as_of' }) asOf: Date;
}

/** Typed configuration parameter (thresholds, limits, schemes). There is no default in code for any key. */
@Entity({ name: 'config_parameters' })
@Index('uq_config_parameters', ['tenantId', 'paramKey'], { unique: true })
export class ConfigParameter {
  @PrimaryColumn(T.pk()) id: string;
  @Column({ ...T.id(), name: 'tenant_id' }) tenantId: string;
  @Column({ ...T.str(160), name: 'param_key' }) paramKey: string;
  @Column({ ...T.str(20), name: 'value_type' }) valueType: 'decimal' | 'integer' | 'text' | 'boolean' | 'currency';
  @Column({ ...T.str(1000), name: 'param_value' }) paramValue: string;
  @Column({ ...T.str(500, { nullable: true }), name: 'description' }) description: string | null;
  @Column({ ...T.int(), name: 'row_version' }) rowVersion: number;
  @Column({ ...T.id(), name: 'updated_by' }) updatedBy: string;
  @Column({ ...T.ts(), name: 'updated_at' }) updatedAt: Date;
}

/** Tenant value lists (request types, purpose codes, ID types, ...). */
@Entity({ name: 'value_list_entries' })
@Index('uq_value_list_entries', ['tenantId', 'listKey', 'code'], { unique: true })
export class ValueListEntry {
  @PrimaryColumn(T.pk()) id: string;
  @Column({ ...T.id(), name: 'tenant_id' }) tenantId: string;
  @Column({ ...T.str(80), name: 'list_key' }) listKey: string;
  @Column({ ...T.str(80), name: 'entry_code' }) code: string;
  @Column({ ...T.str(250), name: 'entry_label' }) label: string;
  @Column({ ...T.int(), name: 'sort_order' }) sortOrder: number;
  @Column({ ...T.bool(), name: 'is_active' }) isActive: boolean;
}

/** Delegated authority matrix (SDD Section 3.3). Limits are in the tenant base currency; null = unlimited. */
@Entity({ name: 'authority_levels' })
@Index('uq_authority_levels', ['tenantId', 'levelCode'], { unique: true })
export class AuthorityLevel {
  @PrimaryColumn(T.pk()) id: string;
  @Column({ ...T.id(), name: 'tenant_id' }) tenantId: string;
  @Column({ ...T.str(40), name: 'level_code' }) levelCode: string;
  @Column({ ...T.str(160), name: 'level_name' }) name: string;
  @Column({ ...T.int(), name: 'rank_no' }) rankNo: number;
  @Column({ ...T.dec(28, 8, { nullable: true }), name: 'max_amount' }) maxAmount: string | null;
  @Column({ ...T.str(60), name: 'approver_role' }) approverRole: string;
}

/** Configuration change awaiting a second administrator (maker-checker, SDD Section 26.1). */
@Entity({ name: 'config_changes' })
@Index('ix_config_changes', ['tenantId', 'status'])
export class ConfigChange {
  @PrimaryColumn(T.pk()) id: string;
  @Column({ ...T.id(), name: 'tenant_id' }) tenantId: string;
  @Column({ ...T.str(40), name: 'target_type' }) targetType: string;
  @Column({ ...T.str(200), name: 'target_ref' }) targetRef: string;
  @Column({ ...T.text(), name: 'payload' }) payload: string;
  @Column({ ...T.str(20), name: 'status' }) status: 'pending' | 'applied' | 'rejected';
  @Column({ ...T.id(), name: 'maker_id' }) makerId: string;
  @Column({ ...T.id({ nullable: true }), name: 'checker_id' }) checkerId: string | null;
  @Column({ ...T.str(1000, { nullable: true }), name: 'decision_note' }) decisionNote: string | null;
  @Column({ ...T.ts(), name: 'created_at' }) createdAt: Date;
  @Column({ ...T.ts({ nullable: true }), name: 'decided_at' }) decidedAt: Date | null;
}

/** Atomic per-tenant counters (request numbers). Incremented under a row lock. */
@Entity({ name: 'sequence_counters' })
@Index('uq_sequence_counters', ['tenantId', 'scopeKey'], { unique: true })
export class SequenceCounter {
  @PrimaryColumn(T.pk()) id: string;
  @Column({ ...T.id(), name: 'tenant_id' }) tenantId: string;
  @Column({ ...T.str(80), name: 'scope_key' }) scopeKey: string;
  @Column({ ...T.bigint(), name: 'next_value' }) nextValue: number;
}
