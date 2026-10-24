/**
 * Field attributes service: resolves core → market → tenant layers for the current tenant and governs the
 * tenant layer (maker-checker, audit). The tenant's market is the configuration parameter "market.profile".
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager, In, Like } from 'typeorm';
import { FieldAttributeSet } from './field-registry.entities';
import { FieldRegistryService } from './field-registry.service';
import { FieldAttributes, mergeAttributes, validateAttributes } from './field-attributes';
import { ConfigParameter } from '../configuration/configuration.entities';
import { ConfigurationService, GovernanceService } from '../configuration/configuration.service';
import { CORE_SCOPE } from '../../common/db-types';
import { ConflictError, DomainError } from '../../common/errors';
import { newId, tenantWhere } from '../../common/tenant';
import { requireActor, requireTenant } from '../../common/request-context';

export const MARKET_PARAM = 'market.profile';
export const marketScope = (code: string) => `market:${code}`;

const TEXT_TYPES = new Set(['Text', 'Rich Text', 'Text (identifier)', 'Address (structured)']);
const DECIMAL_TYPES = new Set(['Currency Amount', 'Percentage', 'Ratio (decimal)', 'Decimal', 'Integer', 'Integer (days)']);
export const attributeKind = (dataType: string): 'text' | 'decimal' | 'other' => (TEXT_TYPES.has(dataType) ? 'text' : DECIMAL_TYPES.has(dataType) ? 'decimal' : 'other');

@Injectable()
export class FieldAttributesService implements OnModuleInit {
  constructor(private readonly ds: DataSource, private readonly registry: FieldRegistryService, private readonly config: ConfigurationService,
              private readonly governance: GovernanceService) {}

  onModuleInit() {
    this.governance.register('field_attributes', (m, ref, p) => this.apply(m, ref, p), (m, ref, p) => this.validate(m, ref, p));
    this.config.registerParamCheck(MARKET_PARAM, async (m, value) => {
      const markets = await this.markets(m);
      if (!markets.includes(value)) throw new DomainError('invalid_value', `Market "${value}" is not installed. Available: ${markets.join(', ')}`);
    });
  }

  async markets(m?: EntityManager): Promise<string[]> {
    const rows = await (m ?? this.ds.manager).getRepository(FieldAttributeSet).find({ where: { ownerScope: Like('market:%') }, select: { ownerScope: true } });
    return [...new Set(rows.map(r => r.ownerScope.slice('market:'.length)))].sort();
  }

  /** The tenant's market code, or null when the tenant has none configured. */
  async market(m?: EntityManager): Promise<string | null> {
    const p = await (m ?? this.ds.manager).getRepository(ConfigParameter).findOne({ where: tenantWhere<ConfigParameter>({ paramKey: MARKET_PARAM }) });
    return p?.paramValue ?? null;
  }

  private async layerRows(m: EntityManager, fieldKeys?: string[]) {
    const market = await this.market(m);
    const scopes = [CORE_SCOPE, requireTenant(), ...(market ? [marketScope(market)] : [])];
    const rows = await m.getRepository(FieldAttributeSet).find({ where: { ownerScope: In(scopes), ...(fieldKeys ? { fieldKey: In(fieldKeys) } : {}) } });
    return { market, rows };
  }

  /** Effective attributes of every field for the current tenant. */
  async effective(m?: EntityManager): Promise<Map<string, FieldAttributes>> {
    const { market, rows } = await this.layerRows(m ?? this.ds.manager);
    const tenant = requireTenant();
    const by = (scope: string) => new Map(rows.filter(r => r.ownerScope === scope).map(r => [r.fieldKey, JSON.parse(r.attributesJson) as FieldAttributes]));
    const core = by(CORE_SCOPE); const mk = market ? by(marketScope(market)) : new Map(); const own = by(tenant);
    const keys = new Set([...core.keys(), ...mk.keys(), ...own.keys()]);
    return new Map([...keys].map(k => [k, mergeAttributes(core.get(k), mk.get(k), own.get(k))]));
  }

  /** The three layers of one field, for the Field Library. */
  async layers(fieldKey: string) {
    const m = this.ds.manager;
    await this.registry.definition(fieldKey, m);
    const { market, rows } = await this.layerRows(m, [fieldKey]);
    const get = (scope: string) => rows.find(r => r.ownerScope === scope);
    const parse = (r?: FieldAttributeSet) => (r ? JSON.parse(r.attributesJson) as FieldAttributes : null);
    const core = parse(get(CORE_SCOPE)); const mk = market ? parse(get(marketScope(market))) : null; const tenantRow = get(requireTenant());
    return { fieldKey, market, core, marketLayer: mk, tenant: parse(tenantRow), tenantVersion: tenantRow?.rowVersion ?? null,
      effective: mergeAttributes(core, mk, parse(tenantRow)) };
  }

  async validate(m: EntityManager, fieldKey: string, p: Record<string, unknown>) {
    const def = await this.registry.definition(fieldKey, m);
    if (p.revert === true) {
      const own = await m.getRepository(FieldAttributeSet).findOne({ where: { ownerScope: requireTenant(), fieldKey } });
      if (!own) throw new DomainError('invalid_attributes', `"${def.label}" has no bank-level attributes to remove`);
      return;
    }
    const fields = new Set((await this.registry.effective(m)).map(f => f.fieldKey));
    validateAttributes(p.attributes, def.label, attributeKind(def.dataType), k => fields.has(k));
  }

  async apply(m: EntityManager, fieldKey: string, p: Record<string, unknown>) {
    await this.validate(m, fieldKey, p);
    const tenantId = requireTenant();
    const repo = m.getRepository(FieldAttributeSet);
    const existing = await repo.findOne({ where: { ownerScope: tenantId, fieldKey } });
    const before = existing ? JSON.parse(existing.attributesJson) : null;
    if (p.revert === true) {
      await repo.delete({ id: existing!.id, ownerScope: tenantId });
      return { before, after: { revertedTo: 'market and product defaults' } };
    }
    if (existing && p.expectedVersion !== undefined && p.expectedVersion !== existing.rowVersion) throw new ConflictError('These attributes were changed by someone else');
    const values = { attributesJson: JSON.stringify(p.attributes), updatedBy: requireActor().userId, updatedAt: new Date() };
    if (existing) await repo.update({ id: existing.id, ownerScope: tenantId }, { ...values, rowVersion: existing.rowVersion + 1 });
    else await repo.insert({ id: newId(), ownerScope: tenantId, fieldKey, ...values, rowVersion: 1 });
    return { before, after: p.attributes };
  }
}
