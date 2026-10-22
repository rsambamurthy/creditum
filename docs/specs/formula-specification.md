# Creditum — Formula Specification

Formula set version 1 · generated from `apps/api/seed/core-formulas.json` by `tools/library/build_layout.py` — do not edit by hand.

## How calculated fields work

- Every calculated field is recomputed by the server each time the Credit Request is saved; results are stored and audited.
- Arithmetic is exact decimal (never floating point). Results are stored with 8 decimal places, or whole numbers for day counts, rounded with the tenant parameter `calculation.rounding_mode`.
- Empty inputs are never treated as zero, except inside a sum ("+"), where an empty item counts as zero unless every item is empty. Division by zero gives an empty result.
- Financial-period formulas are evaluated per period; growth rates compare with the previous period (periods are kept oldest first).
- Foreign-currency amounts are converted to the tenant base currency at the latest configured rate; a line with no configured rate is left out.
- A bank may replace any formula for itself through maker-checker configuration; the core formula stays unchanged for other tenants.
- **Pending** formulas wait for the bank's methodology and are not calculated; the field shows "Formula pending approval".

**58 active · 35 pending.** Parameters used: `calculation.days_in_year`, `calculation.rounding_mode`.

## Active formulas

### Borrower Profile

| # | Field | Calculation | Formula | Notes |
|---|---|---|---|---|
| CF-0085 | **Physical Risk Score**<br>`a.esg_summary.physical_risk_score` | Copied from the ESG & Sustainability module (Physical Risk Assessment). | Physical Risk Score [Physical Risk Assessment] |  |
| CF-0086 | **Other Environmental Risk Score**<br>`a.esg_summary.other_environmental_risk_score` | Copied from the ESG & Sustainability module (Other Environmental Risk Assessment). | Other Environmental Risk Score [Other Environmental Risk Assessment] |  |
| CF-0087 | **Social Risk Score**<br>`a.esg_summary.social_risk_score` | Copied from the ESG & Sustainability module (Social Risk Assessment). | Social Risk Score [Social Risk Assessment] |  |
| CF-0088 | **Governance Risk Score**<br>`a.esg_summary.governance_risk_score` | Copied from the ESG & Sustainability module (Governance Risk Assessment). | Governance Risk Score [Governance Risk Assessment] |  |
| CF-0106 | **Total Relationship Income**<br>`a.deal_economics_relationship_profitability.total_relationship_income` | Interest income + retail income + FX income + LC/LG commissions + fees and other income. | (Interest Income + Retail Income + FX Income + LC / LG Commissions + Fees & Other Income) |  |
| CF-0152 | **Serial No.** (per row)<br>`a.comments.serial_no` | Running number of the comment (1, 2, 3 …) in the order shown. | row number |  |

### Facility & Collateral

| # | Field | Calculation | Formula | Notes |
|---|---|---|---|---|
| CF-0187 | **Actual Coverage Ratio — Existing Package**<br>`b.security_package.actual_coverage_ratio_existing_package` | Total collateral value ÷ total facility value of the existing package (both in base currency). | Total Existing Collateral Value (Base Reporting Currency) — Existing Package ÷ Total Existing Facility Value (Base Reporting Currency) — Existing Package |  |
| CF-0203 | **% of Total — Existing Package** (per row)<br>`b.security_package.of_total_existing_package` | This collateral's assigned value (base currency) as a percentage of the package's total collateral value. | Current Collateral Assigned Value — Existing Package in base currency (rate for Collateral Currency — Existing Package) ÷ Total Existing Collateral Value (Base Reporting Currency) — Existing Package × 100 |  |
| CF-0204 | **Total Existing Facility Value (Base Reporting Currency) — Existing Package**<br>`b.security_package.total_existing_facility_value_base_reporting_currency_existing_package` | Sum of the facility values of the existing package, each converted to the base currency at the configured rate. | Σ over b.sp_existing_facilities rows of [Facility Value — Existing Package in base currency (rate for Facility Currency — Existing Package)] |  |
| CF-0205 | **Total Existing Collateral Value (Base Reporting Currency) — Existing Package**<br>`b.security_package.total_existing_collateral_value_base_reporting_currency_existing_package` | Sum of the collateral values assigned to the existing package, each converted to the base currency at the configured rate. | Σ over b.sp_existing_collateral rows of [Current Collateral Assigned Value — Existing Package in base currency (rate for Collateral Currency — Existing Package)] | Uses the assigned value (current value × % assigned). Confirm whether the full current value should be used instead. |
| CF-0339 | **Serial No.** (per row)<br>`b.interest_tiering_applicability.serial_no` | Running number of the account (1, 2, 3 …). | row number |  |

