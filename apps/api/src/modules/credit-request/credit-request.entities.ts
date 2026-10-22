import { Column, Entity, Index, PrimaryColumn, VersionColumn } from 'typeorm';
import { T } from '../../common/db-types';

/**
 * Credit Request (SDD Section 3) — Phase 0 carries the identifying core columns only; the rest of
 * the core library is added module by module. Optimistic locking via row_version (SDD Section 26.1).
 */
@Entity({ name: 'credit_requests' })
@Index('uq_credit_requests_number', ['tenantId', 'requestNumber'], { unique: true })
export class CreditRequest {
  @PrimaryColumn(T.pk()) id: string;
  @Column({ ...T.id(), name: 'tenant_id' }) tenantId: string;
  @Column({ ...T.str(60), name: 'request_number' }) requestNumber: string;
  @Column({ ...T.str(250), name: 'borrower_name' }) borrowerName: string;
  @Column({ ...T.str(80), name: 'borrower_ref' }) borrowerRef: string;
  @Column({ ...T.str(60), name: 'request_type' }) requestType: string;
  @Column({ ...T.str(60), name: 'status' }) status: string;
  @Column({ ...T.dec(28, 8), name: 'requested_amount' }) requestedAmount: string;
  @Column({ ...T.str(3), name: 'currency_code' }) currencyCode: string;
  /** Requested amount in the tenant base currency, with the rate used — kept for reproducibility. */
  @Column({ ...T.dec(28, 8), name: 'base_amount' }) baseAmount: string;
  @Column({ ...T.dec(28, 12), name: 'fx_rate_used' }) fxRateUsed: string;
  @Column({ ...T.str(40), name: 'required_level' }) requiredLevel: string;
  @Column({ ...T.id(), name: 'maker_id' }) makerId: string;
  @VersionColumn({ ...T.int(), name: 'row_version' }) rowVersion: number;
  @Column({ ...T.ts(), name: 'created_at' }) createdAt: Date;
  @Column({ ...T.ts(), name: 'updated_at' }) updatedAt: Date;
}
