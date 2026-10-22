import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { FieldDefinition, FieldValue, TenantFieldOverride } from './field-registry.entities';
import { GovernanceService } from '../configuration/configuration.service';
import { newId, tenantWhere, visibleScopes } from '../../common/tenant';
import { requireActor, requireTenant } from '../../common/request-context';
import { ConflictError, DomainError, NotFoundError } from '../../common/errors';
import { CORE_SCOPE } from '../../common/db-types';
import { isDecimalText } from '../../common/decimal';

const REQUIREMENTS = ['Mandatory', 'Conditional', 'Optional', 'System-populated'];
const EXTENSION_TYPES: Record<string, 'text' | 'decimal' | 'date' | 'bool'> = {
  'Text': 'text', 'Rich Text': 'text', 'Text (identifier)': 'text', 'Dropdown': 'text', 'Currency Code': 'text',
  'Currency Amount': 'decimal', 'Percentage': 'decimal', 'Ratio (decimal)': 'decimal', 'Decimal': 'decimal', 'Integer': 'decimal',
  'Date': 'date', 'Boolean (Yes/No)': 'bool',
};

export interface EffectiveField {
  fieldKey: string; libraryId: string; module: string; group: string; label: string; coreLabel: string; dataType: string; source: string;
  adapter: string | null; requirement: string; coreRequirement: string; hidden: boolean; helpText: string | null; origin: string;
  scope: 'core' | 'tenant'; configurable: string | null; reviewNotes: string | null; overrideVersion: number | null;
}

@Injectable()
export class FieldRegistryService implements OnModuleInit {
  constructor(private readonly ds: DataSource, private readonly governance: GovernanceService) {}

  onModuleInit() {
    this.governance.register('field_override', (m, ref, p) => this.applyOverride(m, ref, p), (m, ref, p) => this.validateOverride(m, ref, p));
    this.governance.register('custom_field', (m, ref, p) => this.applyCustomField(m, ref, p), (m, ref, p) => this.validateCustomField(m, ref, p));
  }

  /** The field set this tenant sees: core library + its custom fields, with its overrides applied. */
  async effective(m?: EntityManager): Promise<EffectiveField[]> {
    const mgr = m ?? this.ds.manager;
    const defs = await mgr.getRepository(FieldDefinition).find({ where: { ownerScope: In(visibleScopes()) }, order: { libraryId: 'ASC' } });
    const overrides = await mgr.getRepository(TenantFieldOverride).find({ where: tenantWhere<TenantFieldOverride>() });
    const ov = new Map(overrides.map(o => [o.fieldKey, o]));
    return defs.map(d => {
      const o = ov.get(d.fieldKey);
      return {
        fieldKey: d.fieldKey, libraryId: d.libraryId, module: d.moduleName, group: d.groupName, label: o?.labelOverride ?? d.label, coreLabel: d.label,
        dataType: d.dataType, source: d.sourceType, adapter: d.adapter, requirement: o?.requirementOverride ?? d.requirement, coreRequirement: d.requirement,
        hidden: o?.hidden ?? false, helpText: o?.helpText ?? null, origin: d.origin, scope: d.ownerScope === CORE_SCOPE ? 'core' : 'tenant',
        configurable: d.configurable, reviewNotes: d.reviewNotes, overrideVersion: o?.rowVersion ?? null,
      };
    });
  }

  async definition(fieldKey: string, m?: EntityManager): Promise<FieldDefinition> {
    const d = await (m ?? this.ds.manager).getRepository(FieldDefinition).findOne({ where: { ownerScope: In(visibleScopes()), fieldKey } });
    if (!d) throw new NotFoundError(`Field "${fieldKey}"`);
    return d;
  }

  async validateOverride(m: EntityManager, fieldKey: string, p: Record<string, unknown>) {
    await this.definition(fieldKey, m);
    if (p.requirementOverride != null && !REQUIREMENTS.includes(String(p.requirementOverride))) {
      throw new DomainError('invalid_value', `Requirement must be one of ${REQUIREMENTS.join(', ')}`);
    }
  }

  async applyOverride(m: EntityManager, fieldKey: string, p: Record<string, unknown>) {
    await this.validateOverride(m, fieldKey, p);
    const repo = m.getRepository(TenantFieldOverride);
    const existing = await repo.findOne({ where: tenantWhere<TenantFieldOverride>({ fieldKey }) });
    const actor = requireActor();
    const values = {
      labelOverride: (p.labelOverride as string) || null, requirementOverride: (p.requirementOverride as string) || null,
      hidden: p.hidden === true, helpText: (p.helpText as string) || null, updatedBy: actor.userId, updatedAt: new Date(),
    };
    if (existing) {
      if (p.expectedVersion !== undefined && p.expectedVersion !== existing.rowVersion) throw new ConflictError(`Field "${fieldKey}" was changed by someone else`);
      await repo.update(tenantWhere<TenantFieldOverride>({ id: existing.id }), { ...values, rowVersion: existing.rowVersion + 1 });
      return { before: { labelOverride: existing.labelOverride, requirementOverride: existing.requirementOverride, hidden: existing.hidden }, after: values };
    }
    await repo.insert({ id: newId(), tenantId: requireTenant(), fieldKey, ...values, rowVersion: 1 });
    return { before: null, after: values };
  }

