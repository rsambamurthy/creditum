/** Schema-builder helpers shared by migrations: column definitions come from the portable T helper. */
import { ColumnOptions, TableColumnOptions, TableIndex } from 'typeorm';
import { T } from '../../common/db-types';

export function c(name: string, o: ColumnOptions, extra: Partial<TableColumnOptions> = {}): TableColumnOptions {
  return {
    name,
    type: String(o.type),
    length: o.length !== undefined ? String(o.length) : undefined,
    precision: o.precision ?? undefined,
    scale: o.scale ?? undefined,
    isNullable: o.nullable === true,
    ...extra,
  };
}
export const pk = (name = 'id') => c(name, T.id(), { isPrimary: true });
export const tenant = () => c('tenant_id', T.id());
export const uq = (table: string, name: string, cols: string[]) => new TableIndex({ name, columnNames: cols, isUnique: true });
export const ix = (name: string, cols: string[]) => new TableIndex({ name, columnNames: cols });

