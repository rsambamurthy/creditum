/**
 * Loads the Creditum Core Field Library and core rules (shared, owner_scope = 'core') and provisions
 * reference tenants from seed/tenants/*.json. Idempotent: existing rows are left untouched.
 * Tenant values (currencies, limits, workflows) live in the seed JSON — configuration data, not code.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource, EntityManager } from 'typeorm';
import { CORE_SCOPE } from '../common/db-types';
import { newId } from '../common/tenant';
import { runWithContext } from '../common/request-context';
import { AppUser, Tenant } from '../modules/tenancy/tenancy.entities';
import { AuthorityLevel, ConfigParameter, FxRate, TenantCurrency, ValueListEntry } from '../modules/configuration/configuration.entities';
import { FieldDefinition } from '../modules/field-registry/field-registry.entities';
import { RuleDefinition } from '../modules/rules/rules.entities';
import { WorkflowDefinition } from '../modules/workflow/workflow.entities';
import { validateDefinition, WfDefinition } from '../modules/workflow/workflow-engine';
import { validateRule } from '../modules/rules/rule-evaluator';
import { AuditService } from '../modules/audit/audit.service';

export const SEED_DIR = join(__dirname, '..', '..', 'seed');
export const SYSTEM_ACTOR = { userId: '00000000-0000-0000-0000-000000000000', displayName: 'System (provisioning)', roles: ['system'] };

interface LibraryField { field_id: string; field_key: string; module: string; group: string; label: string; data_type: string; source_type: string;
  adapter: string | null; requirement: string; requirement_basis: string | null; configurable: string | null; origin: string; review_notes: string | null }

export async function seedCoreLibrary(ds: DataSource): Promise<number> {
  const lib = JSON.parse(readFileSync(join(SEED_DIR, 'creditum-core-field-library.v1.json'), 'utf8')) as { fields: LibraryField[] };
  const repo = ds.getRepository(FieldDefinition);
  const existing = new Set((await repo.find({ where: { ownerScope: CORE_SCOPE }, select: { fieldKey: true } })).map(f => f.fieldKey));
  const rows = lib.fields.filter(f => !existing.has(f.field_key)).map(f => repo.create({
    id: newId(), ownerScope: CORE_SCOPE, libraryId: f.field_id, fieldKey: f.field_key, moduleName: f.module, groupName: f.group, label: f.label,
    dataType: f.data_type, sourceType: f.source_type, adapter: f.adapter, requirement: f.requirement, requirementBasis: f.requirement_basis,
    configurable: f.configurable, origin: f.origin, reviewNotes: f.review_notes, storageLocation: 'core_column', rowVersion: 1 }));
  for (let i = 0; i < rows.length; i += 100) await repo.insert(rows.slice(i, i + 100));
  return rows.length;
}

interface RuleSeed { ruleKey: string; name: string; entityType: string; triggerOn: 'on_save' | 'on_submit'; condition: unknown; actions: [] }

async function insertRules(m: EntityManager, ownerScope: string, rules: RuleSeed[]) {
  const repo = m.getRepository(RuleDefinition);
  for (const r of rules) {
    validateRule(r);
    if (await repo.findOne({ where: { ownerScope, ruleKey: r.ruleKey } })) continue;
    await repo.insert({ id: newId(), ownerScope, ruleKey: r.ruleKey, name: r.name, entityType: r.entityType, triggerOn: r.triggerOn,
      conditionJson: JSON.stringify(r.condition), actionsJson: JSON.stringify(r.actions), isActive: true, rowVersion: 1,
      updatedBy: SYSTEM_ACTOR.userId, updatedAt: new Date() });
  }
}

export async function seedCoreRules(ds: DataSource) {
  const { rules } = JSON.parse(readFileSync(join(SEED_DIR, 'core-rules.json'), 'utf8')) as { rules: RuleSeed[] };
  await ds.transaction(m => insertRules(m, CORE_SCOPE, rules));
}

interface TenantSeed {
  tenant: { code: string; name: string };
  users: [string, string, string][];
  currencies: [string, string, number, string, boolean][];
  fxRates: [string, string, string][];
  parameters: { key: string; valueType: ConfigParameter['valueType']; value: string; description: string }[];
  valueLists: Record<string, [string, string][]>;
  authorityLevels: [string, string, number, string | null, string][];
  workflows: Record<string, WfDefinition>;
  rules: RuleSeed[];
}

export async function provisionTenant(ds: DataSource, seed: TenantSeed): Promise<'created' | 'exists'> {
  if (await ds.getRepository(Tenant).findOne({ where: { code: seed.tenant.code } })) return 'exists';
  const tenantId = newId();
  const now = new Date();
  await runWithContext({ tenantId, tenantCode: seed.tenant.code, actor: SYSTEM_ACTOR }, () => ds.transaction(async m => {
    await m.getRepository(Tenant).insert({ id: tenantId, code: seed.tenant.code, name: seed.tenant.name, status: 'active', createdAt: now });
    const audit = new AuditService(ds);
    await audit.initChain(m, tenantId);
    for (const [loginName, displayName, roles] of seed.users) {
      await m.getRepository(AppUser).insert({ id: newId(), tenantId, loginName, displayName, roleCodes: roles, isActive: true, createdAt: now });
    }
    for (const [code, name, minorUnits, roundingMode, isBase] of seed.currencies) {
      await m.getRepository(TenantCurrency).insert({ id: newId(), tenantId, code, name, minorUnits, roundingMode, isBase, isActive: true });
    }
    for (const [fromCode, toCode, rate] of seed.fxRates) {
      await m.getRepository(FxRate).insert({ id: newId(), tenantId, fromCode, toCode, rate, asOf: now });
    }
    for (const p of seed.parameters) {
      await m.getRepository(ConfigParameter).insert({ id: newId(), tenantId, paramKey: p.key, valueType: p.valueType, paramValue: p.value,
        description: p.description, rowVersion: 1, updatedBy: SYSTEM_ACTOR.userId, updatedAt: now });
    }
    for (const [listKey, entries] of Object.entries(seed.valueLists)) {
      let order = 0;
      for (const [code, label] of entries) {
        order += 1;
        await m.getRepository(ValueListEntry).insert({ id: newId(), tenantId, listKey, code, label, sortOrder: order, isActive: true });
      }
    }
    for (const [levelCode, name, rankNo, maxAmount, approverRole] of seed.authorityLevels) {
      await m.getRepository(AuthorityLevel).insert({ id: newId(), tenantId, levelCode, name, rankNo, maxAmount, approverRole });
    }
    for (const [requestType, def] of Object.entries(seed.workflows)) {
      validateDefinition(def);
      await m.getRepository(WorkflowDefinition).insert({ id: newId(), tenantId, requestType, definitionJson: JSON.stringify(def), isActive: true,
        rowVersion: 1, updatedBy: SYSTEM_ACTOR.userId, updatedAt: now });
    }
    await insertRules(m, tenantId, seed.rules);
    await audit.append(m, { action: 'tenant_provisioned', entityType: 'tenant', entityRef: seed.tenant.code,
      after: { name: seed.tenant.name, users: seed.users.length, currencies: seed.currencies.map(c => c[0]), parameters: seed.parameters.length } });
  }));
  return 'created';
}

export function referenceTenantSeeds(): TenantSeed[] {
  const dir = join(SEED_DIR, 'tenants');
  return readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as TenantSeed);
}

export async function seedAll(ds: DataSource) {
  const fields = await seedCoreLibrary(ds);
  await seedCoreRules(ds);
  const tenants: Record<string, string> = {};
  for (const t of referenceTenantSeeds()) tenants[t.tenant.code] = await provisionTenant(ds, t);
  return { coreFieldsInserted: fields, tenants };
}
