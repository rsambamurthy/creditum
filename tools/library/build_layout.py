#!/usr/bin/env python3
"""
Generates the Credit Request screen layout and the core formula set from the Creditum Core Field Library.

    python3 tools/library/build_layout.py

Inputs:  apps/api/seed/creditum-core-field-library.v1.json
Outputs: apps/api/seed/core-layout.json    (modules -> sections -> fields / grid columns, value-list keys)
         apps/api/seed/core-formulas.json  (calculated fields: expression, plain-language description, status)

The layout and formulas are product configuration data (owner scope 'core'). Tenants change labels,
requirements and visibility through field overrides, and may override a formula through governance.
Nothing here names a currency, threshold or rating scale: value lists and parameters are tenant data.
"""
import json
import sys
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SEED = ROOT / 'apps' / 'api' / 'seed'
LIB = json.loads((SEED / 'creditum-core-field-library.v1.json').read_text())
FIELDS = [f for f in LIB['fields'] if not f['module'].startswith('Workspace')]
BY_KEY = {f['field_key']: f for f in FIELDS}

LAYOUT_VERSION = 3
FORMULA_VERSION = 1

MODULES = [  # SDD module order; the letter is the field-key prefix
    ('a', 'borrower_profile', 'Borrower Profile'),
    ('b', 'facility_collateral', 'Facility & Collateral'),
    ('c', 'exposure_relationship', 'Exposure & Relationship'),
    ('d', 'business_profile', 'Business Profile'),
    ('e', 'financial_analysis', 'Financial Analysis'),
    ('f', 'esg_sustainability', 'ESG & Sustainability'),
    ('g', 'credit_administration', 'Credit Administration'),
]

# ------------------------------------------------------------------ value lists (dropdown -> tenant list key)
LIST_KEYS = {
    'customer_nationality': 'country', 'partner_nationality': 'country', 'country_dominant': 'country',
    'risk_rating': 'internal_rating', 'internal_rating_current': 'internal_rating', 'internal_rating_previous': 'internal_rating',
    'internal_rating_trigger_level': 'internal_rating',
    'external_rating_current': 'external_rating', 'external_rating_previous': 'external_rating',
    'external_rating_agency': 'rating_agency', 'rating_agency': 'rating_agency',
    'internal_esg_rating_pre_overlay': 'esg_rating', 'internal_esg_rating_post_overlay': 'esg_rating',
    'preliminary_transitional_risk_rating': 'esg_rating', 'final_transitional_risk_rating_after_overlay': 'esg_rating',
    'external_esg_rating': 'external_esg_rating', 'external_esg_rating_provider': 'esg_rating_provider',
    'customer_id_type': 'id_document_type', 'partner_id_type': 'id_document_type', 'identification_document_type': 'id_document_type',
    'approval_committee_level': 'committee_level',
    'limit_type': 'facility_type', 'product': 'facility_type',
    'request_action': 'line_action', 'proposed_action': 'line_action', 'covenant_action': 'line_action', 'action': 'line_action',
    'proposed_request_type': 'request_type', 'credit_request_type': 'request_type',
    'purpose': 'purpose_code', 'economic_sector_code': 'economic_sector', 'industry': 'economic_sector',
    'segment': 'customer_segment', 'customer_segment': 'customer_segment',
    'fiscal_year_basis_standalone_consolidated': 'statement_basis', 'interim_basis_standalone_consolidated': 'statement_basis',
    'seniority_level_trained_on_climate_risk': 'seniority_level', 'seniority_level_at_which_climate_risk_is_discussed': 'seniority_level',
    'seniority_level_receiving_regular_climate_risk_reports': 'seniority_level',
    'overall_social_risk_of_the_obligor': 'risk_level', 'overall_governance_risk_of_the_obligor': 'risk_level',
    'current_strategy': 'relationship_strategy', 'proposed_strategy': 'relationship_strategy',
    'interest_tiering_applicable': 'applicability', 'tiering_applicable_for': 'tiering_scope',
    'corporate_banking_decision_charge_if_applicable': 'fee_decision', 'covenant_check_result': 'covenant_result',
    'covenant_outcome_action': 'covenant_outcome', 'new_existing_customer': 'new_existing',
    'disbursement_single_multiple_tranches': 'disbursement_type', 'amortizing_or_bullet': 'repayment_type',
    'interest_frequency': 'frequency', 'leed_or_equivalent_certification_real_estate_clients_only': 'green_certification',
    'green_sustainable_project_category': 'green_project_category', 'booking_entity_branch': 'booking_branch',
    'collateral_type_reference': 'collateral_type',
}
PACKAGE_LIST_KEYS = {  # security-package dropdowns, by slug without the package suffix
    'facility_type': 'facility_type', 'calculation_method': 'coverage_calculation_method', 'collateral_type_reference': 'collateral_type',
    'nature_of_charge': 'nature_of_charge', 'own_or_other_collateral': 'own_or_other', 'facility_request': 'line_action',
    'collateral_request': 'collateral_action',
}

