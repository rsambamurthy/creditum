/**
 * Rules run in a defined context (ADR 0002 addendum): rule_definitions gains trigger_scope — for on_save the
 * contexts saved ("request" = the New/Edit Credit Request form, or module codes), for on_action the workflow
 * actions. Existing on_save rules ran on request create/edit, so they receive the "request" context.
 * Schema builder only; the stored list is JSON text parsed by the application, never queried by the database.
 */
import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';
import { RuleDefinition } from '../../modules/rules/rules.entities';
import { T } from '../../common/db-types';
import { c } from './schema-helpers';

export class RuleContexts1761300000000 implements MigrationInterface {
  name = 'RuleContexts1761300000000';

  async up(q: QueryRunner): Promise<void> {
    await q.addColumn('rule_definitions', new TableColumn(c('trigger_scope', T.text({ nullable: true }))));
    await q.manager.createQueryBuilder().update(RuleDefinition).set({ triggerScope: JSON.stringify(['request']) }).where({ triggerOn: 'on_save' }).execute();
  }

  async down(q: QueryRunner): Promise<void> {
    await q.dropColumn('rule_definitions', 'trigger_scope');
  }
}
