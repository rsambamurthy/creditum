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
| `GET customers/{cif}` | `{ cif, name, newOrExisting, partyType, segment, customerType, legalStatus, idType, idNumber, idExpiry, nationality, legalEntity, establishedOn, customerSince, lastReviewOn, sector, accountConduct, ownerGroup, email, website, relationshipSince, internalRating, riskGrade, boardMember, group: { id, nameAndId, subGroupAccounts, subGroupNames }, partners: [{ cif, existingCustomer, name, idType, idNumber, idExpiry, nationality, designation, ownershipPct, boardMember, boardRelated }] }` — 404 if unknown |
| `GET customers/{cif}/facilities` | `[{ facilityId, type, legalEntity, settlementAccount, limitCurrency, utilizationCurrency, structure, disbursement, repayment, interestFrequency, limit, utilization, secured, packageNumber, extensions, originalMaturity, maturity, purpose, commodity, esgLinked, bookingBranch }]` |
| `GET customers/{cif}/security-packages` | `[{ packageNumber, committeeDecisionDate, reviewDate, internallyAcceptedCoverageRatio, creditRequestNumber, valueDate, facilities: [{ type, currency, value, coverageMethod }], collateral: [{ type, currency, currentValue, chargeNature, assignedPct, assignedValue, ownership }] }]` |
| `GET customers/{cif}/guarantees` | `[{ guarantorName, guarantorType, ratingAgency, rating, ratingAsOf, idType, idNumber, coverageAmount, assetCoveredPct, packageNumber }]` |
| `GET customers/{cif}/collateral` | collateral not in a package: `[{ serialNo, collateralNumber, type, currency, value, status }]` |
| `POST bookings/limits` `{ cif, creditRequestNumber, lines: [{ lineRef, facilityId?, amount, currency, maturityDate, purpose, commodity, action, contractType }] }` | `{ bookedAt, lines: [{ lineRef, limitReference, limitType, accountNumber, contractReference, contractDate, maturityDate }] }` — idempotent per `creditRequestNumber` + `lineRef`; an existing `facilityId` keeps its limit reference |
| `POST bookings/collateral` `{ cif, creditRequestNumber, items: [{ itemRef, type, currency, amount, action, linkedLimits }] }` | `{ bookedAt, items: [{ itemRef, collateralNo }] }` |

## Creditum API

- `GET /api/integrations/core-banking/status` → `{ label, configured, enabled, institution, reachable, bookingStates }`
- `GET /api/integrations/core-banking/customers/:cif` → `{ cif, name, segment, newOrExisting, idType, idNumber }` (New Credit Request look-up)
- `POST /api/credit-requests` → also `{ integration: { pulled, warnings, changes } }`
- `POST /api/credit-requests/:id/core-banking/pull` → `{ pulledAt, changes: [{ field, label, section, before, after }], tables: [{ grid, label, added, updated, removed }], warnings }`
- `POST /api/credit-requests/:id/core-banking/booking` → `{ bookedAt, limits, collateral, warnings }`
- `GET /api/credit-requests/:id/data` → also `integration: { label, pulledAt, bookedAt, record: [keys], columns: { grid: [keys] }, rows: { rowKey: { system, ref } } }`

## Simulator (build and test only)

`apps/corebank-sim` — no dependencies; `PORT` and `SIM_API_KEY` (≥ 24 characters) are required. Customers:
XYZ Bank `CIF00418823` (three facilities, a security package, a guarantee, unpledged collateral), `CIF00377104`,
`CIF00502231` (new, no facilities); ABC Finance `C10045821` (two facilities, a package, a guarantee), `C10051307`.
All names, identifiers and accounts are invented.