# Header bindings: library fields that duplicate the Credit Request header columns are shown from the header.
BINDINGS = {'a.general_information.name_of_borrower': 'borrowerName', 'a.general_information.customer_number': 'borrowerRef'}

DERIVED_DISPLAY = {'Chart (derived)': 'chart', 'Table (derived)': 'table', 'Section Heading': 'heading'}


def slug(key):
    return key.split('.', 2)[2]


def group_of(key):
    return key.split('.')[1]


def entry(key, list_key=None):
    f = BY_KEY[key]
    e = OrderedDict(key=key)
    if f['data_type'] == 'Dropdown':
        s = slug(key)
        e['list'] = list_key or LIST_KEYS.get(s, s)
    if key in BINDINGS:
        e['bind'] = BINDINGS[key]
    if f['data_type'] in DERIVED_DISPLAY:
        e['display'] = DERIVED_DISPLAY[f['data_type']]
    return e


# ------------------------------------------------------------------ section shapes
# grid groups: (record-level slugs, row label). Everything else in the group becomes a grid column.
GRIDS = {
    'partners': ([], 'Partner'), 'shareholders': (['shareholders_comments'], 'Shareholder'), 'legal_clauses': ([], 'Clause'),
    'comments': ([], 'Comment'), 'credit_facilities': (['exposure_as_of_date', 'borrower_customer_id', 'group_id'], 'Facility'),
    'guarantees': ([], 'Guarantee'), 'covenants': ([], 'Covenant'), 'collateral_not_in_a_package': ([], 'Collateral'),
    'pricing': (['client_name', 'credit_request_number'], 'Product'), 'roc_raroc_by_company': (['total_group_existing', 'total_group_proposed'], 'Company'),
    'commissions_fees': ([], 'Fee'), 'interest_tiering_applicability': ([], 'Account'),
    'client_group_exposure': (['relationship_officer_recommendation', 'credit_risk_recommendation', 'collateral_recommendation'], 'Company'),
    'cross_bank_exposure_borrower_group': (['comments'], 'Company'), 'cross_bank_exposure_guarantors': (['comments'], 'Guarantor'),
    'dealings_with_other_banks': ([], 'Bank'), 'guarantor_personal_net_worth_position': (['comments', 'comments_on_financial_position'], 'Guarantor'),
    'facility_booking_maintenance': ([], 'Limit'), 'collateral_booking_maintenance': ([], 'Collateral'),
}
PERIOD_GROUPS = ['financial_statement_header', 'income_statement', 'balance_sheet_assets', 'balance_sheet_liabilities_net_worth',
                 'contingent_liabilities_commitments', 'financial_ratios_summary']
PERIOD_GRID = 'e.financial_periods'
CREATE_FIELDS = ['a.client_request.client_request_details']
# Field whose value names a row (column headings of the period grid).
GRID_LABEL_FIELDS = {PERIOD_GRID: 'e.financial_statement_header.fiscal_year_financial_statement_date'}

PACKAGES = [('existing_package', 'Existing'), ('amended_package', 'Amended'), ('new_package', 'New')]
PKG_FACILITY = ['facility_type', 'facility_currency', 'facility_value', 'calculation_method', 'facility_request', 'facility_request_comments']
PKG_COLLATERAL = ['collateral_type_reference', 'collateral_currency', 'collateral_current_value', 'nature_of_charge', 'assigned',
                  'current_collateral_assigned_value', 'own_or_other_collateral', 'of_total', 'collateral_request', 'collateral_request_comments']


def package_sections(keys):
    """Security Package: per package (existing / amended / new) a header, facility lines and collateral lines."""
    out = []
    used = set()
    for suffix, title in PACKAGES:
        mine = [k for k in keys if slug(k).endswith('_' + suffix)]
        base = {k: slug(k)[: -len(suffix) - 1] for k in mine}
        fac = [k for k in mine if base[k] in PKG_FACILITY]
        col = [k for k in mine if base[k] in PKG_COLLATERAL]
        head = [k for k in mine if k not in fac and k not in col]
        used.update(mine)
        lk = lambda k: PACKAGE_LIST_KEYS.get(base[k])
        tag = suffix.split('_')[0]
        out.append(OrderedDict(code=f'b.security_package.{tag}', title=f'Security Package — {title}', kind='record',
                               fields=[entry(k, lk(k)) for k in head]))
        out.append(OrderedDict(code=f'b.security_package.{tag}.facilities', title=f'{title} package — facilities', kind='grid',
                               grid=f'b.sp_{tag}_facilities', rowLabel='Facility', fields=[], columns=[entry(k, lk(k)) for k in fac]))
        out.append(OrderedDict(code=f'b.security_package.{tag}.collateral', title=f'{title} package — collateral', kind='grid',
                               grid=f'b.sp_{tag}_collateral', rowLabel='Collateral', fields=[], columns=[entry(k, lk(k)) for k in col]))
    rest = [k for k in keys if k not in used]
    out.append(OrderedDict(code='b.security_package.proposal', title='Security Package — Proposal', kind='record', fields=[entry(k) for k in rest]))
    return out


