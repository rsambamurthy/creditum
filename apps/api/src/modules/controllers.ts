/**
 * HTTP surface for Phase 0. Every route requires sign-in (global AuthGuard) unless marked @Public;
 * configuration writes require the config_admin role and go through change governance.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { DataSource } from 'typeorm';
import { AuthService, Public, Roles, ROLE } from './auth/auth';
import { ConfigurationService, GovernanceService } from './configuration/configuration.service';
import { FieldRegistryService } from './field-registry/field-registry.service';
import { RulesService } from './rules/rules.service';
import { WorkflowService } from './workflow/workflow.service';
import { CreditRequestService } from './credit-request/credit-request.service';
import { AuditService } from './audit/audit.service';
import { FormsService } from './forms/forms.service';
import { requireActor, context } from '../common/request-context';
import { Tenant } from './tenancy/tenancy.entities';

const DECIMAL = /^-?\d+(\.\d+)?$/;
const CREDIT_ROLES = [ROLE.relationshipOfficer, ROLE.creditAnalyst, ROLE.creditRisk, ROLE.committee, ROLE.seniorCommittee, ROLE.executiveCommittee, ROLE.creditAdmin, ROLE.auditor];

// ---------------------------------------------------------------- DTOs
class DevLoginDto { @IsString() @IsNotEmpty() tenantCode: string; @IsString() @IsNotEmpty() loginName: string; }
class ParamDto {
  @IsString() @MaxLength(1000) value: string;
  @IsOptional() @IsIn(['decimal', 'integer', 'text', 'boolean', 'currency']) valueType?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsInt() expectedVersion?: number;
}
class DecisionDto { @IsBoolean() approve: boolean; @IsOptional() @IsString() @MaxLength(1000) note?: string; }
class OverrideDto {
  @IsOptional() @IsString() @MaxLength(250) labelOverride?: string;
  @IsOptional() @IsString() requirementOverride?: string;
  @IsOptional() @IsBoolean() hidden?: boolean;
  @IsOptional() @IsString() @MaxLength(500) helpText?: string;
  @IsOptional() @IsInt() expectedVersion?: number;
}
class CustomFieldDto {
  @IsString() @IsNotEmpty() @MaxLength(250) label: string; @IsString() @IsNotEmpty() module: string; @IsString() @IsNotEmpty() group: string;
  @IsString() dataType: string; @IsOptional() @IsString() requirement?: string; @IsOptional() @IsString() requirementBasis?: string;
}
class RuleDto {
  @IsString() @IsNotEmpty() name: string; @IsOptional() @IsString() entityType?: string; @IsOptional() @IsIn(['on_save', 'on_submit']) triggerOn?: string;
  @IsObject() condition: object; @IsArray() actions: unknown[]; @IsOptional() @IsBoolean() isActive?: boolean; @IsOptional() @IsInt() expectedVersion?: number;
}
class RuleTestDto { @IsObject() rule: { ruleKey: string; name: string; condition: unknown; actions: [] }; @IsObject() record: Record<string, unknown>; }
class WorkflowDto { @IsObject() definition: object; @IsOptional() @IsInt() expectedVersion?: number; }
class CreateRequestDto {
  @IsString() @IsNotEmpty() @MaxLength(250) borrowerName: string; @IsString() @IsNotEmpty() @MaxLength(80) borrowerRef: string;
  @IsString() @IsNotEmpty() requestType: string; @Matches(DECIMAL, { message: 'requestedAmount must be a decimal number sent as text' }) requestedAmount: string;
  @Matches(/^[A-Z]{3}$/) currencyCode: string; @IsOptional() @IsObject() fields?: Record<string, unknown>;
}
class UpdateRequestDto {
  @IsInt() expectedVersion: number;
  @IsOptional() @IsString() @MaxLength(250) borrowerName?: string; @IsOptional() @IsString() @MaxLength(80) borrowerRef?: string;
  @IsOptional() @IsString() requestType?: string; @IsOptional() @Matches(DECIMAL) requestedAmount?: string;
  @IsOptional() @Matches(/^[A-Z]{3}$/) currencyCode?: string; @IsOptional() @IsObject() fields?: Record<string, unknown>;
}
class ModuleDataDto {
  @IsInt() expectedVersion: number;
  @IsOptional() @IsObject() record?: Record<string, unknown>;
  @IsOptional() @IsObject() grids?: Record<string, { rowKey?: string; values: Record<string, unknown> }[]>;
}
class FormulaDto {
  @IsOptional() @IsIn(['active', 'pending']) status?: string; @IsOptional() @IsObject() expression?: object | null;
  @IsString() @IsNotEmpty() @MaxLength(1000) description: string; @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @IsInt() expectedVersion?: number;
}
class ValueListDto {
  @IsArray() entries: { code: string; label: string; active?: boolean }[];
}
class LayoutDto { @IsOptional() @IsObject() document?: object; @IsOptional() @IsBoolean() reset?: boolean; }
class FormulaCheckDto { @IsOptional() @IsIn(['active', 'pending']) status?: string; @IsOptional() @IsObject() expression?: object | null; }
class TransitionDto { @IsString() @IsNotEmpty() action: string; @IsInt() expectedVersion: number; @IsOptional() @IsString() @MaxLength(2000) remarks?: string; }

// ---------------------------------------------------------------- controllers
@Controller('health')
export class HealthController {
  constructor(private readonly ds: DataSource) {}
  @Public() @Get() health() { return { status: this.ds.isInitialized ? 'ok' : 'starting', db: this.ds.options.type }; }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly ds: DataSource) {}
  @Public() @Post('dev-login') @HttpCode(200) devLogin(@Body() b: DevLoginDto) { return this.auth.devLogin(b.tenantCode, b.loginName); }
  @Public() @Get('dev-users') devUsers(@Query('tenant') tenant: string) { return this.auth.devUsers(tenant); }
  @Get('me') async me() {
    const a = requireActor(); const ctx = context();
    const tenant = await this.ds.getRepository(Tenant).findOne({ where: { id: ctx.tenantId } });
    return { userId: a.userId, displayName: a.displayName, roles: a.roles, tenant: { code: ctx.tenantCode, name: tenant?.name } };
  }
}

@Controller('config')
export class ConfigController {
  constructor(private readonly config: ConfigurationService, private readonly gov: GovernanceService) {}
  @Get('parameters') params() { return this.config.listParams(); }
  @Put('parameters/:key') @Roles(ROLE.configAdmin) setParam(@Param('key') key: string, @Body() b: ParamDto) { return this.gov.submit('parameter', key, { ...b }); }
  @Get('currencies') currencies() { return this.config.listCurrencies(); }
  @Get('value-lists') listKeys() { return this.config.listKeys(); }
  @Get('value-lists/:key') valueList(@Param('key') key: string) { return this.config.valueList(key); }
  @Get('value-lists/:key/entries') @Roles(ROLE.configAdmin, ROLE.auditor) entries(@Param('key') key: string) { return this.config.allEntries(key); }
  @Put('value-lists/:key') @Roles(ROLE.configAdmin) setList(@Param('key') key: string, @Body() b: ValueListDto) { return this.gov.submit('value_list', key, { ...b }); }
  @Get('authority-levels') authority() { return this.config.authorityLevels(); }
  @Get('changes') @Roles(ROLE.configAdmin, ROLE.auditor) pending() { return this.gov.pending(); }
  @Post('changes/:id/decision') @Roles(ROLE.configAdmin) @HttpCode(200) decide(@Param('id') id: string, @Body() b: DecisionDto) { return this.gov.decide(id, b.approve, b.note); }
}

@Controller('fields')
export class FieldsController {
  constructor(private readonly registry: FieldRegistryService, private readonly gov: GovernanceService) {}
  @Get() list() { return this.registry.effective(); }
  @Put(':key/override') @Roles(ROLE.configAdmin) override(@Param('key') key: string, @Body() b: OverrideDto) { return this.gov.submit('field_override', key, { ...b }); }
  @Post('custom/:key') @Roles(ROLE.configAdmin) custom(@Param('key') key: string, @Body() b: CustomFieldDto) { return this.gov.submit('custom_field', key, { ...b }); }
}

@Controller('rules')
export class RulesController {
  constructor(private readonly rules: RulesService, private readonly gov: GovernanceService) {}
  @Get() list() { return this.rules.list(); }
  @Put(':key') @Roles(ROLE.configAdmin) upsert(@Param('key') key: string, @Body() b: RuleDto) { return this.gov.submit('rule', key, { ...b }); }
  @Post('test') @Roles(ROLE.configAdmin) @HttpCode(200) test(@Body() b: RuleTestDto) { return this.rules.test(b.rule as never, b.record); }
}

@Controller('workflows')
export class WorkflowController {
  constructor(private readonly wf: WorkflowService, private readonly gov: GovernanceService) {}
  @Get() list() { return this.wf.list(); }
  @Get(':requestType') async get(@Param('requestType') t: string) { const { row, def } = await this.wf.definition(t); return { ...row, definition: def }; }
  @Put(':requestType') @Roles(ROLE.configAdmin) put(@Param('requestType') t: string, @Body() b: WorkflowDto) { return this.gov.submit('workflow', t, { ...b }); }
}

@Controller('layout')
export class LayoutController {
  constructor(private readonly forms: FormsService, private readonly gov: GovernanceService) {}
  @Get() @Roles(...CREDIT_ROLES, ROLE.configAdmin) layout() { return this.forms.layout(); }
  @Get('admin') @Roles(ROLE.configAdmin, ROLE.auditor) admin() { return this.forms.layoutAdmin(); }
  @Put() @Roles(ROLE.configAdmin) put(@Body() b: LayoutDto) { return this.gov.submit('layout', 'credit_request', { ...b }); }
}

@Controller('formulas')
export class FormulasController {
  constructor(private readonly forms: FormsService, private readonly gov: GovernanceService) {}
  @Get() list() { return this.forms.listFormulas(); }
  @Put(':key') @Roles(ROLE.configAdmin) put(@Param('key') key: string, @Body() b: FormulaDto) { return this.gov.submit('formula', key, { ...b }); }
  @Delete(':key') @Roles(ROLE.configAdmin) revert(@Param('key') key: string) { return this.gov.submit('formula', key, { revert: true }); }
  @Post(':key/check') @Roles(ROLE.configAdmin) @HttpCode(200) check(@Param('key') key: string, @Body() b: FormulaCheckDto) { return this.forms.checkFormula(key, { ...b }); }
}

@Controller('credit-requests')
export class CreditRequestController {
  constructor(private readonly svc: CreditRequestService, private readonly wf: WorkflowService, private readonly forms: FormsService) {}
  @Get(':id/data') @Roles(...CREDIT_ROLES) data(@Param('id') id: string) { return this.forms.data(id); }
  @Put(':id/data') @Roles(ROLE.relationshipOfficer, ROLE.creditAnalyst) saveData(@Param('id') id: string, @Body() b: ModuleDataDto) { return this.forms.save(id, b); }
  @Get() @Roles(...CREDIT_ROLES) list() { return this.svc.list(); }
  @Get(':id') @Roles(...CREDIT_ROLES) get(@Param('id') id: string) { return this.svc.get(id); }
  @Get(':id/history') @Roles(...CREDIT_ROLES) history(@Param('id') id: string) { return this.wf.history(id); }
  @Post() @Roles(ROLE.relationshipOfficer) create(@Body() b: CreateRequestDto) { return this.svc.create(b); }
  @Put(':id') @Roles(ROLE.relationshipOfficer, ROLE.creditAnalyst) update(@Param('id') id: string, @Body() b: UpdateRequestDto) {
    const { expectedVersion, ...rest } = b; return this.svc.update(id, expectedVersion, rest);
  }
  @Post(':id/transitions') @Roles(...CREDIT_ROLES) @HttpCode(200) transition(@Param('id') id: string, @Body() b: TransitionDto) {
    return this.svc.transition(id, b.action, b.expectedVersion, b.remarks);
  }
}

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}
  @Get() @Roles(ROLE.auditor, ROLE.configAdmin) list(@Query('limit', new ParseIntPipe({ optional: true })) pageSize?: number,
                                                    @Query('beforeSeq', new ParseIntPipe({ optional: true })) beforeSeq?: number) {
    // guardrail-allow: API page-size bounds (operational paging, not a business threshold)
    return this.audit.list(Math.min(pageSize ?? 100, 500), beforeSeq);
  }
  @Get('verify') @Roles(ROLE.auditor, ROLE.configAdmin) verify() { return this.audit.verify(); }
}
