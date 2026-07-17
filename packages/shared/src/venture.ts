/** Authoritative M10 contracts for venture firms, funds, and deployed capital. */

import { z } from "zod";
import { companyIdSchema } from "./legal";
import { runIdSchema } from "./simulation";

const signedSqliteMaximum = "9223372036854775807";
const withinSignedSqliteRange = (value: string): boolean => (
  value.length < signedSqliteMaximum.length ||
  (value.length === signedSqliteMaximum.length && value <= signedSqliteMaximum)
);
const positiveCentsSchema = z.string().regex(/^[1-9]\d*$/).refine(withinSignedSqliteRange, {
  message: "integer cents exceed the authoritative SQLite range",
});
const nonnegativeCentsSchema = z.string().regex(/^(0|[1-9]\d*)$/).refine(withinSignedSqliteRange, {
  message: "integer cents exceed the authoritative SQLite range",
});
const eventIdSchema = z.string().regex(/^evt_[0-9a-z]{8,}$/);

export const ventureCapitalFirmIdSchema = z.string().regex(/^inst_[0-9a-z_]{3,}$/);
export const ventureFundIdSchema = z.string().regex(/^vfund_[0-9a-z]{8,}$/);
export const ventureFundDeploymentIdSchema = z.string().regex(/^vdep_[0-9a-z]{8,}$/);
export const ventureTargetCompanyIdSchema = z.union([
  companyIdSchema,
  z.string().regex(/^biz_[0-9a-z_]{3,}$/),
]);
export const ventureCapitalFirmStatusSchema = z.enum(["active", "closed"]);
export const ventureFundStatusSchema = z.enum(["open", "fully_deployed", "closed"]);

export const ventureCapitalFirmSchema = z.object({
  id: ventureCapitalFirmIdSchema,
  runId: runIdSchema,
  name: z.string().trim().min(2).max(120),
  status: ventureCapitalFirmStatusSchema,
  createdTick: z.number().int().nonnegative().safe(),
  sourceEventId: eventIdSchema,
}).strict();
export type VentureCapitalFirm = z.infer<typeof ventureCapitalFirmSchema>;

export const ventureFundSchema = z.object({
  id: ventureFundIdSchema,
  runId: runIdSchema,
  firmId: ventureCapitalFirmIdSchema,
  name: z.string().trim().min(2).max(120),
  fundSizeCents: positiveCentsSchema,
  deployedCents: nonnegativeCentsSchema,
  status: ventureFundStatusSchema,
  createdTick: z.number().int().nonnegative().safe(),
  sourceEventId: eventIdSchema,
}).strict().superRefine((fund, ctx) => {
  const fundSize = BigInt(fund.fundSizeCents);
  const deployed = BigInt(fund.deployedCents);
  if (deployed > fundSize) {
    ctx.addIssue({
      code: "custom",
      path: ["deployedCents"],
      message: "deployedCents cannot exceed fundSizeCents",
    });
  }
  if (fund.status === "fully_deployed" && deployed !== fundSize) {
    ctx.addIssue({
      code: "custom",
      path: ["status"],
      message: "fully_deployed requires the entire fund to be deployed",
    });
  }
  if (fund.status === "open" && deployed === fundSize) {
    ctx.addIssue({
      code: "custom",
      path: ["status"],
      message: "an open fund must retain undeployed capital",
    });
  }
});
export type VentureFund = z.infer<typeof ventureFundSchema>;

export const ventureFundDeploymentSchema = z.object({
  id: ventureFundDeploymentIdSchema,
  runId: runIdSchema,
  fundId: ventureFundIdSchema,
  targetCompanyId: ventureTargetCompanyIdSchema,
  referenceId: z.string().trim().min(1).max(160),
  amountCents: positiveCentsSchema,
  deployedBeforeCents: nonnegativeCentsSchema,
  deployedAfterCents: positiveCentsSchema,
  deployedTick: z.number().int().nonnegative().safe(),
  sourceEventId: eventIdSchema,
}).strict().superRefine((deployment, ctx) => {
  if (
    BigInt(deployment.deployedBeforeCents) + BigInt(deployment.amountCents) !==
    BigInt(deployment.deployedAfterCents)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["deployedAfterCents"],
      message: "deployedAfterCents must equal deployedBeforeCents plus amountCents",
    });
  }
});
export type VentureFundDeployment = z.infer<typeof ventureFundDeploymentSchema>;

export const ventureFirmCreatedPayloadSchema = z.object({
  firmId: ventureCapitalFirmIdSchema,
  name: ventureCapitalFirmSchema.shape.name,
  status: ventureCapitalFirmStatusSchema,
  evidence: z.array(z.string().trim().min(1).max(160)).max(20),
}).strict();

export const ventureFundCreatedPayloadSchema = z.object({
  fundId: ventureFundIdSchema,
  firmId: ventureCapitalFirmIdSchema,
  name: ventureFundSchema.shape.name,
  fundSizeCents: positiveCentsSchema,
  evidence: z.array(z.string().trim().min(1).max(160)).max(20),
}).strict();

export const ventureFundDeployedPayloadSchema = z.object({
  deploymentId: ventureFundDeploymentIdSchema,
  fundId: ventureFundIdSchema,
  targetCompanyId: ventureTargetCompanyIdSchema,
  referenceId: z.string().trim().min(1).max(160),
  amountCents: positiveCentsSchema,
  deployedBeforeCents: nonnegativeCentsSchema,
  deployedAfterCents: positiveCentsSchema,
  remainingCents: nonnegativeCentsSchema,
  evidence: z.array(z.string().trim().min(1).max(160)).max(20),
}).strict();

export type VentureFirmCreatedPayload = z.infer<typeof ventureFirmCreatedPayloadSchema>;
export type VentureFundCreatedPayload = z.infer<typeof ventureFundCreatedPayloadSchema>;
export type VentureFundDeployedPayload = z.infer<typeof ventureFundDeployedPayloadSchema>;