def build_layout():
    groups = OrderedDict()
    for f in FIELDS:
        groups.setdefault((f['field_key'][0], group_of(f['field_key'])), []).append(f)
    modules = []
    for letter, code, title in MODULES:
        sections = []
        period_section_added = False
        for (lt, g), fs in groups.items():
            if lt != letter:
                continue
            keys = [f['field_key'] for f in fs]
            gtitle = fs[0]['group']
            if g == 'security_package':
                sections.extend(package_sections(keys))
            elif g in GRIDS:
                rec, row_label = GRIDS[g]
                sections.append(OrderedDict(code=f'{letter}.{g}', title=gtitle, kind='grid', grid=f'{letter}.{g}', rowLabel=row_label,
                                            fields=[entry(k) for k in keys if slug(k) in rec],
                                            columns=[entry(k) for k in keys if slug(k) not in rec]))
            elif g in PERIOD_GROUPS:
                sections.append(OrderedDict(code=f'{letter}.{g}', title=gtitle, kind='periods', grid=PERIOD_GRID, rowLabel='Period',
                                            fields=[entry(k) for k in keys if slug(k) == 'comments'],
                                            columns=[entry(k) for k in keys if slug(k) != 'comments']))
                period_section_added = True
            else:
                sections.append(OrderedDict(code=f'{letter}.{g}', title=gtitle, kind='record', fields=[entry(k) for k in keys]))
        modules.append(OrderedDict(code=code, letter=letter, title=title, sections=sections))
    # every library field (outside the workspace) appears exactly once
    placed = [e['key'] for m in modules for s in m['sections'] for e in s['fields'] + s.get('columns', [])]
    assert len(placed) == len(set(placed)), 'a field is placed twice'
    missing = set(BY_KEY) - set(placed)
    assert not missing, f'fields not placed: {sorted(missing)[:5]}'
    return OrderedDict(layout='credit_request', version=LAYOUT_VERSION,
                       note='Generated by tools/library/build_layout.py from the Core Field Library. Product configuration (owner scope core).',
                       grids=OrderedDict((s['grid'], OrderedDict(rowLabel=s['rowLabel'], ordered=s['kind'] == 'periods',
                                                                 **({'labelField': GRID_LABEL_FIELDS[s['grid']]} if s['grid'] in GRID_LABEL_FIELDS else {})))
                                         for m in modules for s in m['sections'] if s.get('grid')),
                       # fields shown on the New Credit Request form, besides the request header (record-level only)
                       createFields=CREATE_FIELDS,
                       modules=modules)


# ------------------------------------------------------------------ formulas
def f(key):
    return {'f': key}


def prev(key):
    return {'prev': key}


def add(*xs):
    return {'add': list(xs)}


def sub(a, b):
    return {'sub': [a, b]}


def mul(*xs):
    return {'mul': list(xs)}


def div(a, b):
    return {'div': [a, b]}


def pct(a, b):
    return {'pct': [a, b]}


def growth(key):
    return {'growth': [f(key), prev(key)]}


def cfg(key):
    return {'cfg': key}


def sum_grid(grid, expr):
    return {'sum': {'grid': grid, 'of': expr}}


def fx_base(amount, currency):
    return {'fx_base': [amount, currency]}


def rnd(expr, places):
    return {'round': [expr, places]}


IS = 'e.income_statement.'
BA = 'e.balance_sheet_assets.'
BL = 'e.balance_sheet_liabilities_net_worth.'
CL = 'e.contingent_liabilities_commitments.'
FR = 'e.financial_ratios_summary.'
SP = 'b.security_package.'
DAYS = cfg('calculation.days_in_year')

FORMULAS = []


def formula(key, expr, description, status='active', note=None):
    assert key in BY_KEY, key
    FORMULAS.append(OrderedDict(field=key, status=status, expression=expr, description=description, **({'note': note} if note else {})))


def pending(key, description, note):
    formula(key, None, description, status='pending', note=note)


