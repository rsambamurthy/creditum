import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { T } from '../../common/db-types';

/**
 * Field / Schema Registry (SDD Section 19.1). Core-library fields have owner_scope = 'core';
 * a tenant's own custom fields have owner_scope = tenant id.
 */
@Entity({ name: 'field_definitions' })
@Index('uq_field_definitions', ['ownerScope', 'fieldKey'], { unique: true })
export class FieldDefinition {
  @PrimaryColumn(T.pk()) id: string;
  @Column({ ...T.id(), name: 'owner_scope' }) ownerScope: string;
  @Column({ ...T.str(20), name: 'library_id' }) libraryId: string;
  @Column({ ...T.str(160), name: 'field_key' }) fieldKey: string;
  @Column({ ...T.str(80), name: 'module_name' }) moduleName: string;
  @Column({ ...T.str(160), name: 'group_name' }) groupName: string;
  @Column({ ...T.str(250), name: 'label' }) label: string;
  @Column({ ...T.str(60), name: 'data_type' }) dataType: string;
  @Column({ ...T.str(120), name: 'source_type' }) sourceType: string;
  @Column({ ...T.str(120, { nullable: true }), name: 'adapter' }) adapter: string | null;
  @Column({ ...T.str(30), name: 'requirement' }) requirement: string;
  @Column({ ...T.str(500, { nullable: true }), name: 'requirement_basis' }) requirementBasis: string | null;
  @Column({ ...T.text({ nullable: true }), name: 'configurable_notes' }) configurable: string | null;
  @Column({ ...T.str(40), name: 'origin' }) origin: string;
  @Column({ ...T.str(500, { nullable: true }), name: 'review_notes' }) reviewNotes: string | null;
  @Column({ ...T.str(30), name: 'storage_location' }) storageLocation: 'core_column' | 'custom_extension';
  @Column({ ...T.int(), name: 'row_version' }) rowVersion: number;
}

/** Tenant-level presentation and requirement overrides of a field (no code change, SDD Section 20.1). */
@Entity({ name: 'tenant_field_overrides' })
@Index('uq_tenant_field_overrides', ['tenantId', 'fieldKey'], { unique: true })
export class TenantFieldOverride {
  @PrimaryColumn(T.pk()) id: string;
  @Column({ ...T.id(), name: 'tenant_id' }) tenantId: string;
  @Column({ ...T.str(160), name: 'field_key' }) fieldKey: string;
  @Column({ ...T.str(250, { nullable: true }), name: 'label_override' }) labelOverride: string | null;
  @Column({ ...T.str(30, { nullable: true }), name: 'requirement_override' }) requirementOverride: string | null;
  @Column({ ...T.bool(), name: 'is_hidden' }) hidden: boolean;
  @Column({ ...T.str(500, { nullable: true }), name: 'help_text' }) helpText: string | null;
  @Column({ ...T.int(), name: 'row_version' }) rowVersion: number;
  @Column({ ...T.id(), name: 'updated_by' }) updatedBy: string;
  @Column({ ...T.ts(), name: 'updated_at' }) updatedAt: Date;
}

/** row_key of values that belong to the record itself rather than to a grid row (portable: never NULL in the unique key). */
export const RECORD_ROW = 'record';

/**
 * Typed attribute-value storage for Credit Request module data and tenant custom fields — no JSON columns
 * (SDD Section 19.6, ADR 0002). row_key is RECORD_ROW for record-level values, or the form_rows id of a grid row.
 */
@Entity({ name: 'field_values' })
@Index('uq_field_values_row', ['tenantId', 'entityType', 'entityId', 'fieldKey', 'rowKey'], { unique: true })
export class FieldValue {
  @PrimaryColumn(T.pk()) id: string;
  @Column({ ...T.id(), name: 'tenant_id' }) tenantId: string;
  @Column({ ...T.str(60), name: 'entity_type' }) entityType: string;
  @Column({ ...T.id(), name: 'entity_id' }) entityId: string;
  @Column({ ...T.str(160), name: 'field_key' }) fieldKey: string;
  @Column({ ...T.id(), name: 'row_key' }) rowKey: string;
  @Column({ ...T.text({ nullable: true }), name: 'value_text' }) valueText: string | null;
  @Column({ ...T.dec(28, 8, { nullable: true }), name: 'value_decimal' }) valueDecimal: string | null;
  @Column({ ...T.ts({ nullable: true }), name: 'value_date' }) valueDate: Date | null;
  @Column({ ...T.bool({ nullable: true }), name: 'value_bool' }) valueBool: boolean | null;
}
