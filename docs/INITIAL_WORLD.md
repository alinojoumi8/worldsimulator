# WorldTangle — Initial World Specification: "Riverbend" (worldSpec `riverbend-100@1`)

A balanced starter population of **exactly 100 person-agents** in one stylized US-style small town. This document defines **generation templates, distributions, constraints, and validation rules** — the world generator (M02) produces the concrete population from a seed. **There are no hand-written biographies**; two different seeds yield different-but-statistically-equivalent towns, and the same seed always yields the identical town (generation determinism test, Phase 2).

All amounts are simulated USD (annual, displayed in dollars here; stored as integer cents). CPI index base = 1000 at tick 0.

---

## 1. Town setting & geographic assumptions

- One town, **no spatial model in MVP**: every agent can interact with every institution (distance/commute [LATER] with multi-region).
- Housing is rented from an off-model landlord (Rest-of-World channel) at fixed tier prices; there is no housing market in MVP.
- The town trades with the **Rest of World (ROW)**: wholesale inputs, fuel, salvage sales, surplus exports, pensions inflow. ROW prices are scenario parameters that world events can shock.

## 2. Institutions and staffing (35 institution-employed agents)

| Institution | Kind | Staff (agents) | Count |
|---|---|---|---|
| First Ledger Bank | bank | branch manager 1 · loan officers 2 · teller 1 | 4 |
| Foundry Capital | vc_firm | partners 2 · analyst 1 | 3 |
| Hale & Marrow LLP | law_firm | lawyers 2 · paralegal 1 | 3 |
| Riverbend School | school | principal 1 · teachers 4 | 5 |
| The Riverbend Ledger | news_org | editor 1 · journalists 2 | 3 |
| Town of Riverbend | government | mayor 1 · treasurer 1 · town economist 1 · clerks 2 · maintenance 1 | 6 |
| Riverbend Exchange | market_operator | operations manager 1 | 1 |
| Riverbend Power & Light | energy_co | plant manager 1 · engineers 2 · technicians 2 | 5 |
| Riverbend Clinic | healthcare | doctors 2 · nurses 2 · receptionist 1 | 5 |
| **Subtotal** | | | **35** |

Foundry Capital begins V1 with **Foundry Fund I**, a $5,000,000 fund (`500000000` integer cents) and zero deployed capital. Deployments are recorded only through the authoritative investment lifecycle and can never exceed fund size.

## 3. Businesses and staffing (31 business-employed agents)

| Business | Sector | Staff | Count |
|---|---|---|---|
| Ironvale Manufacturing | manufacturing | owner-founder 1 · ops manager 1 · engineers 2 · accountant 1 · factory workers 8 | 13 |
| Hearthside Market | grocery retail | owner 1 · retail workers 4 | 5 |
| Fogline Coffee | food service | founder 1 · service workers 2 | 3 |
| Willow & Rye Diner | food service | owner 1 · cooks/servers 3 | 4 |
| Bluepine Builders | construction/repair | owner 1 · construction workers 3 | 4 |
| Cedar & Sage Accounting | professional services | owner-accountant 1 · junior accountant 1 | 2 |
| **Subtotal** | | | **31** |

Business ownership at t0: 6 owner-operators hold 100% founder equity in their firms (cap tables exist from day one). Ironvale carries an outstanding business loan (~$120k, 60% through its term) so the credit system has live state at start.

## 4. Independent & non-employed agents (34)

| Group | Count | Notes |
|---|---|---|
| Freelance software engineers | 2 | variable project income via ROW clients |
| Independent investor | 1 | capital income; natural early VC co-investor [V1] |
| Freelance journalist | 1 | pitches to The Riverbend Ledger |
| Gig delivery workers | 2 | variable income, low buffer |
| Students (16–22) | 11 | at Riverbend School / part-time capable |
| Unemployed job-seekers | 5 | receive benefit while treasury funds it |
| Retirees | 9 | ROW pension inflow (external channel, keeps treasury simple) |
| Homemakers | 3 | in-household; may enter labor force on triggers |
| **Subtotal** | **34** | |

**Population check: 35 + 31 + 34 = 100.** Labor force = 72 employed/self-employed + 5 unemployed = 77 → **starting unemployment ≈ 6.5%**.

## 5. Distributions (generation targets)

The generator samples from these targets, then a **constraint pass** adjusts minimally to satisfy hard constraints (§7). Envelope tests (Phase 2) assert the generated population lands inside the stated tolerances.

### 5.1 Age (±2 per band allowed)

| 16–22 | 23–34 | 35–49 | 50–64 | 65+ |
|---|---|---|---|---|
| 11 | 30 | 31 | 19 | 9 |

Role constraints: students 16–22; retirees 65+; owners/partners/managers ≥ 30; loan officers ≥ 25; mayor ≥ 35.

### 5.2 Education (exact counts from role templates; ±3 tolerance on the free population)

| graduate | college | high_school | in_progress/none |
|---|---|---|---|
| 12 | 38 | 42 | 8 |

