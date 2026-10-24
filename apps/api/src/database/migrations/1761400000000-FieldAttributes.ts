/** Field attributes by layer: core, market profile, tenant (see field-attributes.ts). Schema builder only. */
import { MigrationInterface, QueryRunner, Table } from 'typeorm';
import { T } from '../../common/db-types';
import { c, pk, uq } from './schema-helpers';

const TABLE = new Table({ name: 'field_attribute_sets', columns: [pk(), c('owner_scope', T.str(60)), c('field_key', T.str(160)),
  c('attributes_json', T.text()), c('row_version', T.int()), c('updated_by', T.id()), c('updated_at', T.ts())] });

export class FieldAttributes1761400000000 implements MigrationInterface {
  name = 'FieldAttributes1761400000000';
  async up(q: QueryRunner): Promise<void> {
    await q.createTable(TABLE, true);
    await q.createIndex(TABLE.name, uq(TABLE.name, 'uq_field_attribute_sets', ['owner_scope', 'field_key']));
  }
  async down(q: QueryRunner): Promise<void> {
    await q.dropTable(TABLE.name, true);
  }
}
