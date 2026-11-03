# Bank system connectors

Creditum fills a Credit Request from five bank systems, each through its own connector. All of them work the same way
(below, with core banking as the example): the endpoint and key come from the deployment, a workspace switches a
connector on with `integration.<connector>.enabled`, the field mapping is data in `apps/api/seed/connectors/`, every
value is checked like a user's entry, pulled values are read-only with their source, and every pull is audited.

| Connector | Environment | Workspace settings | Fills | Found by |
|---|---|---|---|---|
| `core_banking` — Core banking | `CONNECTOR_CORE_BANKING_URL` / `_KEY` | `institution_code`, booking rules | Customer, group, partners, facilities, security package, guarantees, collateral, own-bank relationship totals; booking | customer number |
| `rating` — Rating system | `CONNECTOR_RATING_URL` / `_KEY` | `institution_code` | Internal ratings (current, previous, dates) of the borrower, personal and corporate guarantor | customer number |
| `data_warehouse` — Data warehouse | `CONNECTOR_DATA_WAREHOUSE_URL` / `_KEY` | `institution_code` | Existing ROC, RAROC, RWA; relationship income; profitability; relationship history; group ROC / RAROC by company | customer number |
| `credit_bureau` — Credit bureau | `CONNECTOR_CREDIT_BUREAU_URL` / `_KEY` | `institution_code` (member code) | Limits and utilisation at other banks; dealings with other banks | identification number |
| `financial_statements` — Company registry | `CONNECTOR_FINANCIAL_STATEMENTS_URL` / `_KEY` | `registry` (`mca`, `sec`), `identifier_types` (e.g. `cin`) | Filed financial statements by period: header, income statement, balance sheet | registry identifier (CIN, CIK) when the customer's ID type is one of `identifier_types` |

Connectors run in that order on **create** and on **Refresh from bank systems** (later ones may use values core banking
filled, e.g. the identification number). A system without a record for the customer is skipped; one that cannot be
reached is reported and the others still run.

**Company registries.** Each registry tags figures with its own taxonomy; the response names it (`ind-as` for MCA21
AOC-4 XBRL, `us-gaap` for SEC EDGAR) and `financial-statements.json` maps each taxonomy's concepts to the statement
lines. Periods are matched by period end and kept oldest first; ratios are calculated from the pulled lines. A market
without a registry for private companies (e.g. Kuwait) leaves the connector off: statements are entered by hand (or,
later, uploaded and read).

Contracts of the other systems (all `GET`, `x-api-key`):
- Rating: `v1/institutions/{institution_code}/obligors/{cif}/ratings` → `{ borrower, personalGuarantor, corporateGuarantor }`, each `{ current: { rating, asOf }, previous: { rating, asOf } }` or null
- Data warehouse: `v1/institutions/{institution_code}/customers/{cif}/profitability` → `{ asOf, capital: { roc, raroc, rwa }, income: { interest, retail, fx, lcLg, fees }, profitability, relationshipHistory, group: { totalExisting, companies: [{ company, limit, weight, roc, weightedRoc, raroc, weightedRaroc }] } }`
- Credit bureau: `v1/institutions/{institution_code}/subjects/{idNumber}/report` → `{ name, asOf, otherBanks: { cashLimit, cashUtilization, nonCashLimit, nonCashUtilization }, lenders: [{ lender, cash, nonCash, fx, collateral }] }`
- Company registry: `v1/registries/{registry}/companies/{id}/financial-statements` → `{ registry, taxonomy, companyId, name, statements: [{ periodEnd, basis, currency, auditor, opinion, filedOn, form, facts: { <concept>: "<decimal>" } }] }`
- Core banking also: `GET customers/{cif}/relationship-summary` → `{ freeFunds, deposits, investments, cashLimit, cashOutstanding, nonCashLimit, nonCashOutstanding, creditCardLimit, cardOutstanding }`

# Core banking connector

Creditum reads customer, facility and collateral data from core banking into a Credit Request, and books approved
limits and collateral back. It talks to one HTTP+JSON contract (below). A bank implements the contract in an adapter
in front of its core banking system; build and test environments use the simulator in `apps/corebank-sim`
(fictional data for XYZ Bank and ABC Finance).

## How it behaves

| When | What happens |
|---|---|
| A request is created | If the connector is available, the request is filled from core banking for the customer number (borrower reference). A failure is reported as a warning; the request is still created. |
| **Refresh from core banking** (relationship officer, credit analyst; editable states) | Pulls again. Pulled values are updated; values users entered are kept. Rows that are no longer in core banking are removed, or kept as ordinary rows if users added values to them. The change list is shown. |
| Users edit the request | Values from core banking are read-only (422 `read_only_field`); rows from core banking cannot be removed (422 `read_only_row`). Users fill their own columns on those rows (request action, proposed limit) and add their own rows. |
| **Book in core banking** (credit administration; states in `integration.core_banking.booking_states`) | Facility lines whose request action is in `booking_line_actions` and that have a proposed limit, and new-package collateral whose action is in `booking_collateral_actions`, are booked once (409 `already_booked` afterwards). Limit references, accounts and contract references are written into Credit Administration. |

Every value received is checked like a user's entry (value lists, currencies, data type, length and format by market);
a value that fails is skipped and named in the warnings. Every pull and booking is audited
(`credit_request_core_banking_pulled`, `credit_request_booked_in_core_banking`, and `…_failed`) and kept in
`integration_runs`.

