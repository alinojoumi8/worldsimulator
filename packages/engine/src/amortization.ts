import {
  EngineError,
  canonicalStringify,
  money,
  mulDiv,
  sha256Hex,
} from "@worldtangle/shared";

export interface AmortizationScheduleInput {
  readonly principalCents: string;
  readonly annualRateBp: number;
  readonly termMonths: number;
  readonly disbursedTick: number;
}

export interface AmortizationScheduleRow {
  readonly installmentNumber: number;
  readonly dueTick: number;
  readonly openingPrincipalCents: string;
  readonly principalDueCents: string;
  readonly interestDueCents: string;
  readonly totalDueCents: string;
}

const THIRTY_360_INTEREST_DENOMINATOR = 10_000n * 360n;

/** Monthly 30/360 interest with the canonical HALF_EVEN cents rule. */
export function interestForThirtyDayPeriod(
  openingPrincipalCents: string,
  annualRateBp: number,
): bigint {
  if (!/^\d+$/.test(openingPrincipalCents)) {
    throw new EngineError("VALIDATION_FAILED", "opening principal must be nonnegative cents");
  }
  if (!Number.isSafeInteger(annualRateBp) || annualRateBp < 0 || annualRateBp > 100_000) {
    throw new EngineError("VALIDATION_FAILED", "annual rate must be in 0..100000 bp");
  }
  return mulDiv(
    money(openingPrincipalCents),
    BigInt(annualRateBp) * 30n,
    THIRTY_360_INTEREST_DENOMINATOR,
    "HALF_EVEN",
  );
}

/**
 * Equal-principal 30/360 schedule. Rows 1..N-1 use floor(principal/N);
 * the final row absorbs every residual cent. Interest is rounded per row.
 */
export function generateAmortizationSchedule(
  input: AmortizationScheduleInput,
): readonly AmortizationScheduleRow[] {
  if (!/^[1-9]\d*$/.test(input.principalCents)) {
    throw new EngineError("VALIDATION_FAILED", "loan principal must be positive cents");
  }
  if (!Number.isSafeInteger(input.termMonths) ||
    input.termMonths < 1 || input.termMonths > 360) {
    throw new EngineError("VALIDATION_FAILED", "loan term must be in 1..360 months");
  }
  if (!Number.isSafeInteger(input.disbursedTick) || input.disbursedTick < 0) {
    throw new EngineError("VALIDATION_FAILED", "disbursement tick must be nonnegative");
  }
  if (!Number.isSafeInteger(input.annualRateBp) ||
    input.annualRateBp < 0 || input.annualRateBp > 100_000) {
    throw new EngineError("VALIDATION_FAILED", "annual rate must be in 0..100000 bp");
  }
  const principal = BigInt(input.principalCents);
  const regularPrincipal = principal / BigInt(input.termMonths);
  let outstanding = principal;
  const rows: AmortizationScheduleRow[] = [];
  for (let index = 0; index < input.termMonths; index++) {
    const installmentNumber = index + 1;
    const dueTick = input.disbursedTick + installmentNumber * 30;
    if (!Number.isSafeInteger(dueTick)) {
      throw new EngineError("LIMIT_EXCEEDED", "loan maturity tick exceeds safe integer range");
    }
    const openingPrincipal = outstanding;
    const principalDue = installmentNumber === input.termMonths
      ? outstanding
      : regularPrincipal;
    const interestDue = interestForThirtyDayPeriod(
      openingPrincipal.toString(),
      input.annualRateBp,
    );
    outstanding -= principalDue;
    rows.push(Object.freeze({
      installmentNumber,
      dueTick,
      openingPrincipalCents: openingPrincipal.toString(),
      principalDueCents: principalDue.toString(),
      interestDueCents: interestDue.toString(),
      totalDueCents: (principalDue + interestDue).toString(),
    }));
  }
  const principalTotal = rows.reduce(
    (sum, row) => sum + BigInt(row.principalDueCents),
    0n,
  );
  if (outstanding !== 0n || principalTotal !== principal) {
    throw new EngineError("INTERNAL", "amortization schedule does not exhaust principal exactly");
  }
  return Object.freeze(rows);
}

export function amortizationScheduleDigest(
  schedule: readonly AmortizationScheduleRow[],
): string {
  return sha256Hex(canonicalStringify(schedule));
}