### Financial Analysis

| # | Field | Calculation | Formula | Notes |
|---|---|---|---|---|
| CF-0477 | **Revenue / Sales** (per period)<br>`e.financial_ratios_summary.revenue_sales` | Net sales / revenues from the income statement. | Net Sales / Revenues [Income Statement] |  |
| CF-0478 | **Cost of Goods Sold (COGS)** (per period)<br>`e.financial_ratios_summary.cost_of_goods_sold_cogs` | Cost of sales from the income statement. | Cost of Sales / Revenues [Income Statement] |  |
| CF-0479 | **COGS / Sales** (per period)<br>`e.financial_ratios_summary.cogs_sales` | COGS ÷ sales. | Cost of Goods Sold (COGS) ÷ Revenue / Sales |  |
| CF-0481 | **Gross Profit** (per period)<br>`e.financial_ratios_summary.gross_profit` | Sales − COGS. | (Revenue / Sales − Cost of Goods Sold (COGS)) |  |
| CF-0482 | **Gross Profit Margin** (per period)<br>`e.financial_ratios_summary.gross_profit_margin` | Gross profit ÷ sales × 100. | Gross Profit ÷ Revenue / Sales × 100 |  |
| CF-0483 | **SG&A Expenses** (per period)<br>`e.financial_ratios_summary.sg_a_expenses` | General & administrative expenses from the income statement. | General & Administrative Expense [Income Statement] |  |
| CF-0484 | **SG&A / Sales** (per period)<br>`e.financial_ratios_summary.sg_a_sales` | SG&A ÷ sales. | SG&A Expenses ÷ Revenue / Sales |  |
| CF-0485 | **Net Operating Profit (NOP)** (per period)<br>`e.financial_ratios_summary.net_operating_profit_nop` | Net operating profit from the income statement. | Net Operating Profit [Income Statement] |  |
| CF-0486 | **NOP Margin %** (per period)<br>`e.financial_ratios_summary.nop_margin` | NOP ÷ sales × 100. | Net Operating Profit (NOP) ÷ Revenue / Sales × 100 |  |
| CF-0487 | **Interest Coverage — NOP** (per period)<br>`e.financial_ratios_summary.interest_coverage_nop` | NOP ÷ interest expense. | Net Operating Profit (NOP) ÷ Interest Expense [Income Statement] |  |
| CF-0488 | **Net Profit Before Unusual Items (NPBUI)** (per period)<br>`e.financial_ratios_summary.net_profit_before_unusual_items_npbui` | Profit before extraordinary items from the income statement. | Profit Before Extraordinary Items [Income Statement] |  |
| CF-0489 | **Return on Sales (ROS) %** (per period)<br>`e.financial_ratios_summary.return_on_sales_ros` | NPBUI ÷ sales × 100. | Net Profit Before Unusual Items (NPBUI) ÷ Revenue / Sales × 100 |  |
| CF-0490 | **Return on Assets (ROA) % — Operating** (per period)<br>`e.financial_ratios_summary.return_on_assets_roa_operating` | NOP ÷ total assets × 100. | Net Operating Profit (NOP) ÷ Total Assets × 100 |  |
| CF-0491 | **Return on Equity (ROE) % — Operating** (per period)<br>`e.financial_ratios_summary.return_on_equity_roe_operating` | NOP ÷ net worth × 100. | Net Operating Profit (NOP) ÷ Net Worth × 100 |  |
| CF-0492 | **Net Profit** (per period)<br>`e.financial_ratios_summary.net_profit` | Net profit from the income statement. | Net Profit [Income Statement] |  |
| CF-0493 | **Net Profit Margin %** (per period)<br>`e.financial_ratios_summary.net_profit_margin` | Net profit ÷ sales × 100. | Net Profit ÷ Revenue / Sales × 100 |  |
| CF-0494 | **Return on Assets (ROA) % — Net** (per period)<br>`e.financial_ratios_summary.return_on_assets_roa_net` | Net profit ÷ total assets × 100. | Net Profit ÷ Total Assets × 100 |  |
| CF-0495 | **Return on Equity (ROE) % — Net** (per period)<br>`e.financial_ratios_summary.return_on_equity_roe_net` | Net profit ÷ net worth × 100. | Net Profit ÷ Net Worth × 100 |  |
| CF-0496 | **Sales Growth Rate %** (per period)<br>`e.financial_ratios_summary.sales_growth_rate` | (Sales − previous period sales) ÷ |previous period sales| × 100. | (Revenue / Sales − previous period Revenue / Sales) ÷ |previous period Revenue / Sales| × 100 |  |
| CF-0499 | **Operating Leverage** (per period)<br>`e.financial_ratios_summary.operating_leverage` | Degree of operating leverage: NOP growth rate ÷ sales growth rate. | NOP Growth Rate % ÷ Sales Growth Rate % |  |
| CF-0500 | **NOP Growth Rate %** (per period)<br>`e.financial_ratios_summary.nop_growth_rate` | (NOP − previous NOP) ÷ |previous NOP| × 100. | (Net Operating Profit (NOP) − previous period Net Operating Profit (NOP)) ÷ |previous period Net Operating Profit (NOP)| × 100 |  |
| CF-0501 | **Net Profit Growth Rate %** (per period)<br>`e.financial_ratios_summary.net_profit_growth_rate` | (Net profit − previous net profit) ÷ |previous net profit| × 100. | (Net Profit − previous period Net Profit) ÷ |previous period Net Profit| × 100 |  |
| CF-0502 | **Total Assets** (per period)<br>`e.financial_ratios_summary.total_assets` | Total assets from the balance sheet. | Total Assets [Balance Sheet — Assets] |  |
| CF-0503 | **Current Assets** (per period)<br>`e.financial_ratios_summary.current_assets` | Total current assets from the balance sheet. | Total Current Assets [Balance Sheet — Assets] |  |
| CF-0504 | **Current Assets / Total Assets** (per period)<br>`e.financial_ratios_summary.current_assets_total_assets` | Current assets ÷ total assets. | Current Assets ÷ Total Assets |  |
| CF-0505 | **Accounts Receivable Days (DOH)** (per period)<br>`e.financial_ratios_summary.accounts_receivable_days_doh` | Accounts receivable ÷ sales × days in the year (tenant parameter calculation.days_in_year), rounded to whole days. | round(Accounts Receivable — Net [Balance Sheet — Assets] ÷ Revenue / Sales × parameter `calculation.days_in_year`, 0 places) |  |
| CF-0506 | **Inventory Days (DOH)** (per period)<br>`e.financial_ratios_summary.inventory_days_doh` | Inventory ÷ COGS × days in the year, rounded to whole days. | round(Total Inventory [Balance Sheet — Assets] ÷ Cost of Goods Sold (COGS) × parameter `calculation.days_in_year`, 0 places) |  |
| CF-0507 | **Accounts Payable & Accruals Days (DOH)** (per period)<br>`e.financial_ratios_summary.accounts_payable_accruals_days_doh` | Trade accounts payable ÷ COGS × days in the year, rounded to whole days. | round(Accounts Payable — Trade [Balance Sheet — Liabilities & Net Worth] ÷ Cost of Goods Sold (COGS) × parameter `calculation.days_in_year`, 0 places) |  |
| CF-0508 | **Cash Conversion Cycle (Days)** (per period)<br>`e.financial_ratios_summary.cash_conversion_cycle_days` | Receivable days + inventory days − payable days. | ((Accounts Receivable Days (DOH) + Inventory Days (DOH)) − Accounts Payable & Accruals Days (DOH)) |  |
| CF-0509 | **Total Liabilities** (per period)<br>`e.financial_ratios_summary.total_liabilities` | Total liabilities from the balance sheet. | Total Liabilities [Balance Sheet — Liabilities & Net Worth] |  |
| CF-0510 | **Interest Bearing Debt** (per period)<br>`e.financial_ratios_summary.interest_bearing_debt` | Short-term bank loans + current portion of long-term debt + long-term bank debt. | (Short-Term Loans Payable — Bank [Balance Sheet — Liabilities & Net Worth] + Current Portion of Long-Term Debt (CPLTD) — Bank [Balance Sheet — Liabilities & Net Worth] + Long-Term Debt — Bank [Balance Sheet — Liabilities & Net Worth]) |  |
| CF-0512 | **Off-Balance-Sheet Liabilities** (per period)<br>`e.financial_ratios_summary.off_balance_sheet_liabilities` | Letters of guarantee + letters of credit + other commitments. | (Letters of Guarantee (LG) [Contingent Liabilities & Commitments] + Letters of Credit (LC) [Contingent Liabilities & Commitments] + Other Commitments [Contingent Liabilities & Commitments]) |  |
| CF-0513 | **Net Worth** (per period)<br>`e.financial_ratios_summary.net_worth` | Total net worth from the balance sheet. | Total Net Worth [Balance Sheet — Liabilities & Net Worth] |  |
| CF-0514 | **Leverage Ratio** (per period)<br>`e.financial_ratios_summary.leverage_ratio` | Total liabilities ÷ net worth. | Total Liabilities ÷ Net Worth |  |
| CF-0516 | **Leverage / Tangible Net Worth** (per period)<br>`e.financial_ratios_summary.leverage_tangible_net_worth` | Total liabilities ÷ (net worth − net intangibles). | Total Liabilities ÷ (Net Worth − Intangibles — Net [Balance Sheet — Assets]) |  |
| CF-0517 | **Gearing** (per period)<br>`e.financial_ratios_summary.gearing` | Interest-bearing debt ÷ net worth. | Interest Bearing Debt ÷ Net Worth |  |
| CF-0519 | **Current Ratio** (per period)<br>`e.financial_ratios_summary.current_ratio` | Current assets ÷ current liabilities. | Current Assets ÷ Total Current Liabilities [Balance Sheet — Liabilities & Net Worth] |  |
| CF-0520 | **Quick Ratio** (per period)<br>`e.financial_ratios_summary.quick_ratio` | (Current assets − inventory) ÷ current liabilities. | (Current Assets − Total Inventory [Balance Sheet — Assets]) ÷ Total Current Liabilities [Balance Sheet — Liabilities & Net Worth] |  |
| CF-0521 | **Assets Growth Rate %** (per period)<br>`e.financial_ratios_summary.assets_growth_rate` | (Total assets − previous) ÷ |previous| × 100. | (Total Assets − previous period Total Assets) ÷ |previous period Total Assets| × 100 |  |
| CF-0522 | **Liabilities Growth Rate %** (per period)<br>`e.financial_ratios_summary.liabilities_growth_rate` | (Total liabilities − previous) ÷ |previous| × 100. | (Total Liabilities − previous period Total Liabilities) ÷ |previous period Total Liabilities| × 100 |  |
| CF-0523 | **Net Worth Growth Rate %** (per period)<br>`e.financial_ratios_summary.net_worth_growth_rate` | (Net worth − previous) ÷ |previous| × 100. | (Net Worth − previous period Net Worth) ÷ |previous period Net Worth| × 100 |  |
| CF-0524 | **EBITDA** (per period)<br>`e.financial_ratios_summary.ebitda` | NOP + depreciation + amortisation. | (Net Operating Profit (NOP) + Depreciation [Income Statement] + Amortization [Income Statement]) |  |
| CF-0525 | **EBITDA Margin %** (per period)<br>`e.financial_ratios_summary.ebitda_margin` | EBITDA ÷ sales × 100. | EBITDA ÷ Revenue / Sales × 100 |  |
| CF-0526 | **EBITDA Growth Rate %** (per period)<br>`e.financial_ratios_summary.ebitda_growth_rate` | (EBITDA − previous) ÷ |previous| × 100. | (EBITDA − previous period EBITDA) ÷ |previous period EBITDA| × 100 |  |
| CF-0529 | **Net Debt / EBITDA** (per period)<br>`e.financial_ratios_summary.net_debt_ebitda` | (Interest-bearing debt − cash − time deposits) ÷ EBITDA. | (Interest Bearing Debt − (Cash [Balance Sheet — Assets] + Time Deposits [Balance Sheet — Assets])) ÷ EBITDA |  |
| CF-0531 | **Interest Coverage - EBITDA** (per period)<br>`e.financial_ratios_summary.interest_coverage_ebitda` | EBITDA ÷ interest expense. | EBITDA ÷ Interest Expense [Income Statement] |  |
| CF-0532 | **Financial Payments Coverage - EBITDA** (per period)<br>`e.financial_ratios_summary.financial_payments_coverage_ebitda` | EBITDA ÷ (interest expense + current portion of long-term debt). | EBITDA ÷ (Interest Expense [Income Statement] + Current Portion of Long-Term Debt (CPLTD) — Bank [Balance Sheet — Liabilities & Net Worth]) |  |