# Borrower Profile
formula('a.deal_economics_relationship_profitability.total_relationship_income',
        add(*[f('a.deal_economics_relationship_profitability.' + s) for s in ['interest_income', 'retail_income', 'fx_income', 'lc_lg_commissions', 'fees_other_income']]),
        'Interest income + retail income + FX income + LC/LG commissions + fees and other income.')
for s, what in [('total_free_funds', 'free funds'), ('total_deposit', 'deposits'), ('total_investments', 'investments'), ('total_cash_limit', 'cash limits'),
                ('total_cash_limit_other_banks', 'cash limits at other banks'), ('total_cash_outstanding', 'cash outstanding'),
                ('total_cash_utilization_other_banks', 'cash utilisation at other banks'), ('total_non_cash_limit', 'non-cash limits'),
                ('total_non_cash_limit_other_banks', 'non-cash limits at other banks'), ('total_non_cash_outstanding', 'non-cash outstanding'),
                ('total_non_cash_utilization_other_banks', 'non-cash utilisation at other banks'), ('total_credit_card_limit', 'credit card limits'),
                ('total_card_outstanding_balance', 'card outstanding balances')]:
    pending('a.relationship_overview.' + s, f'Sum of the customer\'s {what}, in the base currency.',
            'Needs the account-level data from the core banking / credit bureau adapters (not part of the field library). '
            'Calculated by the adapter when it is connected; shown as pending until then.')
formula('a.comments.serial_no', {'row_no': True}, 'Running number of the comment (1, 2, 3 …) in the order shown.')
for s in ['transitional_risk_mitigation_score_pre_overlay', 'transitional_risk_mitigation_score_post_overlay', 'internal_esg_score_pre_overlay',
          'internal_esg_score_post_overlay', 'internal_esg_rating_pre_overlay', 'internal_esg_rating_post_overlay']:
    pending('a.esg_summary.' + s, 'ESG score / rating from the bank\'s ESG scoring methodology.',
            'Needs the bank\'s ESG methodology: question weights, overlay rules and the score-to-rating bands (tenant configuration).')
for s, src in [('physical_risk_score', 'f.physical_risk_assessment.physical_risk_score'),
               ('other_environmental_risk_score', 'f.other_environmental_risk_assessment.other_environmental_risk_score'),
               ('social_risk_score', 'f.social_risk_assessment.social_risk_score'),
               ('governance_risk_score', 'f.governance_risk_assessment.governance_risk_score')]:
    formula('a.esg_summary.' + s, f(src), f'Copied from the ESG & Sustainability module ({BY_KEY[src]["group"]}).')
for s, g in [('transitional_risk_score', 'transitional_risk_assessment'), ('physical_risk_score', 'physical_risk_assessment'),
             ('other_environmental_risk_score', 'other_environmental_risk_assessment'), ('social_risk_score', 'social_risk_assessment'),
             ('governance_risk_score', 'governance_risk_assessment')]:
    pending(f'f.{g}.{s}', 'Weighted score of the answers in this assessment.',
            'Needs the bank\'s ESG methodology: the weight and direction of each answer (tenant configuration).')
pending('f.esg_classification_transitional_rating.preliminary_transitional_risk_rating', 'Rating band of the transitional risk score.',
        'Needs the score-to-rating bands of the bank\'s ESG methodology (tenant configuration).')

# Facility & Collateral — existing security package (the existing package lines are integrated; totals are calculated)
fac, col = 'b.sp_existing_facilities', 'b.sp_existing_collateral'
fx = 'facility_value_existing_package'
formula(SP + 'total_existing_facility_value_base_reporting_currency_existing_package',
        sum_grid(fac, fx_base(f(SP + fx), f(SP + 'facility_currency_existing_package'))),
        'Sum of the facility values of the existing package, each converted to the base currency at the configured rate.')
formula(SP + 'total_existing_collateral_value_base_reporting_currency_existing_package',
        sum_grid(col, fx_base(f(SP + 'current_collateral_assigned_value_existing_package'), f(SP + 'collateral_currency_existing_package'))),
        'Sum of the collateral values assigned to the existing package, each converted to the base currency at the configured rate.',
        note='Uses the assigned value (current value × % assigned). Confirm whether the full current value should be used instead.')
formula(SP + 'actual_coverage_ratio_existing_package',
        div(f(SP + 'total_existing_collateral_value_base_reporting_currency_existing_package'),
            f(SP + 'total_existing_facility_value_base_reporting_currency_existing_package')),
        'Total collateral value ÷ total facility value of the existing package (both in base currency).')
formula(SP + 'of_total_existing_package',
        pct(fx_base(f(SP + 'current_collateral_assigned_value_existing_package'), f(SP + 'collateral_currency_existing_package')),
            f(SP + 'total_existing_collateral_value_base_reporting_currency_existing_package')),
        'This collateral\'s assigned value (base currency) as a percentage of the package\'s total collateral value.')
