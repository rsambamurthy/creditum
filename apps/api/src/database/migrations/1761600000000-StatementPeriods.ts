/**
 * One financial period = one statement (annual audited, annual unaudited or interim). The source template kept a
 * fiscal-year date and an interim date (each with its basis) and two auditor fields in every period column; they are
 * replaced by Statement Date, Statement Type, Months Covered, Basis and Auditor / Preparer Name.
 *
 * - field_definitions.lifecycle: null = active, 'retired' = kept for history, no longer on screens.
 * - Existing values move to the remaining fields when those are empty (an interim date becomes the statement date,
 *   with statement type "interim"); values that would overwrite something are dropped.
 * Schema builder and repositories only. The data move is not reversed by down().
 */
import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';
import { T } from '../../common/db-types';
import { FieldValue } from '../../modules/field-registry/field-registry.entities';
import { newId } from '../../common/tenant';
import { c } from './schema-helpers';

const H = 'e.financial_statement_header.';
const MOVES: [from: string, to: string][] = [
  [`${H}interim_financial_statement_date`, `${H}fiscal_year_financial_statement_date`],
  [`${H}interim_basis_standalone_consolidated`, `${H}fiscal_year_basis_standalone_consolidated`],
  [`${H}auditor_preparer_name`, `${H}auditor_name`],
];

export class StatementPeriods1761600000000 implements MigrationInterface {
  name = 'StatementPeriods1761600000000';

  async up(q: QueryRunner): Promise<void> {
    await q.addColumn('field_definitions', new TableColumn(c('lifecycle', T.str(20, { nullable: true }))));
    const repo = q.manager.getRepository(FieldValue);
    for (const [from, to] of MOVES) {
      for (const v of await repo.find({ where: { fieldKey: from } })) {
        const at = { tenantId: v.tenantId, entityType: v.entityType, entityId: v.entityId, rowKey: v.rowKey };
        if (await repo.findOne({ where: { ...at, fieldKey: to } })) { await repo.delete({ id: v.id }); continue; }
        await repo.update({ id: v.id }, { fieldKey: to });
        if (from.endsWith('interim_financial_statement_date') && !(await repo.findOne({ where: { ...at, fieldKey: `${H}statement_type` } }))) {
          await repo.insert({ id: newId(), ...at, fieldKey: `${H}statement_type`, valueText: 'interim', valueDecimal: null, valueDate: null, valueBool: null });
        }
      }
    }
  }

  async down(q: QueryRunner): Promise<void> {
    await q.dropColumn('field_definitions', 'lifecycle');
  }
}
