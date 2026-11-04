/**
 * New customers: a credit request may be raised for a borrower who is not yet in core banking, so the customer
 * number (credit_requests.borrower_ref) becomes optional. Whether it is required is tenant configuration
 * (credit_request.customer_number_required); core banking returns the number when the customer is created at booking.
 * Schema builder only.
 */
import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';
import { T } from '../../common/db-types';
import { c } from './schema-helpers';

export class NewCustomers1761700000000 implements MigrationInterface {
  name = 'NewCustomers1761700000000';

  async up(q: QueryRunner): Promise<void> {
    await q.changeColumn('credit_requests', 'borrower_ref', new TableColumn(c('borrower_ref', T.str(80, { nullable: true }))));
  }

  async down(q: QueryRunner): Promise<void> {
    await q.changeColumn('credit_requests', 'borrower_ref', new TableColumn(c('borrower_ref', T.str(80))));
  }
}