  /** A tenant's own field, stored in the typed extension table — no schema change, no deployment. */
  async validateCustomField(m: EntityManager, fieldKey: string, p: Record<string, unknown>) {
    if (!/^x\.[a-z0-9_.]+$/.test(fieldKey)) throw new DomainError('invalid_value', 'Custom field keys start with "x." and use lower-case letters, digits, "_" and "."');
    if (!EXTENSION_TYPES[String(p.dataType)]) throw new DomainError('invalid_value', `Data type "${String(p.dataType)}" is not supported for custom fields`);
    if (!REQUIREMENTS.includes(String(p.requirement ?? 'Optional'))) throw new DomainError('invalid_value', `Requirement must be one of ${REQUIREMENTS.join(', ')}`);
    if (!p.label || !p.module || !p.group) throw new DomainError('invalid_value', 'label, module and group are required');
    if (await m.getRepository(FieldDefinition).findOne({ where: { ownerScope: In([CORE_SCOPE, requireTenant()]), fieldKey } })) {
      throw new ConflictError(`Field "${fieldKey}" already exists`);
    }
  }

  async applyCustomField(m: EntityManager, fieldKey: string, p: Record<string, unknown>) {
    await this.validateCustomField(m, fieldKey, p);
    const tenantId = requireTenant();
    const dataType = String(p.dataType);
    const requirement = String(p.requirement ?? 'Optional');
    const repo = m.getRepository(FieldDefinition);
    const row = { id: newId(), ownerScope: tenantId, libraryId: `TF-${fieldKey}`.slice(0, 20), fieldKey, moduleName: String(p.module), groupName: String(p.group),
      label: String(p.label), dataType, sourceType: 'Manual', adapter: null, requirement, requirementBasis: (p.requirementBasis as string) ?? null,
      configurable: null, origin: 'Tenant custom field', reviewNotes: null, storageLocation: 'custom_extension' as const, rowVersion: 1 };
    await repo.insert(row);
    return { before: null, after: row };
  }

  // ---------------------------------------------------------------- extension values
  async values(entityType: string, entityId: string, m?: EntityManager): Promise<Record<string, unknown>> {
    const rows = await (m ?? this.ds.manager).getRepository(FieldValue).find({ where: tenantWhere<FieldValue>({ entityType, entityId }) });
    return Object.fromEntries(rows.map(r => [r.fieldKey, r.valueText ?? r.valueDecimal ?? (r.valueDate ? r.valueDate.toISOString() : null) ?? r.valueBool]));
  }

  async saveValues(m: EntityManager, entityType: string, entityId: string, values: Record<string, unknown>) {
    const repo = m.getRepository(FieldValue);
    for (const [fieldKey, raw] of Object.entries(values)) {
      const def = await this.definition(fieldKey, m);
      const kind = EXTENSION_TYPES[def.dataType];
      if (!kind) throw new DomainError('invalid_value', `Field "${fieldKey}" (${def.dataType}) cannot be stored as an extension value`);
      const row = { valueText: null as string | null, valueDecimal: null as string | null, valueDate: null as Date | null, valueBool: null as boolean | null };
      if (raw !== null && raw !== undefined && raw !== '') {
        if (kind === 'text') row.valueText = String(raw);
        if (kind === 'decimal') {
          if (!isDecimalText(raw)) throw new DomainError('invalid_value', `Field "${fieldKey}" needs a decimal value sent as text`);
          row.valueDecimal = raw;
        }
        if (kind === 'date') {
          const d = new Date(String(raw)); if (Number.isNaN(d.getTime())) throw new DomainError('invalid_value', `Field "${fieldKey}" needs a date`);
          row.valueDate = d;
        }
        if (kind === 'bool') {
          if (typeof raw !== 'boolean') throw new DomainError('invalid_value', `Field "${fieldKey}" needs true or false`);
          row.valueBool = raw;
        }
      }
      const existing = await repo.findOne({ where: tenantWhere<FieldValue>({ entityType, entityId, fieldKey }) });
      if (existing) await repo.update(tenantWhere<FieldValue>({ id: existing.id }), row);
      else await repo.insert({ id: newId(), tenantId: requireTenant(), entityType, entityId, fieldKey, ...row });
    }
  }
}