## Pending — decision needed

### Borrower Profile

| # | Field | Calculation | Formula | Notes |
|---|---|---|---|---|
| CF-0083 | **Transitional Risk Mitigation Score (Pre-Overlay)**<br>`a.esg_summary.transitional_risk_mitigation_score_pre_overlay` | ESG score / rating from the bank's ESG scoring methodology. | — | Needs the bank's ESG methodology: question weights, overlay rules and the score-to-rating bands (tenant configuration). |
| CF-0084 | **Transitional Risk Mitigation Score (Post-Overlay)**<br>`a.esg_summary.transitional_risk_mitigation_score_post_overlay` | ESG score / rating from the bank's ESG scoring methodology. | — | Needs the bank's ESG methodology: question weights, overlay rules and the score-to-rating bands (tenant configuration). |
| CF-0089 | **Internal ESG Score (Pre-Overlay)**<br>`a.esg_summary.internal_esg_score_pre_overlay` | ESG score / rating from the bank's ESG scoring methodology. | — | Needs the bank's ESG methodology: question weights, overlay rules and the score-to-rating bands (tenant configuration). |
| CF-0090 | **Internal ESG Score (Post-Overlay)**<br>`a.esg_summary.internal_esg_score_post_overlay` | ESG score / rating from the bank's ESG scoring methodology. | — | Needs the bank's ESG methodology: question weights, overlay rules and the score-to-rating bands (tenant configuration). |
| CF-0091 | **Internal ESG Rating (Pre-Overlay)**<br>`a.esg_summary.internal_esg_rating_pre_overlay` | ESG score / rating from the bank's ESG scoring methodology. | — | Needs the bank's ESG methodology: question weights, overlay rules and the score-to-rating bands (tenant configuration). |
| CF-0092 | **Internal ESG Rating (Post-Overlay)**<br>`a.esg_summary.internal_esg_rating_post_overlay` | ESG score / rating from the bank's ESG scoring methodology. | — | Needs the bank's ESG methodology: question weights, overlay rules and the score-to-rating bands (tenant configuration). |
| CF-0125 | **Total Free Funds**<br>`a.relationship_overview.total_free_funds` | Sum of the customer's free funds, in the base currency. | — | Needs the account-level data from the core banking / credit bureau adapters (not part of the field library). Calculated by the adapter when it is connected; shown as pending until then. |
| CF-0126 | **Total Deposit**<br>`a.relationship_overview.total_deposit` | Sum of the customer's deposits, in the base currency. | — | Needs the account-level data from the core banking / credit bureau adapters (not part of the field library). Calculated by the adapter when it is connected; shown as pending until then. |
| CF-0127 | **Total Investments**<br>`a.relationship_overview.total_investments` | Sum of the customer's investments, in the base currency. | — | Needs the account-level data from the core banking / credit bureau adapters (not part of the field library). Calculated by the adapter when it is connected; shown as pending until then. |
| CF-0128 | **Total Cash Limit**<br>`a.relationship_overview.total_cash_limit` | Sum of the customer's cash limits, in the base currency. | — | Needs the account-level data from the core banking / credit bureau adapters (not part of the field library). Calculated by the adapter when it is connected; shown as pending until then. |
| CF-0129 | **Total Cash Limit — Other Banks**<br>`a.relationship_overview.total_cash_limit_other_banks` | Sum of the customer's cash limits at other banks, in the base currency. | — | Needs the account-level data from the core banking / credit bureau adapters (not part of the field library). Calculated by the adapter when it is connected; shown as pending until then. |
| CF-0130 | **Total Cash Outstanding**<br>`a.relationship_overview.total_cash_outstanding` | Sum of the customer's cash outstanding, in the base currency. | — | Needs the account-level data from the core banking / credit bureau adapters (not part of the field library). Calculated by the adapter when it is connected; shown as pending until then. |
| CF-0131 | **Total Cash Utilization — Other Banks**<br>`a.relationship_overview.total_cash_utilization_other_banks` | Sum of the customer's cash utilisation at other banks, in the base currency. | — | Needs the account-level data from the core banking / credit bureau adapters (not part of the field library). Calculated by the adapter when it is connected; shown as pending until then. |
| CF-0132 | **Total Non-Cash Limit**<br>`a.relationship_overview.total_non_cash_limit` | Sum of the customer's non-cash limits, in the base currency. | — | Needs the account-level data from the core banking / credit bureau adapters (not part of the field library). Calculated by the adapter when it is connected; shown as pending until then. |
| CF-0133 | **Total Non-Cash Limit — Other Banks**<br>`a.relationship_overview.total_non_cash_limit_other_banks` | Sum of the customer's non-cash limits at other banks, in the base currency. | — | Needs the account-level data from the core banking / credit bureau adapters (not part of the field library). Calculated by the adapter when it is connected; shown as pending until then. |
| CF-0134 | **Total Non-Cash Outstanding**<br>`a.relationship_overview.total_non_cash_outstanding` | Sum of the customer's non-cash outstanding, in the base currency. | — | Needs the account-level data from the core banking / credit bureau adapters (not part of the field library). Calculated by the adapter when it is connected; shown as pending until then. |
| CF-0135 | **Total Non-Cash Utilization — Other Banks**<br>`a.relationship_overview.total_non_cash_utilization_other_banks` | Sum of the customer's non-cash utilisation at other banks, in the base currency. | — | Needs the account-level data from the core banking / credit bureau adapters (not part of the field library). Calculated by the adapter when it is connected; shown as pending until then. |
| CF-0136 | **Total Credit Card Limit**<br>`a.relationship_overview.total_credit_card_limit` | Sum of the customer's credit card limits, in the base currency. | — | Needs the account-level data from the core banking / credit bureau adapters (not part of the field library). Calculated by the adapter when it is connected; shown as pending until then. |
| CF-0137 | **Total Card Outstanding Balance**<br>`a.relationship_overview.total_card_outstanding_balance` | Sum of the customer's card outstanding balances, in the base currency. | — | Needs the account-level data from the core banking / credit bureau adapters (not part of the field library). Calculated by the adapter when it is connected; shown as pending until then. |

