/** SQLite projection and deterministic workflows for WS-401 through WS-403. */

import {
  canonicalParse,
  canonicalStringify,
  companySchema,
  conversationOutcomeSchema,
  conversationTermBoundsSchema,
  employmentTerminationSchema,
  EngineError,
  jobApplicationSchema,
  jobSchema,
  ledgerTransactionSchema,
  legalContractSchema,
  type Company,
  type EmploymentTermination,
  type IdFactory,
  type Job,
  type JobApplication,
  type JobRequirement,
  type LegalContract,
} from "@worldtangle/shared";
import {
  assertJobPostingAllowed,
  completeLegalObligation,
  createContractFromTemplate,
  dueLegalObligations,
  fireLegalObligation,
  noticeEffectiveTick,
  overdueObligationIds,
  rankLaborCandidates,
  signLegalContract,
  termsWithinConversationBounds,
  transitionLegalContract,
  type TickContext,
} from "@worldtangle/engine";
import type { WorldDatabase } from "./database";
import { toSafeNumber } from "./database";
import { SqliteFinanceStore } from "./finance-store";

interface ContractRow {
  id: string;
  contract_type: LegalContract["type"];
  status: LegalContract["status"];
  terms_canonical: string;
  drafted_by_kind: LegalContract["draftedBy"]["kind"];
  drafted_by_id: string;
  fee_cents: string;
  created_tick: bigint;
  effective_tick: bigint;
  terminal_tick: bigint | null;
}

interface PartyRow {
  party_kind: LegalContract["parties"][number]["kind"];
  party_id: string;
  role: string;
  signed_tick: bigint | null;
}

interface ObligationRow {
  id: string;
  due_tick: bigint;
  recurrence_ticks: bigint | null;
  obligation_kind: LegalContract["obligations"][number]["kind"];
  params_canonical: string;
  status: LegalContract["obligations"][number]["status"];
  fired_tick: bigint | null;
  completed_tick: bigint | null;
}

interface BreachRow {
  id: string;
  predicate: LegalContract["breaches"][number]["predicate"];
  tick: bigint;
  details_canonical: string;
}

interface CompanyRow {
  id: string;
  name: string;
  sector: string;
  founder_agent_id: string;
  status: Company["status"];
  formation_stage: Company["formationStage"];
  incorporation_contract_id: string;
  business_account_id: string | null;
  law_firm_account_id: string;
  incorporation_fee_cents: string;
  founding_capital_cents: string;
  total_shares: string;
  founded_tick: bigint;
  registered_tick: bigint | null;
  activated_tick: bigint | null;
  failure_reason: string | null;
}

interface AchievedFounderGoalRow {
  id: string;
  agent_id: string;
  params_canonical: string;
  trigger_event_id: string;
  terminal_tick: bigint;
}

interface JobRow {
  id: string;
  employer_id: string;
  occupation_code: string;
  title: string;
  annual_wage_cents: string;
  requirements_canonical: string;
  openings: bigint;
  filled_count: bigint;
  status: Job["status"];
  posted_tick: bigint;
  expires_tick: bigint | null;
  payroll_risk: bigint;
}

interface ApplicationRow {
  id: string;
  job_id: string;
  agent_id: string;
  reservation_wage_cents: string;
  status: JobApplication["status"];
  score: bigint | null;
  submitted_tick: bigint;
  decided_tick: bigint | null;
}

interface EmploymentRow {
  id: string;
  employer_id: string;
  employer_account_id: string;
  employee_agent_id: string;
  annual_wage_cents: string;
  start_tick: bigint;
  end_tick: bigint | null;
  notice_days: bigint;
  status: "active" | "ended";
  legal_contract_id: string | null;
}

interface TerminationRow {
  id: string;
  employment_contract_id: string;
  initiated_by_kind: EmploymentTermination["initiatedBy"]["kind"];
  initiated_by_id: string;
  reason: EmploymentTermination["reason"];
  initiated_tick: bigint;
  effective_tick: bigint;
  status: EmploymentTermination["status"];
}

interface JobNegotiationRow {
  participant_a_id: string;
  participant_b_id: string;
  topic: string;
  status: string;
  close_reason: string | null;
  outcome_canonical: string | null;
  term_bounds_canonical: string;
  terminal_event_id: string | null;
}

export interface CompanyFailureRelationshipTeardown {
  readonly employeesTerminated: number;
  readonly contractsTerminated: number;
  readonly jobsWithdrawn: number;
  readonly applicationsDeclined: number;
  readonly eventIds: readonly string[];
}

export interface LaborDecisionCandidate {
  readonly companyId: string;
  readonly founderAgentId: string;
  readonly job: Job;
  readonly application: JobApplication;
  readonly score: number;
}

export interface FounderLaunchHireResult {
  readonly job: Job;
  readonly employmentContractId: string;
  readonly legalContractId: string;
  readonly eventIds: readonly string[];
}

export interface Tier2LaborDecisionInput {
  readonly applicationId: string;
  readonly founderAgentId: string;
  readonly applicantAgentId: string;
  readonly founderDecisionId: string;
  readonly applicantDecisionId: string;
  readonly founderResponse: "offer" | "defer";
  readonly applicantResponse: "accept" | "decline";
  readonly sourceEventId: string;
}

export interface Tier2LaborDecisionResult {
  readonly outcome: "hired" | "declined" | "deferred";
  readonly eventIds: readonly string[];
}

export interface NegotiatedHireInput {
  readonly conversationId: string;
  readonly bindingId: string;
  readonly applicationId: string;
  readonly founderAgentId: string;
  readonly applicantAgentId: string;
  readonly annualWageCents: string;
  readonly sourceEventId: string;
}

export interface NegotiatedHireResult {
  readonly employmentContractId: string;
  readonly legalContractId: string;
  readonly eventIds: readonly string[];
}

interface HiringEvidence {
  readonly correlationId: string;
  readonly causationId: string;
  readonly founderDecisionId?: string;
  readonly applicantDecisionId?: string;
  readonly conversationId?: string;
  readonly bindingId?: string;
  readonly annualWageCents?: string;
}

const SYSTEM_ACTOR = { kind: "system", id: "engine" } as const;

