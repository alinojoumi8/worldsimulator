# ODD record for Agent Lab studies

Every Agent Lab study must complete this record before collecting treatment
data. The canonical experiment manifest pins executable details; this document
records purpose, interpretation, and fitness-for-purpose limits using the
Overview, Design concepts, and Details (ODD) structure.

## 1. Purpose and patterns

- **Study ID:**
- **Decision being supported:**
- **Intended users:**
- **Fitness-for-purpose claim:**
- **Claims explicitly not supported:**
- **Primary hypotheses and metric IDs:**
- **Patterns used for comparison:**
- **Known empirical or synthetic reference data:**

Riverbend is fictional and stylized by default. Do not claim national
calibration, forecasting, investment advice, legal advice, or policy prediction
without a separately versioned and reviewed jurisdiction-specific data pack.

## 2. Entities, state variables, and scales

Record the relevant citizens, households, firms, institutions, relationships,
markets, contracts, ledgers, event types, tick/calendar mapping, spatial
assumptions, monetary units, and cohort strata. Identify which state is:

- authoritative and visible to the engine;
- visible to each controlled citizen;
- public;
- learned through cited evidence;
- delivered through messages/news; or
- private and prohibited from the Agent Lab boundary.

## 3. Process overview and scheduling

Document the fixed tick phase order, when decision opportunities open, the
deadline, canonical opportunity ordering, fallback behavior, action
revalidation, intervention schedule, receipt finalization, and replay boundary.
Network completion order must never become authoritative scheduling order.

## 4. Design concepts

For each concept, state the implemented mechanism and its evidence:

- **Basic principles:** economic, social, and behavioral assumptions.
- **Emergence:** outcomes not directly scripted by an intervention.
- **Adaptation:** bounded utility or plan changes.
- **Objectives:** citizen goals and utility components.
- **Learning:** learned facts and evidence retention.
- **Prediction:** numeric expectations, if enabled.
- **Sensing:** `partial_observation_v1` visibility policy.
- **Interaction:** messages, negotiations, and relationship diffusion.
- **Stochasticity:** named seeded streams and any external-model variation.
- **Collectives:** household, firm, institution, and network effects.
- **Observation:** primary/secondary metrics and artifact sources.

Model prose or rationale is not authoritative state. A reflection may propose
only a schema-valid goal, belief, or opinion change supported by cited memory;
the engine owns validation and application.

## 5. Initialization

Record:

- world spec and version;
- frozen seeds;
- engine commit, Node version, and lockfile digest;
- cohort selection and resolved citizens;
- initial policies and interventions;
- model/provider settings, provider-environment name allowlist, runtime
  dependency versions, and budgets;
- exact prompt, driver-policy, and tool-schema digests; and
- whether the checkout and study directory were clean.

## 6. Input data

List every external or reference dataset, version, license, preprocessing step,
missing-data rule, and transformation. State `none` when the study uses only
synthetic Riverbend inputs. Human messages and unmanifested interventions are
not input data; they taint the trial.

## 7. Submodels

For every changed realism condition, document:

- equations or deterministic rules;
- parameters and units;
- input evidence;
- state written;
- invariants and failure behavior;
- counterfactual fixture;
- sensitivity analysis; and
- metrics expected to move.

Enable only one new realism condition in a comparison unless the study is
explicitly designed as an interaction test.

## 8. Validity and limitations

Report structural, behavioral, social, economic, and operational evidence
separately. Include adverse results, fallback/invalid rates, tainted trials,
missing metrics, and plausible alternative explanations. An optional blinded
LLM judge is a secondary measurement instrument, never the release oracle.

## 9. Reproduction receipt

Attach:

- canonical manifest digest;
- artifact hash heads and checksums;
- included and excluded trial IDs with reasons;
- `lab:verify` results;
- strict offline replay results;
- repository-gate results; and
- the generated study report.

Method reference: [ODD protocol update](https://doi.org/10.18564/jasss.4259).