### Facility & Collateral

| # | Field | Calculation | Formula | Notes |
|---|---|---|---|---|
| CF-0185 | **Minimum Contractual Coverage Ratio — Existing Package**<br>`b.security_package.minimum_contractual_coverage_ratio_existing_package` | Minimum coverage ratio agreed in the facility documentation. | — | The library marks this as calculated, but it is a contractual term. Proposal: integrated from the collateral management system. |

### Financial Analysis

| # | Field | Calculation | Formula | Notes |
|---|---|---|---|---|
| CF-0480 | **Direct Depreciation** (per period)<br>`e.financial_ratios_summary.direct_depreciation` | Depreciation charged to cost of sales. | — | The income statement carries one depreciation line. Proposal: add a "direct depreciation" line to the spread, or use the depreciation line. |
| CF-0497 | **Breakeven Sales** (per period)<br>`e.financial_ratios_summary.breakeven_sales` | Fixed costs ÷ contribution margin ratio. | — | Needs a fixed / variable cost split that the spread does not capture. |
| CF-0498 | **Margin of Safety** (per period)<br>`e.financial_ratios_summary.margin_of_safety` | (Sales − breakeven sales) ÷ sales × 100. | — | Depends on breakeven sales. |
| CF-0511 | **Leasing Obligations / Interest-Bearing Debt %** (per period)<br>`e.financial_ratios_summary.leasing_obligations_interest_bearing_debt` | Lease obligations ÷ interest-bearing debt × 100. | — | Needs a lease-obligations line in the balance sheet spread. |
| CF-0515 | **Leverage Ratio (excl. P.A.)** (per period)<br>`e.financial_ratios_summary.leverage_ratio_excl_p_a` | Leverage ratio excluding "P.A.". | — | "P.A." must be defined by the bank before a formula can be set. |
| CF-0518 | **Gearing (excl. P.A.)** (per period)<br>`e.financial_ratios_summary.gearing_excl_p_a` | Gearing excluding "P.A.". | — | "P.A." must be defined by the bank before a formula can be set. |
| CF-0527 | **Adjusted EBITDA** (per period)<br>`e.financial_ratios_summary.adjusted_ebitda` | EBITDA after the bank's normalisation adjustments. | — | Needs the list of adjustments the bank applies. |
| CF-0528 | **Years to Service Debt** (per period)<br>`e.financial_ratios_summary.years_to_service_debt` | Interest-bearing debt ÷ cash available for debt service. | — | Needs the bank's definition of cash available for debt service (for example EBITDA − tax − capex). |
| CF-0530 | **Debt / Adjusted EBITDA** (per period)<br>`e.financial_ratios_summary.debt_adjusted_ebitda` | Interest-bearing debt ÷ adjusted EBITDA. | — | Depends on adjusted EBITDA. |