Role minima: doctors/lawyers/economist → graduate; engineers/accountants/teachers/journalists/officers → college+.

### 5.3 Income (annual gross, by occupation band — wages sampled uniformly inside band)

| Band | Occupations | Range |
|---|---|---|
| High | doctor 165–195k · VC partner 170–200k · lawyer 150–180k | $150k+ |
| Upper-mid | plant manager 105–120k · bank manager 95–115k · freelance eng 85–120k · engineer 80–100k · principal 85–95k · mayor 90k (fixed) | $80–150k |
| Mid | ops manager 78–90k · treasurer 78k · exchange ops 75k · VC analyst 70–85k · editor 70–80k · economist 72k · accountant 60–75k · nurse 60–72k · loan officer 55–70k | $55–90k |
| Lower-mid | teacher 48–62k · technician 52–64k · construction 44–54k · journalist 45–58k · paralegal 45–55k · factory worker 40–50k · junior accountant 42–50k · clerk 38–46k · maintenance 36–42k | $36–64k |
| Low | teller 34–40k · receptionist 34–38k · retail 28–34k · cook/server 26–34k · barista/service 26–32k · gig 24–32k (variable) | $24–40k |
| Transfers | unemployment benefit $12k-rate · retiree pension 22–30k (ROW) · student allowance 6–10k | — |

Owner-operators take a **draw** (min($45k, profit) up to $90k by rule) rather than a wage. Resulting town mean wage ≈ **$52k**, median ≈ $46k (indicator envelope: avgWage $50–56k at t0).

### 5.4 Wealth (starting net financial assets — deposits minus debts)

Sampled lognormal per band, correlated with age (+) and income (+), noise σ=0.4:

| Percentile of adults | Target net worth |
|---|---|
| p10 | ≤ $1k (gig, service, some unemployed near 0) |
| p25 | ~$5k |
| p50 | ~$28k |
| p75 | ~$85k |
| p90 | ~$220k |
| top 3 (Ironvale owner, VC partners) | $400–650k |

Students: $0–2k. Target starting **wealth Gini ≈ 0.55 ± 0.05** (validation metric). Household deposits are the initial M1 mint (~**$4.2M total**, envelope ±10%) plus business working capital (~$0.9M).

### 5.5 Households (52 households; exact structure counts)

| Structure | Households | People |
|---|---|---|
| single | 22 | 22 |
| couple | 14 | 28 |
| family (3–4, incl. most students) | 12 | 42 |
| shared (2 unrelated adults) | 4 | 8 |
| **Total** | **52** | **100** |

Rent tiers: modest $650/mo · standard $900/mo · comfortable $1,400/mo, assigned by household income tercile. Students live in family households except 2 in shared housing.

### 5.6 Personality (Big Five + economic traits, 0–100)

Base: `N(50, 15)` clamped [5, 95] per dimension, sampled independently, then **occupation-conditioned shifts** (applied before clamping):

| Role | Shifts |
|---|---|
| founders/owners | ambition +20, riskTolerance +15, conscientiousness +5 |
| loan officers, accountants, treasurer | conscientiousness +15, riskTolerance −10 |
| journalists, freelancers | openness +15 |
| VC partners | riskTolerance +20, ambition +15 |
| teachers, nurses | agreeableness +10 |
| gig/unemployed | (no shift — heterogeneity preserved) |

`timePreference` (patience) correlates +0.3 with conscientiousness; validation rejects populations where any dimension's sample mean deviates >8 from target.

### 5.7 Political-economic opinions (−100..100 per axis)

Base `N(0, 35)` clamped [−90, 90] on: `redistribution`, `regulation`, `institutionalTrust`, `economicOptimism`. Correlational structure (applied as generation weights, not hard rules): higher income → redistribution −15 mean shift; public employees → institutionalTrust +10; business owners → regulation −15; retirees → economicOptimism −5. Diversity floor: each axis must have ≥15 agents on each side of 0 (validation).

### 5.8 Skills

Per-occupation template: primary skill U[55–85], secondary U[30–60], one random general skill U[20–50]. Skill catalog: `finance, sales, operations, engineering, medicine, law, teaching, writing, cooking, construction, logistics, software, administration, communication`. Students: 2 random skills U[10–35].

### 5.9 Goals (1–3 per agent; weighted pools by segment)

| Segment | Pool (weight) |
|---|---|
| all adults | save_amount 3 · buy_durable 2 · find_better_job 1 |
| high ambition (≥70) & employed | start_business 3 · promotion 2 |
| owners | grow_business 3 · pay_off_loan 2 |
| students | finish_school 5 · save_amount 1 |
| unemployed | find_job 5 |
| near-retirement (55+) | retire_comfortably 4 |

Constraint: **exactly 3–5 agents** start with an *active* `start_business` goal with feasible savings trajectories (this seeds the company-formation storyline, PRD AC-5); the generator promotes/demotes candidates to hit this.

### 5.10 Social graph