## Settings

| Where | Setting |
|---|---|
| Deployment environment | `CONNECTOR_CORE_BANKING_URL`, `CONNECTOR_CORE_BANKING_KEY` (sent as `x-api-key`), `CONNECTOR_TIMEOUT_MS`. The endpoint and credential are never tenant configuration. |
| Tenant parameters (maker-checker) | `integration.core_banking.enabled`, `.institution_code`, `.booking_states`, `.booking_line_actions`, `.booking_collateral_actions` |
| Field mapping (product data) | `apps/api/seed/connectors/core-banking.json`: which response path fills which field, the row keys of each table, and the booking lines. |

## Contract (v1)

All paths are under `/v1/institutions/{institution}/`; every call carries `x-api-key`. Amounts, rates and ratios are
decimal strings; dates are `YYYY-MM-DD`; codes are the institution's value-list codes.

| Call | Returns |
|---|---|
| `GET customers?q=&limit=` | `{ total, items: [{ cif, name, segment, newOrExisting, idType, idNumber }] }` — customers whose number or name contains `q` (list of values) |
| `GET customers/{cif}` | `{ cif, name, newOrExisting, partyType, segment, customerType, legalStatus, idType, idNumber, idExpiry, nationality, legalEntity, establishedOn, customerSince, lastReviewOn, sector, accountConduct, ownerGroup, email, website, relationshipSince, internalRating, riskGrade, boardMember, group: { id, nameAndId, subGroupAccounts, subGroupNames }, partners: [{ cif, existingCustomer, name, idType, idNumber, idExpiry, nationality, designation, ownershipPct, boardMember, boardRelated }] }` — 404 if unknown |
| `GET customers/{cif}/facilities` | `[{ facilityId, type, legalEntity, settlementAccount, limitCurrency, utilizationCurrency, structure, disbursement, repayment, interestFrequency, limit, utilization, secured, packageNumber, extensions, originalMaturity, maturity, purpose, commodity, esgLinked, bookingBranch }]` |
| `GET customers/{cif}/security-packages` | `[{ packageNumber, committeeDecisionDate, reviewDate, internallyAcceptedCoverageRatio, creditRequestNumber, valueDate, facilities: [{ type, currency, value, coverageMethod }], collateral: [{ type, currency, currentValue, chargeNature, assignedPct, assignedValue, ownership }] }]` |
| `GET customers/{cif}/guarantees` | `[{ guarantorName, guarantorType, ratingAgency, rating, ratingAsOf, idType, idNumber, coverageAmount, assetCoveredPct, packageNumber }]` |
| `GET customers/{cif}/collateral` | collateral not in a package: `[{ serialNo, collateralNumber, type, currency, value, status }]` |
| `POST bookings/limits` `{ cif, creditRequestNumber, lines: [{ lineRef, facilityId?, amount, currency, maturityDate, purpose, commodity, action, contractType }] }` | `{ bookedAt, lines: [{ lineRef, limitReference, limitType, accountNumber, contractReference, contractDate, maturityDate }] }` — idempotent per `creditRequestNumber` + `lineRef`; an existing `facilityId` keeps its limit reference |
| `POST bookings/collateral` `{ cif, creditRequestNumber, items: [{ itemRef, type, currency, amount, action, linkedLimits }] }` | `{ bookedAt, items: [{ itemRef, collateralNo }] }` |

## Creditum API

- `GET /api/integrations/core-banking/status` → `{ label, configured, enabled, institution, reachable, bookingStates }`
- `GET /api/integrations/core-banking/customers?q=` → `{ items, total }` (customer number list of values; at least 2 characters)
- `GET /api/integrations/core-banking/customers/:cif` → `{ cif, name, segment, newOrExisting, idType, idNumber }` (New Credit Request look-up)
- `POST /api/credit-requests` → also `{ integration: { pulled, systems, warnings, changes } }`
- `POST /api/credit-requests/:id/integrations/pull` → `{ pulledAt, systems: [{ system, label, status: pulled|skipped|failed, message?, changes: [{ field, label, section, before, after }], tables: [{ grid, label, added, updated, removed }], warnings }] }` (all available systems)
- `POST /api/credit-requests/:id/core-banking/booking` → `{ bookedAt, limits, collateral, warnings }`
- `GET /api/credit-requests/:id/data` → also `integration: { pulledAt, bookedAt, sources: [{ system, label, pulledAt, record: [keys], columns: { grid: [keys] } }], rows: { rowKey: { system, ref } } }`

## Simulator (build and test only)

`apps/corebank-sim` — all five systems in one service (core banking at the root, then `/rating`, `/warehouse`, `/bureau`, `/registry`); no dependencies; `PORT` and `SIM_API_KEY` (≥ 24 characters) are required. Customers:
XYZ Bank `CIF00418823` (three facilities, a security package, a guarantee, unpledged collateral), `CIF00377104`,
`CIF00502231` (new, no facilities); ABC Finance `C10045821` (two facilities, a package, a guarantee), `C10051307`.
All names, identifiers and accounts are invented.

Rating, data warehouse and bureau data exist for the main customers; the registry holds MCA filings (Ind AS) for
`U34300MH2009PTC193245` (Tarvenna, three years), `U45200TN2008PTC068904`, `U27100MH2004PTC150318`, and a SEC EDGAR-style
filer (US-GAAP) `0001999001`. ABC Finance customers carry their CIN as the customer ID; XYZ Bank has no registry.