### ESG & Sustainability

| # | Field | Calculation | Formula | Notes |
|---|---|---|---|---|
| CF-0626 | **Preliminary Transitional Risk Rating**<br>`f.esg_classification_transitional_rating.preliminary_transitional_risk_rating` | Rating band of the transitional risk score. | — | Needs the score-to-rating bands of the bank's ESG methodology (tenant configuration). |
| CF-0646 | **Transitional Risk Score**<br>`f.transitional_risk_assessment.transitional_risk_score` | Weighted score of the answers in this assessment. | — | Needs the bank's ESG methodology: the weight and direction of each answer (tenant configuration). |
| CF-0654 | **Physical Risk Score**<br>`f.physical_risk_assessment.physical_risk_score` | Weighted score of the answers in this assessment. | — | Needs the bank's ESG methodology: the weight and direction of each answer (tenant configuration). |
| CF-0660 | **Other Environmental Risk Score**<br>`f.other_environmental_risk_assessment.other_environmental_risk_score` | Weighted score of the answers in this assessment. | — | Needs the bank's ESG methodology: the weight and direction of each answer (tenant configuration). |
| CF-0662 | **Social Risk Score**<br>`f.social_risk_assessment.social_risk_score` | Weighted score of the answers in this assessment. | — | Needs the bank's ESG methodology: the weight and direction of each answer (tenant configuration). |
| CF-0664 | **Governance Risk Score**<br>`f.governance_risk_assessment.governance_risk_score` | Weighted score of the answers in this assessment. | — | Needs the bank's ESG methodology: the weight and direction of each answer (tenant configuration). |