- Household edges: `family`, strength U[50–90].
- Colleague edges: complete within staff ≤6, otherwise each agent gets 3–5 colleague edges, strength U[20–60].
- Friendships: preferential mixing by age-band proximity and shared workplace/sector; target mean degree **6 ± 2**, min 2 per agent.
- Adversaries: 3 pairs seeded (business rivals, a political disagreement pair), strength U[−60,−20].
- **Validation:** the graph is connected; no agent has 0 edges; degree cap 15.

### 5.11 Bank relationships

- Every adult and business holds a checking account at First Ledger Bank (world-gen mints the §5.4 balances).
- Existing credit at t0: Ironvale business loan (~$120k outstanding, 36-month, month 22); **6 personal loans** (car/appliance-sized, $3–12k) spread across mid/low-income adults, all current; 1 additional personal loan is 1 payment behind (seeds a collections storyline).
- The bank starts with capital and reserves calibrated so breakers do NOT bind at t0 (capital ratio ~14%, reserve ratio ~18%) but a credit boom can approach them within a year.

## 6. Generation pipeline (M02)

```
worldSpec (this doc as JSON, versioned & hashed)
  → 1. roster: instantiate role slots (§2–4) — exact counts
  → 2. persona sampling: age→education→skills→personality→opinions per templates (seeded streams: "gen.age", "gen.personality", …)
  → 3. naming: synthetic first/last name lists (curated, no real public figures; blocklist check)
  → 4. households: assemble structures honoring role/age constraints (students with families)
  → 5. finances: wages from bands; wealth from lognormal; accounts + mint transactions
  → 6. credit: seed loans (§5.11) with generated amortization history
  → 7. social graph (§5.10)
  → 8. goals (§5.9) incl. founder-candidate promotion
  → 9. constraint pass: minimal adjustments to satisfy hard constraints/exact counts
  → 10. validation gate (§7) — all-or-nothing; failure aborts run creation with a report
  → output: population + opening balance sheet + `world.genReport` (distribution stats, seed, spec hash)
```

## 7. Validation rules (hard gate)

1. Exactly 100 agents; role counts match §2–4 exactly.
2. Every agent: all persona fields in range; occupation ∈ catalog; wage inside band; age/education satisfy role constraints.
3. Names unique; none on the blocklist (SAF-2).
4. Every agent in exactly one household; household structure counts match §5.5.
5. Opening books balance: Σ mint transactions = Σ account balances; every seeded loan has consistent schedule/history; INV-1..6 pass on the opening state.
6. Distribution envelopes: age bands ±2; education ±3 (free population); mean wage $50–56k; wealth Gini 0.50–0.60; personality means ±8; opinion diversity floor; social-graph connectivity + degree bounds.
7. Storyline seeds present: 3–5 active founder goals; 1 delinquent loan; unemployment 5–7 agents.
8. Determinism: same (spec hash, seed) → byte-identical population (canonical serialization compare in CI).

## 8. Roles that are institutional systems, NOT LLM agents

These run as deterministic rule systems; some have a named persona for flavor only (news quotes), with zero decision authority:

| Function | Why not an agent |
|---|---|
| Exchange matching & settlement (Riverbend Exchange) | market integrity requires pure determinism (INV-7); the ops-manager persona never touches matching |
| Payroll processing, tax withholding & collection | accounting, not judgment |
| Company registrar (incorporation processing) | procedural; the *lawyers* are agents, the registry is a system |
| ROW supplier/buyer/landlord/pension fund | off-model counterparties; fixed/scenario-driven prices |
| Utility billing & tariff pass-through | formula-driven (M17) |
| Benefit payer (unemployment) | eligibility rules only |
| Monetary authority [V1] | Taylor-lite rule; explicitly not an LLM to keep policy experiments controlled |
| Bank amortization/collections engine | the loan *officer* judges within bounds; the math never does |

## 9. Starting macro state & stability envelopes

At t0: CPI 1000 · unemployment ~6.5% · M1 ≈ $5.1M (households $4.2M + business $0.9M) · credit outstanding ≈ $150k · 15 active employers · treasury $180k.

**360-tick baseline envelopes** (mock-LLM default scenario; used by scenario-regression tests; envelope v2 was rebaselined at the Phase 8 authoritative-genesis boundary):

| Metric | Expected envelope |
|---|---|
| unemployment | 3–12% at all times; no collapse to 0 or explosion >20% |
| CPI | 950–1200 (-5% to +20% drift max) |
| business failures | 0–3 |
| new companies | 1–4 |
| loan defaults | 0–4 |
| M1 drift | explained 100% by lending/repayment/ROW/mint events (conservation audit) |
| treasury | never negative; benefits suspended ≤ 30 total ticks |

Departures from envelopes fail the regression suite → either a rules bug or a deliberate recalibration (which updates this spec's version).

## 10. Scaling note (100 → 1,000+)

The same templates scale by multiplying segment counts (institutions gain staff slots; more businesses instantiated from sector templates). Distribution targets are ratios, not absolutes, except institution minima. worldSpec v2 will add: multiple banks, second news org, sector diversity knobs, and region partitions. Nothing in this spec assumes n=100 except §2–4 exact counts, which become per-1,000 tables.