pending(SP + 'minimum_contractual_coverage_ratio_existing_package', 'Minimum coverage ratio agreed in the facility documentation.',
        'The library marks this as calculated, but it is a contractual term. Proposal: integrated from the collateral management system.')
formula('b.interest_tiering_applicability.serial_no', {'row_no': True}, 'Running number of the account (1, 2, 3 …).')

# Financial Analysis — one value per financial period; growth rates compare with the previous period
R = FR
rows = [
    ('revenue_sales', f(IS + 'net_sales_revenues'), 'Net sales / revenues from the income statement.'),
    ('cost_of_goods_sold_cogs', f(IS + 'cost_of_sales_revenues'), 'Cost of sales from the income statement.'),
    ('cogs_sales', div(f(R + 'cost_of_goods_sold_cogs'), f(R + 'revenue_sales')), 'COGS ÷ sales.'),
    ('gross_profit', sub(f(R + 'revenue_sales'), f(R + 'cost_of_goods_sold_cogs')), 'Sales − COGS.'),
    ('gross_profit_margin', pct(f(R + 'gross_profit'), f(R + 'revenue_sales')), 'Gross profit ÷ sales × 100.'),
    ('sg_a_expenses', f(IS + 'general_administrative_expense'), 'General & administrative expenses from the income statement.'),
    ('sg_a_sales', div(f(R + 'sg_a_expenses'), f(R + 'revenue_sales')), 'SG&A ÷ sales.'),
    ('net_operating_profit_nop', f(IS + 'net_operating_profit'), 'Net operating profit from the income statement.'),
    ('nop_margin', pct(f(R + 'net_operating_profit_nop'), f(R + 'revenue_sales')), 'NOP ÷ sales × 100.'),
    ('interest_coverage_nop', div(f(R + 'net_operating_profit_nop'), f(IS + 'interest_expense')), 'NOP ÷ interest expense.'),
    ('net_profit_before_unusual_items_npbui', f(IS + 'profit_before_extraordinary_items'), 'Profit before extraordinary items from the income statement.'),
    ('return_on_sales_ros', pct(f(R + 'net_profit_before_unusual_items_npbui'), f(R + 'revenue_sales')), 'NPBUI ÷ sales × 100.'),
    ('total_assets', f(BA + 'total_assets'), 'Total assets from the balance sheet.'),
    ('current_assets', f(BA + 'total_current_assets'), 'Total current assets from the balance sheet.'),
    ('total_liabilities', f(BL + 'total_liabilities'), 'Total liabilities from the balance sheet.'),
    ('net_worth', f(BL + 'total_net_worth'), 'Total net worth from the balance sheet.'),
    ('return_on_assets_roa_operating', pct(f(R + 'net_operating_profit_nop'), f(R + 'total_assets')), 'NOP ÷ total assets × 100.'),
    ('return_on_equity_roe_operating', pct(f(R + 'net_operating_profit_nop'), f(R + 'net_worth')), 'NOP ÷ net worth × 100.'),
    ('net_profit', f(IS + 'net_profit'), 'Net profit from the income statement.'),
    ('net_profit_margin', pct(f(R + 'net_profit'), f(R + 'revenue_sales')), 'Net profit ÷ sales × 100.'),
    ('return_on_assets_roa_net', pct(f(R + 'net_profit'), f(R + 'total_assets')), 'Net profit ÷ total assets × 100.'),
    ('return_on_equity_roe_net', pct(f(R + 'net_profit'), f(R + 'net_worth')), 'Net profit ÷ net worth × 100.'),
    ('sales_growth_rate', growth(R + 'revenue_sales'), '(Sales − previous period sales) ÷ |previous period sales| × 100.'),
    ('nop_growth_rate', growth(R + 'net_operating_profit_nop'), '(NOP − previous NOP) ÷ |previous NOP| × 100.'),
    ('net_profit_growth_rate', growth(R + 'net_profit'), '(Net profit − previous net profit) ÷ |previous net profit| × 100.'),
    ('operating_leverage', div(f(R + 'nop_growth_rate'), f(R + 'sales_growth_rate')),
     'Degree of operating leverage: NOP growth rate ÷ sales growth rate.'),
    ('current_assets_total_assets', div(f(R + 'current_assets'), f(R + 'total_assets')), 'Current assets ÷ total assets.'),
    ('accounts_receivable_days_doh', rnd(mul(div(f(BA + 'accounts_receivable_net'), f(R + 'revenue_sales')), DAYS), 0),
     'Accounts receivable ÷ sales × days in the year (tenant parameter calculation.days_in_year), rounded to whole days.'),
    ('inventory_days_doh', rnd(mul(div(f(BA + 'total_inventory'), f(R + 'cost_of_goods_sold_cogs')), DAYS), 0),
     'Inventory ÷ COGS × days in the year, rounded to whole days.'),
    ('accounts_payable_accruals_days_doh', rnd(mul(div(f(BL + 'accounts_payable_trade'), f(R + 'cost_of_goods_sold_cogs')), DAYS), 0),
     'Trade accounts payable ÷ COGS × days in the year, rounded to whole days.'),
    ('cash_conversion_cycle_days', sub(add(f(R + 'accounts_receivable_days_doh'), f(R + 'inventory_days_doh')), f(R + 'accounts_payable_accruals_days_doh')),
     'Receivable days + inventory days − payable days.'),
    ('interest_bearing_debt', add(f(BL + 'short_term_loans_payable_bank'), f(BL + 'current_portion_of_long_term_debt_cpltd_bank'), f(BL + 'long_term_debt_bank')),
     'Short-term bank loans + current portion of long-term debt + long-term bank debt.'),
    ('off_balance_sheet_liabilities', add(f(CL + 'letters_of_guarantee_lg'), f(CL + 'letters_of_credit_lc'), f(CL + 'other_commitments')),
     'Letters of guarantee + letters of credit + other commitments.'),
    ('leverage_ratio', div(f(R + 'total_liabilities'), f(R + 'net_worth')), 'Total liabilities ÷ net worth.'),
    ('leverage_tangible_net_worth', div(f(R + 'total_liabilities'), sub(f(R + 'net_worth'), f(BA + 'intangibles_net'))),
     'Total liabilities ÷ (net worth − net intangibles).'),
    ('gearing', div(f(R + 'interest_bearing_debt'), f(R + 'net_worth')), 'Interest-bearing debt ÷ net worth.'),
    ('current_ratio', div(f(R + 'current_assets'), f(BL + 'total_current_liabilities')), 'Current assets ÷ current liabilities.'),
    ('quick_ratio', div(sub(f(R + 'current_assets'), f(BA + 'total_inventory')), f(BL + 'total_current_liabilities')),
     '(Current assets − inventory) ÷ current liabilities.'),
    ('assets_growth_rate', growth(R + 'total_assets'), '(Total assets − previous) ÷ |previous| × 100.'),
    ('liabilities_growth_rate', growth(R + 'total_liabilities'), '(Total liabilities − previous) ÷ |previous| × 100.'),
    ('net_worth_growth_rate', growth(R + 'net_worth'), '(Net worth − previous) ÷ |previous| × 100.'),
    ('ebitda', add(f(R + 'net_operating_profit_nop'), f(IS + 'depreciation'), f(IS + 'amortization')), 'NOP + depreciation + amortisation.'),
    ('ebitda_margin', pct(f(R + 'ebitda'), f(R + 'revenue_sales')), 'EBITDA ÷ sales × 100.'),
    ('ebitda_growth_rate', growth(R + 'ebitda'), '(EBITDA − previous) ÷ |previous| × 100.'),
    ('net_debt_ebitda', div(sub(f(R + 'interest_bearing_debt'), add(f(BA + 'cash'), f(BA + 'time_deposits'))), f(R + 'ebitda')),
     '(Interest-bearing debt − cash − time deposits) ÷ EBITDA.'),
    ('interest_coverage_ebitda', div(f(R + 'ebitda'), f(IS + 'interest_expense')), 'EBITDA ÷ interest expense.'),
    ('financial_payments_coverage_ebitda', div(f(R + 'ebitda'), add(f(IS + 'interest_expense'), f(BL + 'current_portion_of_long_term_debt_cpltd_bank'))),
     'EBITDA ÷ (interest expense + current portion of long-term debt).'),
]
for s, expr, desc in rows:
    formula(R + s, expr, desc)
