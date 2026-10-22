import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { T } from '../../common/db-types';

/** A row of a repeating section (grid) of a Credit Request. Its id is the row_key of the row's field values. */
@Entity({ name: 'form_rows' })
@Index('ix_form_rows_entity', ['tenantId', 'entityType', 'entityId', 'gridCode'])
export class FormRow {
  @PrimaryColumn(T.pk()) id: string;
  @Column({ ...T.id(), name: 'tenant_id' }) tenantId: string;
  @Column({ ...T.str(60), name: 'entity_type' }) entityType: string;
  @Column({ ...T.id(), name: 'entity_id' }) entityId: string;
  @Column({ ...T.str(80), name: 'grid_code' }) gridCode: string;
  @Column({ ...T.int(), name: 'order_no' }) orderNo: number;
}

/**
 * Screen layout document (modules → sections → fields), stored as text and parsed by the application.
 * owner_scope 'core' is the product layout; a tenant row (future) overrides it.
 */
@Entity({ name: 'form_layouts' })
@Index('uq_form_layouts', ['ownerScope', 'layoutKey'], { unique: true })
export class FormLayout {
  @PrimaryColumn(T.pk()) id: string;
  @Column({ ...T.id(), name: 'owner_scope' }) ownerScope: string;
  @Column({ ...T.str(60), name: 'layout_key' }) layoutKey: string;
  @Column({ ...T.int(), name: 'layout_version' }) layoutVersion: number;
  @Column({ ...T.text(), name: 'definition_json' }) definitionJson: string;
  @Column({ ...T.ts(), name: 'updated_at' }) updatedAt: Date;
}

/**
 * Formula of a calculated field. Core formulas have owner_scope 'core'; a tenant formula (owner_scope =
 * tenant id, changed through governance) replaces the core one for that tenant. status: active | pending.
 */
@Entity({ name: 'field_formulas' })
@Index('uq_field_formulas', ['ownerScope', 'fieldKey'], { unique: true })
export class FieldFormula {
  @PrimaryColumn(T.pk()) id: string;
  @Column({ ...T.id(), name: 'owner_scope' }) ownerScope: string;
  @Column({ ...T.str(160), name: 'field_key' }) fieldKey: string;
  @Column({ ...T.str(20), name: 'status' }) status: 'active' | 'pending';
  @Column({ ...T.text({ nullable: true }), name: 'expression_json' }) expressionJson: string | null;
  @Column({ ...T.str(1000), name: 'description' }) description: string;
  @Column({ ...T.str(1000, { nullable: true }), name: 'note' }) note: string | null;
  @Column({ ...T.int(), name: 'row_version' }) rowVersion: number;
  @Column({ ...T.id(), name: 'updated_by' }) updatedBy: string;
  @Column({ ...T.ts(), name: 'updated_at' }) updatedAt: Date;
}
