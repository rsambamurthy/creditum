/**
 * Integrations (core banking connector): rows of a module table remember the system they came from and that
 * system's key for the row (a facility id, a collateral number); integration_runs records every pull and
 * booking with its outcome. Schema builder only; summary_json is text parsed by the application, never queried.
 */
import { MigrationInterface, QueryRunner, Table, TableColumn } from 'typeorm';
import { T } from '../../common/db-types';
import { c, ix, pk, tenant } from './schema-helpers';

const RUNS = new Table({ name: 'integration_runs', columns: [pk(), tenant(), c('entity_type', T.str(60)), c('entity_id', T.id()),
  c('connector', T.str(40)), c('direction', T.str(20)), c('status', T.str(20)), c('trigger_name', T.str(40)),
  c('record_fields', T.text({ nullable: true })), c('summary_json', T.text({ nullable: true })), c('message', T.str(1000, { nullable: true })),
  c('actor_id', T.id()), c('started_at', T.ts()), c('finished_at', T.ts())] });

export class Integrations1761500000000 implements MigrationInterface {
  name = 'Integrations1761500000000';
  async up(q: QueryRunner): Promise<void> {
    await q.addColumn('form_rows', new TableColumn(c('source_system', T.str(40, { nullable: true }))));
    await q.addColumn('form_rows', new TableColumn(c('source_ref', T.str(120, { nullable: true }))));
    await q.createTable(RUNS, true);
    await q.createIndex(RUNS.name, ix('ix_integration_runs_entity', ['tenant_id', 'entity_type', 'entity_id', 'connector']));
  }
  async down(q: QueryRunner): Promise<void> {
    await q.dropTable(RUNS.name, true);
    await q.dropColumn('form_rows', 'source_ref');
    await q.dropColumn('form_rows', 'source_system');
  }
}