pending(R + 'direct_depreciation', 'Depreciation charged to cost of sales.',
        'The income statement carries one depreciation line. Proposal: add a "direct depreciation" line to the spread, or use the depreciation line.')
pending(R + 'breakeven_sales', 'Fixed costs ÷ contribution margin ratio.', 'Needs a fixed / variable cost split that the spread does not capture.')
pending(R + 'margin_of_safety', '(Sales − breakeven sales) ÷ sales × 100.', 'Depends on breakeven sales.')
pending(R + 'leasing_obligations_interest_bearing_debt', 'Lease obligations ÷ interest-bearing debt × 100.',
        'Needs a lease-obligations line in the balance sheet spread.')
pending(R + 'leverage_ratio_excl_p_a', 'Leverage ratio excluding "P.A.".', '"P.A." must be defined by the bank before a formula can be set.')
pending(R + 'gearing_excl_p_a', 'Gearing excluding "P.A.".', '"P.A." must be defined by the bank before a formula can be set.')
pending(R + 'adjusted_ebitda', 'EBITDA after the bank\'s normalisation adjustments.', 'Needs the list of adjustments the bank applies.')
pending(R + 'debt_adjusted_ebitda', 'Interest-bearing debt ÷ adjusted EBITDA.', 'Depends on adjusted EBITDA.')
pending(R + 'years_to_service_debt', 'Interest-bearing debt ÷ cash available for debt service.',
        'Needs the bank\'s definition of cash available for debt service (for example EBITDA − tax − capex).')