function parsedRecord(value: string, label: string): Readonly<Record<string, unknown>> {
  const parsed = canonicalParse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EngineError("SCHEMA_INVALID", `${label} must be a canonical object`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function normalizedCompanyName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function founderGoalTerms(row: AchievedFounderGoalRow): {
  readonly sector: string;
  readonly foundingCapitalCents: string;
} {
  const params = parsedRecord(row.params_canonical, `founder goal ${row.id} params`);
  const sector = params["sector"];
  const foundingCapitalCents = params["targetSavingsCents"];
  if (
    typeof sector !== "string" ||
    !/^[a-z][a-z0-9_]*$/.test(sector) ||
    typeof foundingCapitalCents !== "string" ||
    !/^[1-9][0-9]*$/.test(foundingCapitalCents)
  ) {
    throw new EngineError(
      "SCHEMA_INVALID",
      `founder goal ${row.id} lacks valid sector or target savings`,
    );
  }
  return { sector, foundingCapitalCents };
}

function founderCompanyName(agentId: string, sector: string): string {
  return `Riverbend ${sector.replaceAll("_", " ")} ${agentId.slice(-4)}`;
}

export class SqlitePhase4Store {
  private readonly finance: SqliteFinanceStore;

  constructor(
    private readonly db: WorldDatabase,
    private readonly runId: string,
  ) {
    this.finance = new SqliteFinanceStore(db, runId);
  }

  processAchievedFounderGoals(ctx: TickContext): readonly string[] {
    const rows = this.db.prepare<[string, number], AchievedFounderGoalRow>(`
      SELECT g.id, g.agent_id, g.params_canonical, g.trigger_event_id, g.terminal_tick
      FROM goals g
      WHERE g.run_id = ?
        AND g.kind = 'start_business'
        AND g.status = 'achieved'
        AND g.terminal_tick <= ?
        AND NOT EXISTS (
          SELECT 1 FROM companies c
          WHERE c.run_id = g.run_id AND c.founder_agent_id = g.agent_id
        )
      ORDER BY g.agent_id, g.id
    `).all(this.runId, ctx.tick);
    const formed: string[] = [];
    let lawFirmAccountId: string | undefined;
    for (const row of rows) {
      const terms = founderGoalTerms(row);
      const incorporationFeeCents = "10000";
      const founderAccount = this.finance.accountForAgent(row.agent_id);
      const required = BigInt(terms.foundingCapitalCents) + BigInt(incorporationFeeCents);
      if (this.finance.accountBalance(founderAccount.id) < required) {
        if (toSafeNumber(row.terminal_tick, `founder goal ${row.id} terminal tick`) === ctx.tick) {
          ctx.emit("company.formation.deferred", {
            founderAgentId: row.agent_id,
            goalId: row.id,
            reason: "insufficient_founder_funds",
            requiredCents: required.toString(),
            availableCents: this.finance.accountBalance(founderAccount.id).toString(),
          }, {
            actor: { kind: "agent", id: row.agent_id },
            correlationId: row.id,
            causationId: row.trigger_event_id,
          });
        }
        continue;
      }
      if (lawFirmAccountId === undefined) {
        const lawFirmAccount = this.finance.listAccounts().find((account) => (
          account.ownerKind === "company" && account.type === "checking"
        ));
        if (lawFirmAccount === undefined) {
          throw new EngineError("NOT_FOUND", "Riverbend filing-counsel account is missing");
        }
        lawFirmAccountId = lawFirmAccount.id;
      }
      const requested = this.requestCompanyFormation({
        name: founderCompanyName(row.agent_id, terms.sector),
        sector: terms.sector,
        founderAgentId: row.agent_id,
        jurisdiction: "Riverbend",
        foundingCapitalCents: terms.foundingCapitalCents,
        totalShares: "1000",
        lawFirmAccountId,
        incorporationFeeCents,
        tick: ctx.tick,
        ids: ctx.ids,
      });
      const requestEvent = ctx.emit("company.formation.requested", {
        companyId: requested.company.id,
        contractId: requested.contract.id,
        founderAgentId: row.agent_id,
        goalId: row.id,
        sector: terms.sector,
        foundingCapitalCents: terms.foundingCapitalCents,
      }, {
        actor: { kind: "agent", id: row.agent_id },
        correlationId: row.id,
        causationId: row.trigger_event_id,
      });
      let signatureCause = requestEvent.eventId;
      for (const party of requested.contract.parties) {
        const signatureActor = party.kind === "company"
          ? SYSTEM_ACTOR
          : { kind: party.kind, id: party.id } as const;
        const signed = this.signContract(
          requested.contract.id,
          { kind: party.kind, id: party.id },
          ctx.tick,
          ctx.ids,
        );
        const signatureEvent = ctx.emit("contract.signature_collected", {
          contractId: requested.contract.id,
          companyId: requested.company.id,
          partyKind: party.kind,
          partyId: party.id,
          status: signed.status,
        }, {
          actor: signatureActor,
          correlationId: row.id,
          causationId: signatureCause,
        });
        signatureCause = signatureEvent.eventId;
        if (signed.status === "signed") {
          ctx.emit("contract.signed", {
            contractId: requested.contract.id,
            companyId: requested.company.id,
            founderAgentId: row.agent_id,
            goalId: row.id,
          }, {
            actor: SYSTEM_ACTOR,
            correlationId: row.id,
            causationId: signatureCause,
          });
        }
      }
      formed.push(requested.company.id);
    }
    return Object.freeze(formed);
  }

  getLegalContract(contractId: string): LegalContract {
    const row = this.db.prepare<[string, string], ContractRow>(`
      SELECT id, contract_type, status, terms_canonical, drafted_by_kind,
        drafted_by_id, fee_cents, created_tick, effective_tick, terminal_tick
      FROM legal_contracts WHERE run_id = ? AND id = ?
    `).get(this.runId, contractId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `contract ${contractId} does not exist`);
    const parties = this.db.prepare<[string, string], PartyRow>(`
      SELECT party_kind, party_id, role, signed_tick
      FROM legal_contract_parties
      WHERE run_id = ? AND contract_id = ? ORDER BY party_index
    `).all(this.runId, contractId).map((party) => ({
      kind: party.party_kind,
      id: party.party_id,
      role: party.role,
      signedTick: party.signed_tick === null
        ? null
        : toSafeNumber(party.signed_tick, "contract party signed tick"),
    }));
    const obligations = this.db.prepare<[string, string], ObligationRow>(`
      SELECT id, due_tick, recurrence_ticks, obligation_kind, params_canonical,
        status, fired_tick, completed_tick
      FROM legal_obligations
      WHERE run_id = ? AND contract_id = ? ORDER BY due_tick, id
    `).all(this.runId, contractId).map((obligation) => ({
      id: obligation.id,
      dueTick: toSafeNumber(obligation.due_tick, "legal obligation due tick"),
      recurrenceTicks: obligation.recurrence_ticks === null
        ? null
        : toSafeNumber(obligation.recurrence_ticks, "legal obligation recurrence"),
      kind: obligation.obligation_kind,
      params: parsedRecord(obligation.params_canonical, `obligation ${obligation.id} params`),
      status: obligation.status,
      firedTick: obligation.fired_tick === null
        ? null
        : toSafeNumber(obligation.fired_tick, "legal obligation fired tick"),
      completedTick: obligation.completed_tick === null
        ? null
        : toSafeNumber(obligation.completed_tick, "legal obligation completed tick"),
    }));
    const breaches = this.db.prepare<[string, string], BreachRow>(`
      SELECT id, predicate, tick, details_canonical
      FROM legal_contract_breaches
      WHERE run_id = ? AND contract_id = ? ORDER BY tick, id
    `).all(this.runId, contractId).map((breach) => ({
      id: breach.id,
      predicate: breach.predicate,
      tick: toSafeNumber(breach.tick, "legal breach tick"),
      details: parsedRecord(breach.details_canonical, `breach ${breach.id} details`),
    }));
    return legalContractSchema.parse({
      id: row.id,
      runId: this.runId,
      type: row.contract_type,
      parties,
      terms: canonicalParse(row.terms_canonical),
      obligations,
      draftedBy: { kind: row.drafted_by_kind, id: row.drafted_by_id },
      feeCents: row.fee_cents,
      status: row.status,
      createdTick: toSafeNumber(row.created_tick, "contract created tick"),
      effectiveTick: toSafeNumber(row.effective_tick, "contract effective tick"),
      terminalTick: row.terminal_tick === null
        ? null
        : toSafeNumber(row.terminal_tick, "contract terminal tick"),
      breaches,
    });
  }

  listLegalContracts(): readonly LegalContract[] {
    return this.db.prepare<[string], { id: string }>(`
      SELECT id FROM legal_contracts WHERE run_id = ? ORDER BY id
    `).all(this.runId).map((row) => this.getLegalContract(row.id));
  }

  insertLegalContract(contract: LegalContract, ids?: IdFactory): LegalContract {
    const validated = legalContractSchema.parse(contract);
    this.db.prepare(`
      INSERT INTO legal_contracts (
        run_id, id, contract_type, status, terms_canonical, drafted_by_kind,
        drafted_by_id, fee_cents, created_tick, effective_tick, terminal_tick
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.runId,
      validated.id,
      validated.type,
      validated.status,
      canonicalStringify(validated.terms),
      validated.draftedBy.kind,
      validated.draftedBy.id,
      validated.feeCents,
      validated.createdTick,
      validated.effectiveTick,
      validated.terminalTick,
    );
    validated.parties.forEach((party, index) => {
      this.db.prepare(`
        INSERT INTO legal_contract_parties (
          run_id, contract_id, party_index, party_kind, party_id, role, signed_tick
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(this.runId, validated.id, index, party.kind, party.id, party.role, party.signedTick);
    });
    for (const obligation of validated.obligations) {
      this.db.prepare(`
        INSERT INTO legal_obligations (
          run_id, id, contract_id, due_tick, recurrence_ticks, obligation_kind,
          params_canonical, status, fired_tick, completed_tick
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.runId,
        obligation.id,
        validated.id,
        obligation.dueTick,
        obligation.recurrenceTicks,
        obligation.kind,
        canonicalStringify(obligation.params),
        obligation.status,
        obligation.firedTick,
        obligation.completedTick,
      );
    }
    if (ids !== undefined) {
      this.appendContractTimeline(ids, validated.id, validated.createdTick, "contract.drafted", {
        type: validated.type,
      });
    }
    return validated;
  }

  signContract(
    contractId: string,
    party: { readonly kind: "agent" | "company" | "institution"; readonly id: string },
    tick: number,
    ids?: IdFactory,
  ): LegalContract {
    const signed = signLegalContract(this.getLegalContract(contractId), party, tick);
    this.saveLegalContract(signed);
    if (ids !== undefined) {
      this.appendContractTimeline(ids, contractId, tick, "contract.signature_collected", party);
      if (signed.status === "signed") {
        this.appendContractTimeline(ids, contractId, tick, "contract.signed", {});
      }
    }
    return signed;
  }

  requestCompanyFormation(input: {
    readonly name: string;
    readonly sector: string;
    readonly founderAgentId: string;
    readonly jurisdiction: string;
    readonly foundingCapitalCents: string;
    readonly totalShares: string;
    readonly lawFirmAccountId: string;
    readonly incorporationFeeCents: string;
    readonly tick: number;
    readonly ids: IdFactory;
  }): { readonly company: Company; readonly contract: LegalContract } {
    if (BigInt(input.incorporationFeeCents) <= 0n) {
      throw new EngineError("VALIDATION_FAILED", "incorporation fee must be positive");
    }
    const founder = this.db.prepare<[string, string], { id: string }>(`
      SELECT id FROM agents WHERE run_id = ? AND id = ?
    `).get(this.runId, input.founderAgentId);
    if (founder === undefined) throw new EngineError("NOT_FOUND", `founder ${input.founderAgentId} does not exist`);
    const existing = this.db.prepare<[string, string], { id: string }>(`
      SELECT id FROM companies WHERE run_id = ? AND normalized_name = ?
    `).get(this.runId, normalizedCompanyName(input.name));
    if (existing !== undefined) throw new EngineError("CONFLICT", `company name ${input.name} is unavailable`);
    const lawFirmAccount = this.finance.listAccounts()
      .find((account) => account.id === input.lawFirmAccountId);
    if (lawFirmAccount === undefined) {
      throw new EngineError("NOT_FOUND", `law firm account ${input.lawFirmAccountId} does not exist`);
    }
    const founderAccount = this.finance.accountForAgent(input.founderAgentId);
    const required = BigInt(input.foundingCapitalCents) + BigInt(input.incorporationFeeCents);
    if (this.finance.accountBalance(founderAccount.id) < required) {
      throw new EngineError("INSUFFICIENT_FUNDS", "founder cannot fund the fee and founding capital");
    }

    const companyId = input.ids.next("co");
    const contract = createContractFromTemplate({
      id: input.ids.next("ctr"),
      runId: this.runId,
      type: "incorporation",
      parties: [
        { kind: "agent", id: input.founderAgentId, role: "founder" },
        { kind: "institution", id: lawFirmAccount.ownerId, role: "filing_counsel" },
      ],
      terms: {
        template: "incorporation",
        companyName: input.name,
        jurisdiction: input.jurisdiction,
        founderAgentId: input.founderAgentId,
        foundingCapitalCents: input.foundingCapitalCents,
        totalShares: input.totalShares,
      },
      draftedBy: SYSTEM_ACTOR,
      feeCents: input.incorporationFeeCents,
      createdTick: input.tick,
      effectiveTick: input.tick + 1,
      ids: input.ids,
    });
    this.insertLegalContract(contract, input.ids);
    const company = companySchema.parse({
      id: companyId,
      runId: this.runId,
      name: input.name,
      sector: input.sector,
      founderAgentId: input.founderAgentId,
      status: "forming",
      formationStage: "agreement_drafted",
      incorporationContractId: contract.id,
      businessAccountId: null,
      foundingCapitalCents: input.foundingCapitalCents,
      totalShares: input.totalShares,
      foundedTick: input.tick,
      registeredTick: null,
      activatedTick: null,
      failureReason: null,
    });
    this.db.prepare(`
      INSERT INTO companies (
        run_id, id, name, normalized_name, sector, founder_agent_id, status,
        formation_stage, incorporation_contract_id, business_account_id,
        law_firm_account_id, incorporation_fee_cents, founding_capital_cents,
        total_shares, founded_tick, registered_tick, activated_tick, failure_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.runId,
      company.id,
      company.name,
      normalizedCompanyName(company.name),
      company.sector,
      company.founderAgentId,
      company.status,
      company.formationStage,
      company.incorporationContractId,
      null,
      input.lawFirmAccountId,
      input.incorporationFeeCents,
      company.foundingCapitalCents,
      company.totalShares,
      company.foundedTick,
      null,
      null,
      null,
    );
    this.appendCompanyTimeline(input.ids, company.id, input.tick, "company.formation.requested", {
      contractId: contract.id,
      founderAgentId: company.founderAgentId,
    });
    return { company, contract };
  }

  getCompany(companyId: string): Company {
    return this.companyFromRow(this.getCompanyRow(companyId));
  }

  listCompanies(): readonly Company[] {
    return this.db.prepare<[string], CompanyRow>(`
      SELECT id, name, sector, founder_agent_id, status, formation_stage,
        incorporation_contract_id, business_account_id, law_firm_account_id,
        incorporation_fee_cents, founding_capital_cents, total_shares,
        founded_tick, registered_tick, activated_tick, failure_reason
      FROM companies WHERE run_id = ? ORDER BY id
    `).all(this.runId).map((row) => this.companyFromRow(row));
  }

  assertCompanyCanOperate(companyId: string, operation: "hire" | "trade"): Company {
    const company = this.getCompany(companyId);
    if (company.status !== "active") {
      throw new EngineError("CONFLICT", `company ${companyId} cannot ${operation} before activation`);
    }
    return company;
  }

  postJob(input: {
    readonly employerId: string;
    readonly occupationCode: string;
    readonly title: string;
    readonly annualWageCents: string;
    readonly requirements: readonly JobRequirement[];
    readonly openings: number;
    readonly expiresTick?: number;
    readonly tick: number;
    readonly ids: IdFactory;
  }): Job {
    const company = this.assertCompanyCanOperate(input.employerId, "hire");
    if (company.activatedTick !== null && input.tick <= company.activatedTick) {
      throw new EngineError("CONFLICT", "an activated company may post jobs starting on the next tick");
    }
    assertJobPostingAllowed(company.status, input.annualWageCents);
    if (company.businessAccountId === null) {
      throw new EngineError("CONFLICT", "active company is missing its business account");
    }
    const monthlyPayroll = (BigInt(input.annualWageCents) * BigInt(input.openings) + 11n) / 12n;
    const job = jobSchema.parse({
      id: input.ids.next("job"),
      runId: this.runId,
      employerId: input.employerId,
      occupationCode: input.occupationCode,
      title: input.title,
      annualWageCents: input.annualWageCents,
      requirements: input.requirements,
      openings: input.openings,
      filledCount: 0,
      status: "open",
      postedTick: input.tick,
      expiresTick: input.expiresTick ?? null,
      payrollRisk: this.finance.accountBalance(company.businessAccountId) < monthlyPayroll,
    });
    this.db.prepare(`
      INSERT INTO jobs (
        run_id, id, employer_id, occupation_code, title, annual_wage_cents,
        requirements_canonical, openings, filled_count, status, posted_tick,
        expires_tick, payroll_risk
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.runId,
      job.id,
      job.employerId,
      job.occupationCode,
      job.title,
      job.annualWageCents,
      canonicalStringify(job.requirements),
      job.openings,
      job.filledCount,
      job.status,
      job.postedTick,
      job.expiresTick,
      job.payrollRisk ? 1 : 0,
    );
    return job;
  }

  submitJobApplication(input: {
    readonly jobId: string;
    readonly agentId: string;
    readonly reservationWageCents: string;
    readonly tick: number;
    readonly ids: IdFactory;
  }): JobApplication {
    const job = this.getJob(input.jobId);
    if (job.status !== "open" || (job.expiresTick !== null && job.expiresTick < input.tick)) {
      throw new EngineError("CONFLICT", `job ${job.id} is not accepting applications`);
    }
    const agent = this.db.prepare<[string, string], { id: string }>(`
      SELECT id FROM agents WHERE run_id = ? AND id = ?
    `).get(this.runId, input.agentId);
    if (agent === undefined) throw new EngineError("NOT_FOUND", `agent ${input.agentId} does not exist`);
    const application = jobApplicationSchema.parse({
      id: input.ids.next("app"),
      runId: this.runId,
      jobId: input.jobId,
      agentId: input.agentId,
      reservationWageCents: input.reservationWageCents,
      status: "submitted",
      score: null,
      submittedTick: input.tick,
      decidedTick: null,
    });
    this.db.prepare(`
      INSERT INTO job_applications (
        run_id, id, job_id, agent_id, reservation_wage_cents,
        status, score, submitted_tick, decided_tick
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.runId,
      application.id,
      application.jobId,
      application.agentId,
      application.reservationWageCents,
      application.status,
      null,
      application.submittedTick,
      null,
    );
    return application;
  }

  hireFounderLaunchApplication(
    input: {
      readonly applicationId: string;
      readonly correlationId: string;
      readonly sourceEventId: string;
    },
    ctx: TickContext,
  ): FounderLaunchHireResult {
    const row = this.db.prepare<[string, string], ApplicationRow>(`
      SELECT id, job_id, agent_id, reservation_wage_cents, status, score,
        submitted_tick, decided_tick
      FROM job_applications WHERE run_id = ? AND id = ?
    `).get(this.runId, input.applicationId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `application ${input.applicationId} does not exist`);
    }
    const application = this.applicationFromRow(row);
    const job = this.getJob(application.jobId);
    const founderVenture = this.db.prepare<[string, string], { id: string }>(`
      SELECT c.id FROM companies c
      WHERE c.run_id = ? AND c.id = ? AND c.status = 'active'
        AND EXISTS (
          SELECT 1 FROM goals g
          WHERE g.run_id = c.run_id AND g.agent_id = c.founder_agent_id
            AND g.kind = 'start_business' AND g.status = 'achieved'
        )
    `).get(this.runId, job.employerId);
    if (founderVenture === undefined) {
      throw new EngineError(
        "PERMISSION_DENIED",
        `company ${job.employerId} is not an achieved founder venture`,
      );
    }
    const selected = this.rankedApplicationsForJob(job)
      .find((candidate) => candidate.application.id === application.id);
    if (selected === undefined) {
      throw new EngineError(
        "CONFLICT",
        `application ${application.id} is not eligible for deterministic launch hiring`,
      );
    }
    return this.hireApplication(application, selected.score, ctx, {
      correlationId: input.correlationId,
      causationId: input.sourceEventId,
    });
  }

  getJob(jobId: string): Job {
    const row = this.db.prepare<[string, string], JobRow>(`
      SELECT id, employer_id, occupation_code, title, annual_wage_cents,
        requirements_canonical, openings, filled_count, status, posted_tick,
        expires_tick, payroll_risk
      FROM jobs WHERE run_id = ? AND id = ?
    `).get(this.runId, jobId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `job ${jobId} does not exist`);
    return this.jobFromRow(row);
  }

  listJobApplications(jobId: string): readonly JobApplication[] {
    return this.db.prepare<[string, string], ApplicationRow>(`
      SELECT id, job_id, agent_id, reservation_wage_cents, status, score,
        submitted_tick, decided_tick
      FROM job_applications WHERE run_id = ? AND job_id = ? ORDER BY agent_id, id
    `).all(this.runId, jobId).map((row) => this.applicationFromRow(row));
  }

  /** One deterministic top candidate per open job for the Tier-2 tick menu. */
  listLaborDecisionCandidates(tick: number): readonly LaborDecisionCandidate[] {
    if (!Number.isSafeInteger(tick) || tick < 1) {
      throw new EngineError("VALIDATION_FAILED", "labor decision tick must be positive");
    }
    const rows = this.db.prepare<[string], { id: string; founder_agent_id: string }>(`
      SELECT j.id, c.founder_agent_id
      FROM jobs j
      JOIN companies c ON c.run_id = j.run_id AND c.id = j.employer_id
      WHERE j.run_id = ? AND j.status = 'open' AND c.status = 'active'
      ORDER BY j.posted_tick, j.id
    `).all(this.runId);
    const candidates: LaborDecisionCandidate[] = [];
    for (const row of rows) {
      const job = this.getJob(row.id);
      if (job.expiresTick !== null && job.expiresTick < tick) continue;
      if (job.filledCount >= job.openings) continue;
      const ranked = this.rankedApplicationsForJob(job);
      const selected = ranked[0];
      if (selected === undefined) continue;
      // A new application is reviewed at the next boundary; a deferred offer
      // returns to the bounded menu weekly rather than on every tick.
      if ((tick - selected.application.submittedTick - 1) % 7 !== 0) continue;
      candidates.push(Object.freeze({
        companyId: job.employerId,
        founderAgentId: row.founder_agent_id,
        job,
        application: selected.application,
        score: selected.score,
      }));
    }
    return Object.freeze(candidates);
  }

  getLaborNegotiationCandidate(
    applicationId: string,
    tick: number,
  ): LaborDecisionCandidate {
    if (!Number.isSafeInteger(tick) || tick < 1) {
      throw new EngineError("VALIDATION_FAILED", "labor negotiation tick must be positive");
    }
    const row = this.db.prepare<[string, string], ApplicationRow>(`
      SELECT id, job_id, agent_id, reservation_wage_cents, status, score,
        submitted_tick, decided_tick
      FROM job_applications WHERE run_id = ? AND id = ?
    `).get(this.runId, applicationId);
    if (row === undefined) {
      throw new EngineError("NOT_FOUND", `job application ${applicationId} does not exist`);
    }
    const application = this.applicationFromRow(row);
    if (application.status !== "submitted") {
      throw new EngineError("CONFLICT", `job application ${applicationId} is not available`);
    }
    const job = this.getJob(application.jobId);
    if (
      job.status !== "open" ||
      job.filledCount >= job.openings ||
      (job.expiresTick !== null && job.expiresTick < tick)
    ) {
      throw new EngineError("CONFLICT", `job ${job.id} has no current vacancy`);
    }
    const company = this.assertCompanyCanOperate(job.employerId, "hire");
    const selected = this.rankedApplicationsForJob(job)[0];
    if (selected === undefined || selected.application.id !== application.id) {
      throw new EngineError(
        "CONFLICT",
        `job application ${applicationId} is not the current ranked candidate`,
      );
    }
    return Object.freeze({
      companyId: company.id,
      founderAgentId: company.founderAgentId,
      job,
      application,
      score: selected.score,
    });
  }

  hireNegotiatedApplication(
    input: NegotiatedHireInput,
    ctx: TickContext,
  ): NegotiatedHireResult {
    const candidate = this.getLaborNegotiationCandidate(input.applicationId, ctx.tick);
    if (
      candidate.founderAgentId !== input.founderAgentId ||
      candidate.application.agentId !== input.applicantAgentId
    ) {
      throw new EngineError("PERMISSION_DENIED", "job negotiation participants lack authority");
    }
    const wage = BigInt(input.annualWageCents);
    if (
      wage < BigInt(candidate.application.reservationWageCents) ||
      wage > BigInt(candidate.job.annualWageCents)
    ) {
      throw new EngineError("VALIDATION_FAILED", "negotiated wage is outside current job bounds");
    }
    const conversation = this.db.prepare<[string, string], JobNegotiationRow>(`
      SELECT participant_a_id, participant_b_id, topic, status, close_reason,
        outcome_canonical, term_bounds_canonical, terminal_event_id
      FROM conversations WHERE run_id = ? AND id = ?
    `).get(this.runId, input.conversationId);
    if (
      conversation === undefined ||
      conversation.topic !== "job" ||
      conversation.status !== "concluded" ||
      conversation.close_reason !== "agreement" ||
      conversation.outcome_canonical === null ||
      conversation.terminal_event_id !== input.sourceEventId
    ) {
      throw new EngineError("PERMISSION_DENIED", "job conversation is not a final agreement");
    }
    if (
      conversation.participant_a_id !== input.applicantAgentId ||
      conversation.participant_b_id !== input.founderAgentId
    ) {
      throw new EngineError("PERMISSION_DENIED", "job conversation participants do not match");
    }
    const outcome = conversationOutcomeSchema.parse(canonicalParse(conversation.outcome_canonical));
    const bounds = conversationTermBoundsSchema.parse(canonicalParse(
      conversation.term_bounds_canonical,
    ));
    if (
      outcome.kind !== "agreement" ||
      outcome.structuredTerms?.kind !== "job" ||
      outcome.structuredTerms.referenceId !== input.applicationId ||
      outcome.structuredTerms.annualWageCents !== input.annualWageCents ||
      !termsWithinConversationBounds(bounds, outcome.structuredTerms)
    ) {
      throw new EngineError("VALIDATION_FAILED", "employment differs from binding structured terms");
    }
    const hired = this.hireApplication(candidate.application, candidate.score, ctx, {
      correlationId: input.conversationId,
      causationId: input.sourceEventId,
      conversationId: input.conversationId,
      bindingId: input.bindingId,
      annualWageCents: input.annualWageCents,
    });
    return Object.freeze({
      employmentContractId: hired.employmentContractId,
      legalContractId: hired.legalContractId,
      eventIds: hired.eventIds,
    });
  }

  applyTier2LaborDecision(
    input: Tier2LaborDecisionInput,
    ctx: TickContext,
  ): Tier2LaborDecisionResult {
    const candidate = this.listLaborDecisionCandidates(ctx.tick)
      .find((item) => item.application.id === input.applicationId);
    if (candidate === undefined) {
      throw new EngineError(
        "CONFLICT",
        `job application ${input.applicationId} is not the current ranked candidate`,
      );
    }
    if (
      candidate.founderAgentId !== input.founderAgentId ||
      candidate.application.agentId !== input.applicantAgentId
    ) {
      throw new EngineError("PERMISSION_DENIED", "labor decision actors do not own this offer");
    }
    const decisions = this.db.prepare<[string, string, string], {
      id: string;
      agent_id: string;
      tick: bigint;
      tier: bigint;
    }>(`
      SELECT id, agent_id, tick, tier FROM decisions
      WHERE run_id = ? AND id IN (?, ?) ORDER BY id
    `).all(this.runId, input.founderDecisionId, input.applicantDecisionId);
    if (decisions.length !== 2) {
      throw new EngineError("NOT_FOUND", "labor choice requires both persisted decisions");
    }
    for (const decision of decisions) {
      const expectedAgent = decision.id === input.founderDecisionId
        ? input.founderAgentId
        : input.applicantAgentId;
      if (
        decision.agent_id !== expectedAgent ||
        toSafeNumber(decision.tick, "labor decision tick") !== ctx.tick ||
        (decision.tier !== 1n && decision.tier !== 2n)
      ) {
        throw new EngineError("PERMISSION_DENIED", "labor decision identity or tick is invalid");
      }
    }
    if (input.applicantResponse === "decline") {
      this.decideApplication(candidate.application.id, "declined", candidate.score, ctx.tick);
      const event = ctx.emit("job.application.declined", {
        jobId: candidate.job.id,
        applicationId: candidate.application.id,
        agentId: candidate.application.agentId,
        reason: "tier2_applicant_declined",
        founderDecisionId: input.founderDecisionId,
        applicantDecisionId: input.applicantDecisionId,
      }, {
        actor: { kind: "agent", id: input.applicantAgentId },
        correlationId: input.applicantDecisionId,
        causationId: input.sourceEventId,
      });
      return Object.freeze({
        outcome: "declined",
        eventIds: Object.freeze([event.eventId]),
      });
    }
    if (input.founderResponse === "defer") {
      return Object.freeze({ outcome: "deferred", eventIds: Object.freeze([]) });
    }
    const hired = this.hireApplication(
      candidate.application,
      candidate.score,
      ctx,
      {
        correlationId: input.founderDecisionId,
        causationId: input.sourceEventId,
        founderDecisionId: input.founderDecisionId,
        applicantDecisionId: input.applicantDecisionId,
      },
    );
    return Object.freeze({ outcome: "hired", eventIds: hired.eventIds });
  }

  /** Tier-2 mode still expires jobs, but never silently auto-hires applicants. */
  processTier2LaborHousekeeping(ctx: TickContext): void {
    const jobs = this.db.prepare<[string], { id: string }>(`
      SELECT id FROM jobs WHERE run_id = ? AND status = 'open'
      ORDER BY posted_tick, id
    `).all(this.runId);
    for (const row of jobs) {
      const job = this.getJob(row.id);
      if (job.expiresTick === null || job.expiresTick >= ctx.tick) continue;
      this.db.prepare(`UPDATE jobs SET status = 'expired' WHERE run_id = ? AND id = ?`)
        .run(this.runId, job.id);
      this.declineRemainingApplications(job.id, ctx.tick, ctx, "expired");
      ctx.emit("job.expired", { jobId: job.id, employerId: job.employerId });
    }
  }

  requestEmploymentTermination(input: {
    readonly employmentContractId: string;
    readonly initiatedBy: EmploymentTermination["initiatedBy"];
    readonly reason: EmploymentTermination["reason"];
    readonly tick: number;
    readonly ids: IdFactory;
  }): EmploymentTermination {
    const employment = this.getEmployment(input.employmentContractId);
    if (employment.status !== "active") {
      throw new EngineError("CONFLICT", `employment ${employment.id} is not active`);
    }
    if (input.reason === "quit" && (
      input.initiatedBy.kind !== "agent" || input.initiatedBy.id !== employment.employee_agent_id
    )) {
      throw new EngineError("PERMISSION_DENIED", "only the employee may quit");
    }
    if (input.reason === "layoff" && (
      input.initiatedBy.kind !== "company" || input.initiatedBy.id !== employment.employer_id
    )) {
      throw new EngineError("PERMISSION_DENIED", "only the employer may initiate a layoff");
    }
    const termination = employmentTerminationSchema.parse({
      id: input.ids.next("trm"),
      runId: this.runId,
      employmentContractId: employment.id,
      initiatedBy: input.initiatedBy,
      reason: input.reason,
      initiatedTick: input.tick,
      effectiveTick: noticeEffectiveTick(
        input.tick,
        toSafeNumber(employment.notice_days, "employment notice days"),
      ),
      status: "pending",
    });
    this.db.prepare(`
      INSERT INTO employment_terminations (
        run_id, id, employment_contract_id, initiated_by_kind, initiated_by_id,
        reason, initiated_tick, effective_tick, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.runId,
      termination.id,
      termination.employmentContractId,
      termination.initiatedBy.kind,
      termination.initiatedBy.id,
      termination.reason,
      termination.initiatedTick,
      termination.effectiveTick,
      termination.status,
    );
    return termination;
  }

  terminateCompanyRelationshipsForFailure(
    companyId: string,
    ctx: TickContext,
    causationId: string,
  ): CompanyFailureRelationshipTeardown {
    const company = this.getCompany(companyId);
    if (!["insolvent", "winding_down"].includes(company.status)) {
      throw new EngineError(
        "CONFLICT",
        `company ${companyId} must be insolvent before failure termination`,
      );
    }
    const correlationId = `company-wind-down:${companyId}`;
    const eventIds: string[] = [];
    let contractsTerminated = 0;
    const employments = this.db.prepare<[string, string], EmploymentRow>(`
      SELECT id, employer_id, employer_account_id, employee_agent_id,
        annual_wage_cents, start_tick, end_tick, notice_days, status, legal_contract_id
      FROM employment_contracts
      WHERE run_id = ? AND employer_id = ? AND status = 'active'
      ORDER BY employee_agent_id, id
    `).all(this.runId, companyId);
    for (const employment of employments) {
      const existing = this.db.prepare<[string, string], TerminationRow>(`
        SELECT id, employment_contract_id, initiated_by_kind, initiated_by_id,
          reason, initiated_tick, effective_tick, status
        FROM employment_terminations
        WHERE run_id = ? AND employment_contract_id = ?
      `).get(this.runId, employment.id);
      const terminationId = existing?.id ?? ctx.ids.next("trm");
      if (existing === undefined) {
        this.db.prepare(`
          INSERT INTO employment_terminations (
            run_id, id, employment_contract_id, initiated_by_kind, initiated_by_id,
            reason, initiated_tick, effective_tick, status
          ) VALUES (?, ?, ?, 'system', 'M08-insolvency', 'company_failure', ?, ?, 'effective')
        `).run(this.runId, terminationId, employment.id, ctx.tick, ctx.tick);
      } else {
        this.db.prepare(`
          UPDATE employment_terminations
          SET initiated_by_kind = 'system', initiated_by_id = 'M08-insolvency',
            reason = 'company_failure', effective_tick = ?, status = 'effective'
          WHERE run_id = ? AND id = ?
        `).run(ctx.tick, this.runId, existing.id);
      }
      this.db.prepare(`
        UPDATE employment_contracts SET status = 'ended', end_tick = ?
        WHERE run_id = ? AND id = ? AND status = 'active'
      `).run(ctx.tick, this.runId, employment.id);
      this.db.prepare(`
        UPDATE agents SET employment_status = 'unemployed', organization_id = NULL,
          annual_income_cents = '0'
        WHERE run_id = ? AND id = ?
      `).run(this.runId, employment.employee_agent_id);
      let employmentCause = causationId;
      if (employment.legal_contract_id !== null) {
        const contract = this.getLegalContract(employment.legal_contract_id);
        if (contract.status === "active") {
          const waived = legalContractSchema.parse({
            ...contract,
            obligations: contract.obligations.map((obligation) => (
              ["pending", "fired"].includes(obligation.status)
                ? { ...obligation, status: "waived" as const }
                : obligation
            )),
          });
          const terminated = transitionLegalContract(waived, "terminated", ctx.tick);
          this.saveLegalContract(terminated);
          this.appendContractTimeline(ctx.ids, contract.id, ctx.tick, "contract.terminated", {
            reason: "company_failure",
          });
          const contractEvent = ctx.emit("contract.terminated", {
            contractId: contract.id,
            companyId,
            reason: "company_failure",
          }, { correlationId, causationId });
          eventIds.push(contractEvent.eventId);
          employmentCause = contractEvent.eventId;
          contractsTerminated += 1;
        }
      }
      const event = ctx.emit("employment.terminated", {
        terminationId,
        employmentContractId: employment.id,
        legalContractId: employment.legal_contract_id,
        employerId: companyId,
        employeeAgentId: employment.employee_agent_id,
        reason: "company_failure",
        initiatedTick: ctx.tick,
        effectiveTick: ctx.tick,
        noticeTicks: 0,
      }, { correlationId, causationId: employmentCause });
      eventIds.push(event.eventId);
    }

    const jobs = this.db.prepare<[string, string], { id: string }>(`
      SELECT id FROM jobs
      WHERE run_id = ? AND employer_id = ? AND status = 'open'
      ORDER BY id
    `).all(this.runId, companyId);
    let applicationsDeclined = 0;
    for (const job of jobs) {
      const applications = this.db.prepare<[string, string], { id: string }>(`
        SELECT id FROM job_applications
        WHERE run_id = ? AND job_id = ? AND status = 'submitted'
        ORDER BY id
      `).all(this.runId, job.id);
      this.db.prepare(`
        UPDATE job_applications SET status = 'declined', decided_tick = ?
        WHERE run_id = ? AND job_id = ? AND status = 'submitted'
      `).run(ctx.tick, this.runId, job.id);
      applicationsDeclined += applications.length;
      this.db.prepare(`
        UPDATE jobs SET status = 'withdrawn'
        WHERE run_id = ? AND id = ? AND status = 'open'
      `).run(this.runId, job.id);
      const event = ctx.emit("job.withdrawn", {
        jobId: job.id,
        employerId: companyId,
        reason: "company_failure",
        declinedApplicationIds: applications.map((application) => application.id),
      }, { correlationId, causationId });
      eventIds.push(event.eventId);
    }

    const remainingContractIds = this.db.prepare<[string, string, string], { id: string }>(`
      SELECT c.id
      FROM legal_contracts c
      WHERE c.run_id = ? AND c.status = 'active' AND (
        EXISTS (
          SELECT 1 FROM legal_contract_parties p
          WHERE p.run_id = c.run_id AND p.contract_id = c.id
            AND p.party_kind = 'company' AND p.party_id = ?
        )
        OR c.id = (
          SELECT incorporation_contract_id FROM companies
          WHERE run_id = c.run_id AND id = ?
        )
      )
      ORDER BY c.id
    `).all(this.runId, companyId, companyId);
    for (const row of remainingContractIds) {
      const contract = this.getLegalContract(row.id);
      const waived = legalContractSchema.parse({
        ...contract,
        obligations: contract.obligations.map((obligation) => (
          ["pending", "fired"].includes(obligation.status)
            ? { ...obligation, status: "waived" as const }
            : obligation
        )),
      });
      const terminated = transitionLegalContract(waived, "terminated", ctx.tick);
      this.saveLegalContract(terminated);
      this.appendContractTimeline(ctx.ids, contract.id, ctx.tick, "contract.terminated", {
        reason: "company_failure",
      });
      const event = ctx.emit("contract.terminated", {
        contractId: contract.id,
        companyId,
        reason: "company_failure",
      }, { correlationId, causationId });
      eventIds.push(event.eventId);
      contractsTerminated += 1;
    }

    return Object.freeze({
      employeesTerminated: employments.length,
      contractsTerminated,
      jobsWithdrawn: jobs.length,
      applicationsDeclined,
      eventIds: Object.freeze(eventIds),
    });
  }

  processLegalObligations(ctx: TickContext): void {
    const signedIds = this.db.prepare<[string, number], { id: string }>(`
      SELECT id FROM legal_contracts
      WHERE run_id = ? AND status = 'signed' AND effective_tick <= ? ORDER BY id
    `).all(this.runId, ctx.tick).map((row) => row.id);
    for (const contractId of signedIds) {
      const active = transitionLegalContract(this.getLegalContract(contractId), "active", ctx.tick);
      this.saveLegalContract(active);
      this.appendContractTimeline(ctx.ids, contractId, ctx.tick, "contract.activated", {});
      ctx.emit("contract.activated", { contractId, type: active.type, effectiveTick: active.effectiveTick });
    }

    const activeIds = this.db.prepare<[string], { id: string }>(`
      SELECT id FROM legal_contracts WHERE run_id = ? AND status = 'active' ORDER BY id
    `).all(this.runId).map((row) => row.id);
    for (const contractId of activeIds) {
      let contract = this.getLegalContract(contractId);
      for (const obligation of dueLegalObligations(contract, ctx.tick)) {
        contract = fireLegalObligation(contract, obligation.id, ctx.tick);
        this.saveLegalContract(contract);
        this.db.prepare(`
          INSERT INTO legal_obligation_executions (
            run_id, id, obligation_id, contract_id, tick
          ) VALUES (?, ?, ?, ?, ?)
        `).run(this.runId, ctx.ids.next("obx"), obligation.id, contractId, ctx.tick);
        this.appendContractTimeline(ctx.ids, contractId, ctx.tick, "contract.obligation.fired", {
          obligationId: obligation.id,
          kind: obligation.kind,
          params: obligation.params,
        });
        ctx.emit("contract.obligation.fired", {
          contractId,
          obligationId: obligation.id,
          kind: obligation.kind,
          params: obligation.params,
        });
      }
      const overdue = overdueObligationIds(contract, ctx.tick);
      if (overdue.length === 0) continue;
      const breachId = ctx.ids.next("brc");
      this.db.prepare(`
        INSERT INTO legal_contract_breaches (
          run_id, id, contract_id, predicate, tick, details_canonical
        ) VALUES (?, ?, ?, 'overdue_obligation', ?, ?)
      `).run(this.runId, breachId, contractId, ctx.tick, canonicalStringify({ obligationIds: overdue }));
      contract = transitionLegalContract(contract, "breached", ctx.tick);
      this.saveLegalContract(contract);
      this.appendContractTimeline(ctx.ids, contractId, ctx.tick, "contract.breached", {
        breachId,
        predicate: "overdue_obligation",
        obligationIds: overdue,
      });
      ctx.emit("contract.breached", {
        contractId,
        breachId,
        predicate: "overdue_obligation",
        obligationIds: overdue,
      });
    }

    this.processEmploymentTerminations(ctx);
  }

  processCompanyFormations(ctx: TickContext): void {
    const companyIds = this.db.prepare<[string], { id: string }>(`
      SELECT id FROM companies
      WHERE run_id = ? AND status IN ('forming', 'registered') ORDER BY id
    `).all(this.runId).map((row) => row.id);
    for (const companyId of companyIds) {
      const row = this.getCompanyRow(companyId);
      switch (row.formation_stage) {
        case "agreement_drafted": {
          const contract = this.getLegalContract(row.incorporation_contract_id);
          if (contract.status !== "active") break;
          const founderAccount = this.finance.accountForAgent(row.founder_agent_id);
          const correlationId = `formation:${companyId}`;
          const source = ctx.emit("company.incorporation_fee.requested", {
            companyId,
            founderAgentId: row.founder_agent_id,
            lawFirmAccountId: row.law_firm_account_id,
            amountCents: row.incorporation_fee_cents,
          }, { correlationId });
          const transaction = ledgerTransactionSchema.parse({
            id: ctx.ids.next("txn"),
            runId: this.runId,
            tick: ctx.tick,
            kind: "fee",
            actor: { kind: "agent", id: row.founder_agent_id },
            reason: "company.incorporation.fee",
            sourceEventId: source.eventId,
            correlationId,
            idempotencyKey: `formation-fee:${companyId}`,
            legs: [
              { accountId: founderAccount.id, direction: "credit", amountCents: row.incorporation_fee_cents },
              { accountId: row.law_firm_account_id, direction: "debit", amountCents: row.incorporation_fee_cents },
            ],
          });
          this.finance.post(transaction);
          ctx.count("transactions");
          const feeObligation = contract.obligations.find((obligation) => (
            obligation.status === "fired" && obligation.params["purpose"] === "incorporation_fee"
          ));
          if (feeObligation !== undefined) {
            this.saveLegalContract(completeLegalObligation(contract, feeObligation.id, ctx.tick));
          }
          this.updateCompanyStage(companyId, "forming", "fee_paid", {});
          this.appendCompanyTimeline(ctx.ids, companyId, ctx.tick, "company.incorporation_fee.paid", {
            transactionId: transaction.id,
            amountCents: row.incorporation_fee_cents,
          });
          ctx.emit("transaction.posted", {
            transactionId: transaction.id,
            kind: transaction.kind,
            legs: transaction.legs,
            reason: transaction.reason,
            sourceEventId: transaction.sourceEventId,
            correlationId: transaction.correlationId,
          }, { correlationId, causationId: source.eventId });
          ctx.emit("company.incorporation_fee.paid", {
            companyId,
            transactionId: transaction.id,
            amountCents: row.incorporation_fee_cents,
          }, { correlationId, causationId: source.eventId });
          break;
        }
        case "fee_paid":
          this.updateCompanyStage(companyId, "registered", "registered", { registeredTick: ctx.tick });
          this.appendCompanyTimeline(ctx.ids, companyId, ctx.tick, "company.registered", {
            incorporationContractId: row.incorporation_contract_id,
          });
          ctx.emit("company.registered", {
            companyId,
            incorporationContractId: row.incorporation_contract_id,
          });
          break;
        case "registered": {
          const founderAccount = this.finance.accountForAgent(row.founder_agent_id);
          const account = this.finance.openAccount({
            id: ctx.ids.next("acct"),
            bankId: founderAccount.bankId,
            ownerKind: "company",
            ownerId: companyId,
            type: "checking",
            floorCents: "0",
            openedTick: ctx.tick,
            actor: SYSTEM_ACTOR,
          });
          this.updateCompanyStage(companyId, "registered", "account_opened", {
            businessAccountId: account.id,
          });
          this.appendCompanyTimeline(ctx.ids, companyId, ctx.tick, "company.account.opened", {
            accountId: account.id,
            bankId: account.bankId,
          });
          ctx.emit("account.opened", {
            accountId: account.id,
            bankId: account.bankId,
            ownerKind: "company",
            ownerId: companyId,
            type: account.type,
            balanceCents: account.balanceCents,
            floorCents: account.floorCents,
          });
          break;
        }
        case "account_opened": {
          if (row.business_account_id === null) {
            throw new EngineError("CONFLICT", `company ${companyId} is missing its opened account`);
          }
          const founderAccount = this.finance.accountForAgent(row.founder_agent_id);
          const correlationId = `formation:${companyId}`;
          const source = ctx.emit("company.capital.deposit.requested", {
            companyId,
            founderAgentId: row.founder_agent_id,
            businessAccountId: row.business_account_id,
            amountCents: row.founding_capital_cents,
          }, { correlationId });
          const transaction = ledgerTransactionSchema.parse({
            id: ctx.ids.next("txn"),
            runId: this.runId,
            tick: ctx.tick,
            kind: "transfer",
            actor: { kind: "agent", id: row.founder_agent_id },
            reason: "company.founding_capital",
            sourceEventId: source.eventId,
            correlationId,
            idempotencyKey: `formation-capital:${companyId}`,
            legs: [
              { accountId: founderAccount.id, direction: "credit", amountCents: row.founding_capital_cents },
              { accountId: row.business_account_id, direction: "debit", amountCents: row.founding_capital_cents },
            ],
          });
          this.finance.post(transaction);
          ctx.count("transactions");
          this.updateCompanyStage(companyId, "registered", "capitalized", {});
          this.appendCompanyTimeline(ctx.ids, companyId, ctx.tick, "company.capital.deposited", {
            transactionId: transaction.id,
            amountCents: row.founding_capital_cents,
          });
          ctx.emit("transaction.posted", {
            transactionId: transaction.id,
            kind: transaction.kind,
            legs: transaction.legs,
            reason: transaction.reason,
            sourceEventId: transaction.sourceEventId,
            correlationId: transaction.correlationId,
          }, { correlationId, causationId: source.eventId });
          ctx.emit("company.capital.deposited", {
            companyId,
            transactionId: transaction.id,
            amountCents: row.founding_capital_cents,
          }, { correlationId, causationId: source.eventId });
          break;
        }
        case "capitalized": {
          const equityEvent = ctx.emit("company.equity.issued", {
            companyId,
            ownerAgentId: row.founder_agent_id,
            shares: row.total_shares,
          });
          const ownershipStakeId = ctx.ids.next("stk");
          this.db.prepare(`
            INSERT INTO company_cap_tables(
              run_id, company_id, company_kind, total_shares, revision, last_event_id
            ) VALUES (?, ?, 'dynamic', ?, 0, ?)
          `).run(this.runId, companyId, row.total_shares, equityEvent.eventId);
          this.db.prepare(`
            INSERT INTO company_equity_stakes (
              run_id, company_id, owner_agent_id, shares, issued_tick
            ) VALUES (?, ?, ?, ?, ?)
          `).run(this.runId, companyId, row.founder_agent_id, row.total_shares, ctx.tick);
          this.db.prepare(`
            INSERT INTO ownership_stakes(
              run_id, id, company_id, holder_kind, holder_id, shares,
              acquired_via, since_tick, source_event_id
            ) VALUES (?, ?, ?, 'agent', ?, ?, 'founding', ?, ?)
          `).run(
            this.runId,
            ownershipStakeId,
            companyId,
            row.founder_agent_id,
            row.total_shares,
            ctx.tick,
            equityEvent.eventId,
          );
          this.updateCompanyStage(companyId, "active", "active", { activatedTick: ctx.tick });
          this.appendCompanyTimeline(ctx.ids, companyId, ctx.tick, "company.activated", {
            founderAgentId: row.founder_agent_id,
            shares: row.total_shares,
          });
          ctx.emit("company.activated", { companyId, activatedTick: ctx.tick });
          break;
        }
        case "active":
          break;
      }
    }
  }

  private rankedApplicationsForJob(
    job: Job,
  ): readonly { readonly application: JobApplication; readonly score: number }[] {
    const applications = this.listJobApplications(job.id)
      .filter((application) => application.status === "submitted");
    const candidates = applications.map((application) => {
      const agent = this.db.prepare<[string, string], {
        employment_status: string;
        skills_canonical: string;
      }>(`
        SELECT a.employment_status, p.skills_canonical
        FROM agents a JOIN personas p ON p.run_id = a.run_id AND p.agent_id = a.id
        WHERE a.run_id = ? AND a.id = ?
      `).get(this.runId, application.agentId);
      if (agent === undefined) {
        throw new EngineError("NOT_FOUND", `agent ${application.agentId} does not exist`);
      }
      const skills = parsedRecord(agent.skills_canonical, `agent ${application.agentId} skills`);
      const numericSkills = Object.fromEntries(
        Object.entries(skills).map(([key, value]) => [
          key,
          typeof value === "number" ? value : 0,
        ]),
      );
      return {
        agentId: application.agentId,
        skills: numericSkills,
        reservationWageCents: application.reservationWageCents,
        employmentStatus: agent.employment_status,
      };
    });
    const byAgent = new Map(applications.map((application) => [application.agentId, application]));
    return Object.freeze(rankLaborCandidates(job, candidates).map((candidate) => ({
      application: byAgent.get(candidate.agentId)!,
      score: candidate.score,
    })));
  }

  private hireApplication(
    application: JobApplication,
    score: number,
    ctx: TickContext,
    evidence?: HiringEvidence,
  ): {
    readonly job: Job;
    readonly employmentContractId: string;
    readonly legalContractId: string;
    readonly eventIds: readonly string[];
  } {
    if (application.status !== "submitted") {
      throw new EngineError("CONFLICT", `application ${application.id} is not submitted`);
    }
    const job = this.getJob(application.jobId);
    if (job.status !== "open" || job.filledCount >= job.openings) {
      throw new EngineError("CONFLICT", `job ${job.id} has no open vacancy`);
    }
    const company = this.assertCompanyCanOperate(job.employerId, "hire");
    if (company.businessAccountId === null) {
      throw new EngineError("CONFLICT", `company ${company.id} lacks a business account`);
    }
    const annualWageCents = evidence?.annualWageCents ?? job.annualWageCents;
    let legal = createContractFromTemplate({
      id: ctx.ids.next("ctr"),
      runId: this.runId,
      type: "employment",
      parties: [
        { kind: "company", id: company.id, role: "employer" },
        { kind: "agent", id: application.agentId, role: "employee" },
      ],
      terms: {
        template: "employment",
        jobId: job.id,
        employerId: company.id,
        employeeAgentId: application.agentId,
        annualWageCents,
        startTick: ctx.tick,
        noticeDays: 14,
      },
      draftedBy: SYSTEM_ACTOR,
      createdTick: ctx.tick,
      effectiveTick: ctx.tick,
      ids: ctx.ids,
    });
    legal = signLegalContract(legal, { kind: "company", id: company.id }, ctx.tick);
    legal = signLegalContract(legal, { kind: "agent", id: application.agentId }, ctx.tick);
    legal = transitionLegalContract(legal, "active", ctx.tick);
    this.insertLegalContract(legal);
    this.appendContractTimeline(ctx.ids, legal.id, ctx.tick, "contract.drafted", {
      type: "employment",
    });
    this.appendContractTimeline(ctx.ids, legal.id, ctx.tick, "contract.signed", {});
    this.appendContractTimeline(ctx.ids, legal.id, ctx.tick, "contract.activated", {});
    const employmentId = ctx.ids.next("emp");
    this.db.prepare(`
      INSERT INTO employment_contracts (
        run_id, id, employer_id, employer_account_id, employee_agent_id,
        annual_wage_cents, start_tick, end_tick, notice_days, status,
        legal_contract_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 14, 'active', ?)
    `).run(
      this.runId,
      employmentId,
      company.id,
      company.businessAccountId,
      application.agentId,
      annualWageCents,
      ctx.tick,
      legal.id,
    );
    this.db.prepare(`
      UPDATE agents SET employment_status = 'employed', organization_id = ?,
        annual_income_cents = ?
      WHERE run_id = ? AND id = ?
    `).run(company.id, annualWageCents, this.runId, application.agentId);
    this.decideApplication(application.id, "selected", score, ctx.tick);
    const nextFilled = job.filledCount + 1;
    const nextStatus = nextFilled === job.openings ? "filled" as const : "open" as const;
    this.db.prepare(`
      UPDATE jobs SET filled_count = ?, status = ? WHERE run_id = ? AND id = ?
    `).run(nextFilled, nextStatus, this.runId, job.id);
    const eventOptions = evidence === undefined
      ? undefined
      : {
          correlationId: evidence.correlationId,
          causationId: evidence.causationId,
        };
    const drafted = ctx.emit(
      "contract.drafted",
      { contractId: legal.id, type: legal.type },
      eventOptions,
    );
    const signed = ctx.emit(
      "contract.signed",
      { contractId: legal.id, partyCount: legal.parties.length },
      eventOptions,
    );
    const activated = ctx.emit(
      "contract.activated",
      { contractId: legal.id, type: legal.type, effectiveTick: ctx.tick },
      eventOptions,
    );
    const employment = ctx.emit("employment.created", {
      employmentContractId: employmentId,
      legalContractId: legal.id,
      jobId: job.id,
      employerId: company.id,
      employeeAgentId: application.agentId,
      annualWageCents,
      startTick: ctx.tick,
      noticeDays: 14,
      score,
      founderDecisionId: evidence?.founderDecisionId ?? null,
      applicantDecisionId: evidence?.applicantDecisionId ?? null,
      conversationId: evidence?.conversationId ?? null,
      negotiationBindingId: evidence?.bindingId ?? null,
    }, eventOptions);
    const eventIds = [drafted.eventId, signed.eventId, activated.eventId, employment.eventId];
    const updatedJob: Job = { ...job, filledCount: nextFilled, status: nextStatus };
    if (nextStatus === "filled") {
      this.declineRemainingApplications(job.id, ctx.tick, ctx, "position_filled");
      const filled = ctx.emit(
        "job.filled",
        { jobId: job.id, employerId: job.employerId, filledCount: nextFilled },
        eventOptions,
      );
      eventIds.push(filled.eventId);
    }
    return Object.freeze({
      job: updatedJob,
      employmentContractId: employmentId,
      legalContractId: legal.id,
      eventIds: Object.freeze(eventIds),
    });
  }

  processLaborMatching(ctx: TickContext): void {
    const openJobIds = this.db.prepare<[string], { id: string }>(`
      SELECT j.id FROM jobs j
      JOIN companies c ON c.run_id = j.run_id AND c.id = j.employer_id
      WHERE j.run_id = ? AND j.status = 'open' AND c.status = 'active'
      ORDER BY j.posted_tick, j.id
    `).all(this.runId).map((row) => row.id);
    for (const jobId of openJobIds) {
      let job = this.getJob(jobId);
      if (job.expiresTick !== null && job.expiresTick < ctx.tick) {
        this.db.prepare(`UPDATE jobs SET status = 'expired' WHERE run_id = ? AND id = ?`)
          .run(this.runId, jobId);
        this.declineRemainingApplications(jobId, ctx.tick, ctx, "expired");
        ctx.emit("job.expired", { jobId, employerId: job.employerId });
        continue;
      }
      const applications = this.listJobApplications(jobId)
        .filter((application) => application.status === "submitted");
      const ranked = this.rankedApplicationsForJob(job);
      const rankedIds = new Set(ranked.map((candidate) => candidate.application.agentId));
      for (const application of applications.filter((candidate) => !rankedIds.has(candidate.agentId))) {
        this.decideApplication(application.id, "declined", null, ctx.tick);
        ctx.emit("job.application.declined", {
          jobId,
          applicationId: application.id,
          agentId: application.agentId,
          reason: "tier1_ineligible",
        });
      }
      const vacancies = job.openings - job.filledCount;
      for (const selected of ranked.slice(0, vacancies)) {
        job = this.hireApplication(selected.application, selected.score, ctx).job;
        if (job.status === "filled") break;
      }
    }
  }

  private processEmploymentTerminations(ctx: TickContext): void {
    const due = this.db.prepare<[string, number], TerminationRow>(`
      SELECT id, employment_contract_id, initiated_by_kind, initiated_by_id,
        reason, initiated_tick, effective_tick, status
      FROM employment_terminations
      WHERE run_id = ? AND status = 'pending' AND effective_tick <= ?
      ORDER BY effective_tick, id
    `).all(this.runId, ctx.tick);
    for (const termination of due) {
      const employment = this.getEmployment(termination.employment_contract_id);
      this.db.prepare(`
        UPDATE employment_contracts SET status = 'ended', end_tick = ?
        WHERE run_id = ? AND id = ? AND status = 'active'
      `).run(ctx.tick, this.runId, employment.id);
      this.db.prepare(`
        UPDATE employment_terminations SET status = 'effective'
        WHERE run_id = ? AND id = ?
      `).run(this.runId, termination.id);
      this.db.prepare(`
        UPDATE agents SET employment_status = 'unemployed', organization_id = NULL,
          annual_income_cents = '0'
        WHERE run_id = ? AND id = ?
      `).run(this.runId, employment.employee_agent_id);
      if (employment.legal_contract_id !== null) {
        const contract = this.getLegalContract(employment.legal_contract_id);
        if (contract.status === "active") {
          const terminated = transitionLegalContract(contract, "terminated", ctx.tick);
          this.saveLegalContract(terminated);
          this.appendContractTimeline(ctx.ids, contract.id, ctx.tick, "contract.terminated", {
            reason: termination.reason,
          });
        }
      }
      ctx.emit("employment.terminated", {
        employmentContractId: employment.id,
        legalContractId: employment.legal_contract_id,
        employerId: employment.employer_id,
        employeeAgentId: employment.employee_agent_id,
        reason: termination.reason,
        initiatedTick: toSafeNumber(termination.initiated_tick, "termination initiated tick"),
        effectiveTick: ctx.tick,
      });
    }
  }

  private declineRemainingApplications(
    jobId: string,
    tick: number,
    ctx: TickContext,
    reason: string,
  ): void {
    const remaining = this.listJobApplications(jobId)
      .filter((application) => application.status === "submitted");
    for (const application of remaining) {
      this.decideApplication(application.id, "declined", application.score, tick);
      ctx.emit("job.application.declined", {
        jobId,
        applicationId: application.id,
        agentId: application.agentId,
        reason,
      });
    }
  }

  private decideApplication(
    applicationId: string,
    status: "selected" | "declined",
    score: number | null,
    tick: number,
  ): void {
    this.db.prepare(`
      UPDATE job_applications SET status = ?, score = ?, decided_tick = ?
      WHERE run_id = ? AND id = ? AND status = 'submitted'
    `).run(status, score, tick, this.runId, applicationId);
  }

  private getEmployment(employmentId: string): EmploymentRow {
    const row = this.db.prepare<[string, string], EmploymentRow>(`
      SELECT id, employer_id, employer_account_id, employee_agent_id,
        annual_wage_cents, start_tick, end_tick, notice_days, status, legal_contract_id
      FROM employment_contracts WHERE run_id = ? AND id = ?
    `).get(this.runId, employmentId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `employment ${employmentId} does not exist`);
    return row;
  }

  private saveLegalContract(contract: LegalContract): void {
    const validated = legalContractSchema.parse(contract);
    this.db.prepare(`
      UPDATE legal_contracts SET status = ?, terminal_tick = ?
      WHERE run_id = ? AND id = ?
    `).run(validated.status, validated.terminalTick, this.runId, validated.id);
    validated.parties.forEach((party, index) => {
      this.db.prepare(`
        UPDATE legal_contract_parties SET signed_tick = ?
        WHERE run_id = ? AND contract_id = ? AND party_index = ?
      `).run(party.signedTick, this.runId, validated.id, index);
    });
    for (const obligation of validated.obligations) {
      this.db.prepare(`
        UPDATE legal_obligations
        SET due_tick = ?, status = ?, fired_tick = ?, completed_tick = ?
        WHERE run_id = ? AND id = ?
      `).run(
        obligation.dueTick,
        obligation.status,
        obligation.firedTick,
        obligation.completedTick,
        this.runId,
        obligation.id,
      );
    }
  }

  private appendContractTimeline(
    ids: IdFactory,
    contractId: string,
    tick: number,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    this.db.prepare(`
      INSERT INTO legal_contract_timeline (
        run_id, id, contract_id, tick, event_type, payload_canonical
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(this.runId, ids.next("lct"), contractId, tick, eventType, canonicalStringify(payload));
  }

  private appendCompanyTimeline(
    ids: IdFactory,
    companyId: string,
    tick: number,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    this.db.prepare(`
      INSERT INTO company_timeline (
        run_id, id, company_id, tick, event_type, payload_canonical
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(this.runId, ids.next("ctl"), companyId, tick, eventType, canonicalStringify(payload));
  }

  private getCompanyRow(companyId: string): CompanyRow {
    const row = this.db.prepare<[string, string], CompanyRow>(`
      SELECT id, name, sector, founder_agent_id, status, formation_stage,
        incorporation_contract_id, business_account_id, law_firm_account_id,
        incorporation_fee_cents, founding_capital_cents, total_shares,
        founded_tick, registered_tick, activated_tick, failure_reason
      FROM companies WHERE run_id = ? AND id = ?
    `).get(this.runId, companyId);
    if (row === undefined) throw new EngineError("NOT_FOUND", `company ${companyId} does not exist`);
    return row;
  }

  private companyFromRow(row: CompanyRow): Company {
    return companySchema.parse({
      id: row.id,
      runId: this.runId,
      name: row.name,
      sector: row.sector,
      founderAgentId: row.founder_agent_id,
      status: row.status,
      formationStage: row.formation_stage,
      incorporationContractId: row.incorporation_contract_id,
      businessAccountId: row.business_account_id,
      foundingCapitalCents: row.founding_capital_cents,
      totalShares: row.total_shares,
      foundedTick: toSafeNumber(row.founded_tick, "company founded tick"),
      registeredTick: row.registered_tick === null
        ? null
        : toSafeNumber(row.registered_tick, "company registered tick"),
      activatedTick: row.activated_tick === null
        ? null
        : toSafeNumber(row.activated_tick, "company activated tick"),
      failureReason: row.failure_reason,
    });
  }

  private updateCompanyStage(
    companyId: string,
    status: Company["status"],
    stage: Company["formationStage"],
    changes: {
      readonly businessAccountId?: string;
      readonly registeredTick?: number;
      readonly activatedTick?: number;
    },
  ): void {
    this.db.prepare(`
      UPDATE companies SET status = ?, formation_stage = ?,
        business_account_id = COALESCE(?, business_account_id),
        registered_tick = COALESCE(?, registered_tick),
        activated_tick = COALESCE(?, activated_tick)
      WHERE run_id = ? AND id = ?
    `).run(
      status,
      stage,
      changes.businessAccountId ?? null,
      changes.registeredTick ?? null,
      changes.activatedTick ?? null,
      this.runId,
      companyId,
    );
  }

  private jobFromRow(row: JobRow): Job {
    return jobSchema.parse({
      id: row.id,
      runId: this.runId,
      employerId: row.employer_id,
      occupationCode: row.occupation_code,
      title: row.title,
      annualWageCents: row.annual_wage_cents,
      requirements: canonicalParse(row.requirements_canonical),
      openings: toSafeNumber(row.openings, "job openings"),
      filledCount: toSafeNumber(row.filled_count, "job filled count"),
      status: row.status,
      postedTick: toSafeNumber(row.posted_tick, "job posted tick"),
      expiresTick: row.expires_tick === null
        ? null
        : toSafeNumber(row.expires_tick, "job expiry tick"),
      payrollRisk: row.payroll_risk === 1n,
    });
  }

  private applicationFromRow(row: ApplicationRow): JobApplication {
    return jobApplicationSchema.parse({
      id: row.id,
      runId: this.runId,
      jobId: row.job_id,
      agentId: row.agent_id,
      reservationWageCents: row.reservation_wage_cents,
      status: row.status,
      score: row.score === null ? null : toSafeNumber(row.score, "job application score"),
      submittedTick: toSafeNumber(row.submitted_tick, "job application submitted tick"),
      decidedTick: row.decided_tick === null
        ? null
        : toSafeNumber(row.decided_tick, "job application decided tick"),
    });
  }
}
