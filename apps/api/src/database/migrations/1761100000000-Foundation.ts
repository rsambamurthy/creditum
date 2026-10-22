/**
 * Phase 0 foundation schema.
 * Written with TypeORM's schema-builder API (no SQL text), using the same portable column helper
 * as the entities, so this one migration runs unchanged on PostgreSQL, SQL Server and Oracle.
 * A drift test (test/integration) fails if this migration and the entities ever disagree.
 */
import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';
import { T } from '../../common/db-types';
import { c, ix, pk, tenant, uq } from './schema-helpers';

const TABLES: { table: Table; indices: TableIndex[] }[] = [
  { table: new Table({ name: 'tenants', columns: [pk(), c('code', T.str(40)), c('name', T.str(200)), c('status', T.str(20)), c('created_at', T.ts())] }),
    indices: [uq('tenants', 'uq_tenants_code', ['code'])] },
  { table: new Table({ name: 'app_users', columns: [pk(), tenant(), c('login_name', T.str(120)), c('display_name', T.str(200)), c('role_codes', T.str(500)),
      c('is_active', T.bool()), c('created_at', T.ts())] }), indices: [uq('app_users', 'uq_app_users_login', ['tenant_id', 'login_name'])] },
  { table: new Table({ name: 'audit_events', columns: [pk(), tenant(), c('seq', T.bigint()), c('occurred_at_utc', T.str(30)), c('occurred_at', T.ts()),
      c('actor_id', T.id()), c('actor_name', T.str(200)), c('action_code', T.str(80)), c('entity_type', T.str(80)), c('entity_ref', T.str(160)),
      c('before_data', T.text({ nullable: true })), c('after_data', T.text({ nullable: true })), c('client_ip', T.str(64, { nullable: true })),
      c('session_ref', T.str(80, { nullable: true })), c('prev_hash', T.str(64)), c('record_hash', T.str(64))] }),
    indices: [uq('audit_events', 'uq_audit_events_seq', ['tenant_id', 'seq'])] },
  { table: new Table({ name: 'audit_chain_heads', columns: [pk('tenant_id'), c('last_seq', T.bigint()), c('last_hash', T.str(64))] }), indices: [] },
  { table: new Table({ name: 'tenant_currencies', columns: [pk(), tenant(), c('currency_code', T.str(3)), c('currency_name', T.str(120)),
      c('minor_units', T.int()), c('rounding_mode', T.str(20)), c('is_base', T.bool()), c('is_active', T.bool())] }),
    indices: [uq('tenant_currencies', 'uq_tenant_currencies', ['tenant_id', 'currency_code'])] },
  { table: new Table({ name: 'tenant_fx_rates', columns: [pk(), tenant(), c('from_code', T.str(3)), c('to_code', T.str(3)), c('rate', T.dec(28, 12)),
      c('as_of', T.ts())] }), indices: [ix('ix_tenant_fx_rates', ['tenant_id', 'from_code', 'to_code', 'as_of'])] },
  { table: new Table({ name: 'config_parameters', columns: [pk(), tenant(), c('param_key', T.str(160)), c('value_type', T.str(20)), c('param_value', T.str(1000)),
      c('description', T.str(500, { nullable: true })), c('row_version', T.int()), c('updated_by', T.id()), c('updated_at', T.ts())] }),
    indices: [uq('config_parameters', 'uq_config_parameters', ['tenant_id', 'param_key'])] },
  { table: new Table({ name: 'value_list_entries', columns: [pk(), tenant(), c('list_key', T.str(80)), c('entry_code', T.str(80)), c('entry_label', T.str(250)),
      c('sort_order', T.int()), c('is_active', T.bool())] }),
    indices: [uq('value_list_entries', 'uq_value_list_entries', ['tenant_id', 'list_key', 'entry_code'])] },
  { table: new Table({ name: 'authority_levels', columns: [pk(), tenant(), c('level_code', T.str(40)), c('level_name', T.str(160)), c('rank_no', T.int()),
      c('max_amount', T.dec(28, 8, { nullable: true })), c('approver_role', T.str(60))] }),
    indices: [uq('authority_levels', 'uq_authority_levels', ['tenant_id', 'level_code'])] },
  { table: new Table({ name: 'config_changes', columns: [pk(), tenant(), c('target_type', T.str(40)), c('target_ref', T.str(200)), c('payload', T.text()),
      c('status', T.str(20)), c('maker_id', T.id()), c('checker_id', T.id({ nullable: true })), c('decision_note', T.str(1000, { nullable: true })),
      c('created_at', T.ts()), c('decided_at', T.ts({ nullable: true }))] }), indices: [ix('ix_config_changes', ['tenant_id', 'status'])] },
  { table: new Table({ name: 'sequence_counters', columns: [pk(), tenant(), c('scope_key', T.str(80)), c('next_value', T.bigint())] }),
    indices: [uq('sequence_counters', 'uq_sequence_counters', ['tenant_id', 'scope_key'])] },
  { table: new Table({ name: 'field_definitions', columns: [pk(), c('owner_scope', T.id()), c('library_id', T.str(20)), c('field_key', T.str(160)),
      c('module_name', T.str(80)), c('group_name', T.str(160)), c('label', T.str(250)), c('data_type', T.str(60)), c('source_type', T.str(120)),
      c('adapter', T.str(120, { nullable: true })), c('requirement', T.str(30)), c('requirement_basis', T.str(500, { nullable: true })),
      c('configurable_notes', T.text({ nullable: true })), c('origin', T.str(40)), c('review_notes', T.str(500, { nullable: true })),
      c('storage_location', T.str(30)), c('row_version', T.int())] }),
    indices: [uq('field_definitions', 'uq_field_definitions', ['owner_scope', 'field_key'])] },
  { table: new Table({ name: 'tenant_field_overrides', columns: [pk(), tenant(), c('field_key', T.str(160)), c('label_override', T.str(250, { nullable: true })),
      c('requirement_override', T.str(30, { nullable: true })), c('is_hidden', T.bool()), c('help_text', T.str(500, { nullable: true })),
      c('row_version', T.int()), c('updated_by', T.id()), c('updated_at', T.ts())] }),
    indices: [uq('tenant_field_overrides', 'uq_tenant_field_overrides', ['tenant_id', 'field_key'])] },
  { table: new Table({ name: 'field_values', columns: [pk(), tenant(), c('entity_type', T.str(60)), c('entity_id', T.id()), c('field_key', T.str(160)),
      c('value_text', T.text({ nullable: true })), c('value_decimal', T.dec(28, 8, { nullable: true })), c('value_date', T.ts({ nullable: true })),
      c('value_bool', T.bool({ nullable: true }))] }),
    indices: [uq('field_values', 'uq_field_values', ['tenant_id', 'entity_type', 'entity_id', 'field_key'])] },
  { table: new Table({ name: 'rule_definitions', columns: [pk(), c('owner_scope', T.id()), c('rule_key', T.str(120)), c('rule_name', T.str(250)),
      c('entity_type', T.str(60)), c('trigger_on', T.str(30)), c('condition_json', T.text()), c('actions_json', T.text()), c('is_active', T.bool()),
      c('row_version', T.int()), c('updated_by', T.id()), c('updated_at', T.ts())] }),
    indices: [uq('rule_definitions', 'uq_rule_definitions', ['owner_scope', 'rule_key'])] },
  { table: new Table({ name: 'workflow_definitions', columns: [pk(), tenant(), c('request_type', T.str(60)), c('definition_json', T.text()), c('is_active', T.bool()),
      c('row_version', T.int()), c('updated_by', T.id()), c('updated_at', T.ts())] }),
    indices: [uq('workflow_definitions', 'uq_workflow_definitions', ['tenant_id', 'request_type'])] },
  { table: new Table({ name: 'workflow_events', columns: [pk(), tenant(), c('entity_id', T.id()), c('from_state', T.str(60)), c('to_state', T.str(60)),
      c('action_code', T.str(60)), c('actor_id', T.id()), c('actor_name', T.str(200)), c('remarks', T.str(2000, { nullable: true })), c('occurred_at', T.ts())] }),
    indices: [ix('ix_workflow_events_entity', ['tenant_id', 'entity_id'])] },
  { table: new Table({ name: 'credit_requests', columns: [pk(), tenant(), c('request_number', T.str(60)), c('borrower_name', T.str(250)),
      c('borrower_ref', T.str(80)), c('request_type', T.str(60)), c('status', T.str(60)), c('requested_amount', T.dec(28, 8)), c('currency_code', T.str(3)),
      c('base_amount', T.dec(28, 8)), c('fx_rate_used', T.dec(28, 12)), c('required_level', T.str(40)), c('maker_id', T.id()), c('row_version', T.int()),
      c('created_at', T.ts()), c('updated_at', T.ts())] }),
    indices: [uq('credit_requests', 'uq_credit_requests_number', ['tenant_id', 'request_number'])] },
];

export class Foundation1761100000000 implements MigrationInterface {
  name = 'Foundation1761100000000';
  async up(q: QueryRunner): Promise<void> {
    for (const { table, indices } of TABLES) {
      await q.createTable(table, true);
      for (const i of indices) await q.createIndex(table.name, i);
    }
  }
  async down(q: QueryRunner): Promise<void> {
    for (const { table } of [...TABLES].reverse()) await q.dropTable(table.name, true);
  }
}