def build_formulas():
    seen = set()
    for x in FORMULAS:
        assert x['field'] not in seen, x['field']
        seen.add(x['field'])
    calculated = {k for k, v in BY_KEY.items() if v['source_type'].startswith('Calculated') and v['data_type'] not in DERIVED_DISPLAY}
    uncovered = sorted(calculated - seen)
    return OrderedDict(formulaSet='credit_request', version=FORMULA_VERSION,
                       note='Generated by tools/library/build_layout.py. Status "pending" = awaiting the bank\'s methodology; not evaluated.',
                       parameters=['calculation.days_in_year', 'calculation.rounding_mode'],
                       calculatedWithoutFormula=uncovered, formulas=FORMULAS)


if __name__ == '__main__':
    layout = build_layout()
    formulas = build_formulas()
    (SEED / 'core-layout.json').write_text(json.dumps(layout, indent=1, ensure_ascii=False) + '\n')
    (SEED / 'core-formulas.json').write_text(json.dumps(formulas, indent=1, ensure_ascii=False) + '\n')
    n_sections = sum(len(m['sections']) for m in layout['modules'])
    active = sum(1 for x in FORMULAS if x['status'] == 'active')
    print(f'layout: {len(layout["modules"])} modules, {n_sections} sections, {len(layout["grids"])} grids', file=sys.stderr)
    print(f'formulas: {active} active, {len(FORMULAS) - active} pending; calculated without formula: {formulas["calculatedWithoutFormula"]}', file=sys.stderr)
    lists = sorted({e['list'] for m in layout['modules'] for s in m['sections'] for e in s['fields'] + s.get('columns', []) if 'list' in e})
    print(f'value lists referenced ({len(lists)}): {lists}', file=sys.stderr)


# ------------------------------------------------------------------ Formula Specification (for review and approval)
CURRENT_GROUP = [None]


def label(key):
    fd = BY_KEY[key]
    return fd['label'] if fd['group'] == CURRENT_GROUP[0] else f'{fd["label"]} [{fd["group"]}]'


def render(e):
    (op, a), = e.items()
    if op == 'f':
        return label(a)
    if op == 'prev':
        return f'previous period {label(a)}'
    if op == 'cfg':
        return f'parameter `{a}`'
    if op == 'n':
        return a
    if op == 'row_no':
        return 'row number'
    if op == 'add':
        return '(' + ' + '.join(render(x) for x in a) + ')'
    if op == 'mul':
        return ' × '.join(render(x) for x in a)
    if op == 'sub':
        return f'({render(a[0])} − {render(a[1])})'
    if op == 'div':
        return f'{render(a[0])} ÷ {render(a[1])}'
    if op == 'pct':
        return f'{render(a[0])} ÷ {render(a[1])} × 100'
    if op == 'growth':
        return f'({render(a[0])} − {render(a[1])}) ÷ |{render(a[1])}| × 100'
    if op == 'round':
        return f'round({render(a[0])}, {a[1]} places)'
    if op == 'sum':
        return f'Σ over {a["grid"]} rows of [{render(a["of"])}]'
    if op == 'fx_base':
        return f'{render(a[0])} in base currency (rate for {render(a[1])})'
    raise ValueError(op)


