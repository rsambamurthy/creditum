/**
 * Phase 2: Credit Request module data.
 *  - field_values gains row_key (record-level values use 'record'; grid rows use the form_rows id) and its
 *    unique key moves to (tenant, entity type, entity, field, row). Existing values become record-level.
 *  - form_rows (grid rows), form_layouts (screen layout documents), field_formulas (calculated fields).
 * Schema builder only (no SQL text); the drift test proves this matches the entities on every engine.
 */
import { MigrationInterface, Not, QueryRunner, Table, TableColumn } from 'typeorm';
import { FieldValue } from '../../modules/field-registry/field-registry.entities';
import { T } from '../../common/db-types';
import { c, ix, pk, tenant, uq } from './schema-helpers';

const RECORD_ROW = 'record'; // value of row_key for existing (record-level) values

const TABLES = [
  { table: new Table({ name: 'form_rows', columns: [pk(), tenant(), c('entity_type', T.str(60)), c('entity_id', T.id()), c('grid_code', T.str(80)),
      c('order_no', T.int())] }), indices: [ix('ix_form_rows_entity', ['tenant_id', 'entity_type', 'entity_id', 'grid_code'])] },
  { table: new Table({ name: 'form_layouts', columns: [pk(), c('owner_scope', T.id()), c('layout_key', T.str(60)), c('layout_version', T.int()),
      c('definition_json', T.text()), c('updated_at', T.ts())] }), indices: [uq('form_layouts', 'uq_form_layouts', ['owner_scope', 'layout_key'])] },
  { table: new Table({ name: 'field_formulas', columns: [pk(), c('owner_scope', T.id()), c('field_key', T.str(160)), c('status', T.str(20)),
      c('expression_json', T.text({ nullable: true })), c('description', T.str(1000)), c('note', T.str(1000, { nullable: true })),
      c('row_version', T.int()), c('updated_by', T.id()), c('updated_at', T.ts())] }),
    indices: [uq('field_formulas', 'uq_field_formulas', ['owner_scope', 'field_key'])] },
];

export class CreditRequestModules1761200000000 implements MigrationInterface {
  name = 'CreditRequestModules1761200000000';

  async up(q: QueryRunner): Promise<void> {
    await q.dropIndex('field_values', 'uq_field_values');
    const nullable = new TableColumn(c('row_key', T.id({ nullable: true })));
    await q.addColumn('field_values', nullable);
    // Every existing value is record-level. (The query builder resolves the entity, so the property name is used.)
    await q.manager.createQueryBuilder().update(FieldValue).set({ rowKey: RECORD_ROW }).execute();
    await q.changeColumn('field_values', nullable, new TableColumn(c('row_key', T.id())));
    await q.createIndex('field_values', uq('field_values', 'uq_field_values_row', ['tenant_id', 'entity_type', 'entity_id', 'field_key', 'row_key']));
    for (const { table, indices } of TABLES) {
      await q.createTable(table, true);
      for (const i of indices) await q.createIndex(table.name, i);
    }
  }

  async down(q: QueryRunner): Promise<void> {
    for (const { table } of [...TABLES].reverse()) await q.dropTable(table.name, true);
    await q.dropIndex('field_values', 'uq_field_values_row');
    await q.manager.createQueryBuilder().delete().from(FieldValue).where({ rowKey: Not(RECORD_ROW) }).execute();
    await q.dropColumn('field_values', 'row_key');
    await q.createIndex('field_values', uq('field_values', 'uq_field_values', ['tenant_id', 'entity_type', 'entity_id', 'field_key']));
  }
}