def build_spec(layout, formulas):
    placed = {e['key']: (m['title'], s.get('grid')) for m in layout['modules'] for s in m['sections'] for e in s['fields'] + s.get('columns', [])}
    lines = ['# Creditum — Formula Specification', '',
             f'Formula set version {FORMULA_VERSION} · generated from `apps/api/seed/core-formulas.json` by `tools/library/build_layout.py` — do not edit by hand.', '',
             '## How calculated fields work', '',
             '- Every calculated field is recomputed by the server each time the Credit Request is saved; results are stored and audited.',
             '- Arithmetic is exact decimal (never floating point). Results are stored with 8 decimal places, or whole numbers for day counts, '
             'rounded with the tenant parameter `calculation.rounding_mode`.',
             '- Empty inputs are never treated as zero, except inside a sum ("+"), where an empty item counts as zero unless every item is empty. '
             'Division by zero gives an empty result.',
             '- Financial-period formulas are evaluated per period; growth rates compare with the previous period (periods are kept oldest first).',
             '- Foreign-currency amounts are converted to the tenant base currency at the latest configured rate; a line with no configured rate is left out.',
             '- A bank may replace any formula for itself through maker-checker configuration; the core formula stays unchanged for other tenants.',
             '- **Pending** formulas wait for the bank\'s methodology and are not calculated; the field shows "Formula pending approval".', '']
    active = [x for x in formulas['formulas'] if x['status'] == 'active']
    pend = [x for x in formulas['formulas'] if x['status'] == 'pending']
    lines += [f'**{len(active)} active · {len(pend)} pending.** Parameters used: ' + ', '.join(f'`{p}`' for p in formulas['parameters']) + '.', '']
    for title, items in [('Active formulas', active), ('Pending — decision needed', pend)]:
        lines += [f'## {title}', '']
        module = None
        for x in sorted(items, key=lambda x: ([m[2] for m in MODULES].index(placed[x['field']][0]), BY_KEY[x['field']]['field_id'])):
            mod, grid = placed[x['field']]
            if mod != module:
                if module is not None:
                    lines.append('')
                module = mod
                lines += [f'### {mod}', '', '| # | Field | Calculation | Formula | Notes |', '|---|---|---|---|---|']
            fd = BY_KEY[x['field']]
            CURRENT_GROUP[0] = fd['group']
            formula_txt = render(x['expression']) if x['expression'] else '—'
            scope = ' (per period)' if grid == PERIOD_GRID else (' (per row)' if grid else '')
            lines.append(f'| {fd["field_id"]} | **{fd["label"]}**{scope}<br>`{x["field"]}` | {x["description"]} | {formula_txt} | {x.get("note", "")} |')
        lines.append('')
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    spec = build_spec(build_layout(), build_formulas())
    (ROOT / 'docs' / 'specs' / 'formula-specification.md').write_text(spec)


# ------------------------------------------------------------------ core field attributes (product defaults; markets and banks override)
ATTR_BY_TYPE = {
    'Text': {'maxLength': 250, 'width': 'm'},
    'Text (identifier)': {'maxLength': 50, 'width': 's'},
    'Rich Text': {'maxLength': 20000, 'width': 'full', 'rows': 6},
    'Address (structured)': {'maxLength': 500, 'width': 'full', 'rows': 3},
    'Dropdown': {'width': 'm'}, 'Currency Code': {'width': 'xs'}, 'Date': {'width': 's'}, 'Boolean (Yes/No)': {'width': 's'},
    'Currency Amount': {'width': 's'}, 'Percentage': {'width': 'xs', 'maxDecimals': 4}, 'Ratio (decimal)': {'width': 'xs'},
    'Decimal': {'width': 's'}, 'Integer': {'width': 'xs', 'maxDecimals': 0}, 'Integer (days)': {'width': 'xs', 'maxDecimals': 0},
}
NAME_SLUGS = {'customer_name', 'name_of_borrower', 'partner_name', 'shareholder_name', 'guarantor_name', 'company_name', 'client_name', 'client',
              'bank_name', 'auditor_name', 'auditor_preparer_name', 'borrower_name', 'account_name', 'name_of_group', 'major_owner_group',
              'company_existing', 'company_proposed', 'sub_group_names', 'created_by'}
SHARE_SLUGS = {'partner_ownership', 'ownership', 'of_asset_covered', 'weight_existing', 'weight_proposed'}


def core_attributes():
    out = OrderedDict()
    for f in FIELDS:
        k = f['field_key']
        a = dict(ATTR_BY_TYPE.get(f['data_type'], {}))
        s = slug(k)
        if s in NAME_SLUGS and f['data_type'] == 'Text':
            a.update(maxLength=150)
        if s == 'official_email_address':
            a.update(maxLength=254, transform='lower', pattern=r'^[^\s@]+@[^\s@]+\.[^\s@]+$', patternHint='name@company.com')
        if s == 'company_website':
            a.update(maxLength=2048, pattern=r'^https?://\S+$', patternHint='https://www.company.com', width='l')
        if s in ('customer_number', 'borrower_customer_id', 'partner_customer_id_cif', 'group_id'):
            a.update(maxLength=20)
        if 'credit_request_number' in s or s in ('related_credit_request_no',):
            a.update(maxLength=30)
        if s in SHARE_SLUGS or s.startswith('assigned_') or s.startswith('of_total'):
            a.update(minValue='0', maxValue='100')
        if a:
            out[k] = a
    return OrderedDict(attributes='credit_request', version=1,
                       note='Product defaults per field. Market profiles (seed/markets) and banks override individual attributes.',
                       fields=out)


if __name__ == '__main__':
    (SEED / 'core-field-attributes.json').write_text(json.dumps(core_attributes(), indent=1, ensure_ascii=False) + '\n')
