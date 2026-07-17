/** Versioned Riverbend role roster from INITIAL_WORLD sections 2–4. */

import type { EmploymentStatus } from "@worldtangle/shared";

export const RIVERBEND_WORLD_SPEC = "riverbend-100@1";

export type RiverbendSegment = "institution" | "business" | "independent";

export interface RiverbendRoleSlot {
  readonly roleCode: string;
  readonly occupationCode: string;
  readonly employmentStatus: EmploymentStatus;
  readonly organizationId: string | null;
  readonly segment: RiverbendSegment;
  readonly maxAge?: number;
}

function repeatSlot(
  count: number,
  slot: RiverbendRoleSlot,
): RiverbendRoleSlot[] {
  return Array.from({ length: count }, () => Object.freeze({ ...slot }));
}

const institutionSlots: RiverbendRoleSlot[] = [
  ...repeatSlot(1, { roleCode: "bank.branch_manager", occupationCode: "branch_manager", employmentStatus: "employed", organizationId: "inst_first_ledger_bank", segment: "institution" }),
  ...repeatSlot(2, { roleCode: "bank.loan_officer", occupationCode: "loan_officer", employmentStatus: "employed", organizationId: "inst_first_ledger_bank", segment: "institution" }),
  ...repeatSlot(1, { roleCode: "bank.teller", occupationCode: "teller", employmentStatus: "employed", organizationId: "inst_first_ledger_bank", segment: "institution" }),
  ...repeatSlot(2, { roleCode: "vc.partner", occupationCode: "vc_partner", employmentStatus: "employed", organizationId: "inst_foundry_capital", segment: "institution" }),
  ...repeatSlot(1, { roleCode: "vc.analyst", occupationCode: "vc_analyst", employmentStatus: "employed", organizationId: "inst_foundry_capital", segment: "institution" }),
  ...repeatSlot(2, { roleCode: "law.lawyer", occupationCode: "lawyer", employmentStatus: "employed", organizationId: "inst_hale_marrow", segment: "institution" }),
  ...repeatSlot(1, { roleCode: "law.paralegal", occupationCode: "paralegal", employmentStatus: "employed", organizationId: "inst_hale_marrow", segment: "institution" }),
  ...repeatSlot(1, { roleCode: "school.principal", occupationCode: "school_principal", employmentStatus: "employed", organizationId: "inst_riverbend_school", segment: "institution" }),
  ...repeatSlot(4, { roleCode: "school.teacher", occupationCode: "teacher", employmentStatus: "employed", organizationId: "inst_riverbend_school", segment: "institution" }),
  ...repeatSlot(1, { roleCode: "news.editor", occupationCode: "news_editor", employmentStatus: "employed", organizationId: "inst_riverbend_ledger", segment: "institution" }),
  ...repeatSlot(2, { roleCode: "news.journalist", occupationCode: "journalist", employmentStatus: "employed", organizationId: "inst_riverbend_ledger", segment: "institution" }),
  ...repeatSlot(1, { roleCode: "government.mayor", occupationCode: "mayor", employmentStatus: "employed", organizationId: "inst_town_riverbend", segment: "institution" }),
  ...repeatSlot(1, { roleCode: "government.treasurer", occupationCode: "treasurer", employmentStatus: "employed", organizationId: "inst_town_riverbend", segment: "institution" }),
  ...repeatSlot(1, { roleCode: "government.economist", occupationCode: "town_economist", employmentStatus: "employed", organizationId: "inst_town_riverbend", segment: "institution" }),
  ...repeatSlot(2, { roleCode: "government.clerk", occupationCode: "town_clerk", employmentStatus: "employed", organizationId: "inst_town_riverbend", segment: "institution" }),
  ...repeatSlot(1, { roleCode: "government.maintenance", occupationCode: "maintenance_worker", employmentStatus: "employed", organizationId: "inst_town_riverbend", segment: "institution" }),
  ...repeatSlot(1, { roleCode: "exchange.operations_manager", occupationCode: "exchange_operations_manager", employmentStatus: "employed", organizationId: "inst_riverbend_exchange", segment: "institution" }),
  ...repeatSlot(1, { roleCode: "energy.plant_manager", occupationCode: "plant_manager", employmentStatus: "employed", organizationId: "inst_riverbend_power", segment: "institution" }),
  ...repeatSlot(2, { roleCode: "energy.engineer", occupationCode: "engineer", employmentStatus: "employed", organizationId: "inst_riverbend_power", segment: "institution" }),
  ...repeatSlot(2, { roleCode: "energy.technician", occupationCode: "energy_technician", employmentStatus: "employed", organizationId: "inst_riverbend_power", segment: "institution" }),
  ...repeatSlot(2, { roleCode: "clinic.doctor", occupationCode: "doctor", employmentStatus: "employed", organizationId: "inst_riverbend_clinic", segment: "institution" }),
  ...repeatSlot(2, { roleCode: "clinic.nurse", occupationCode: "nurse", employmentStatus: "employed", organizationId: "inst_riverbend_clinic", segment: "institution" }),
  ...repeatSlot(1, { roleCode: "clinic.receptionist", occupationCode: "receptionist", employmentStatus: "employed", organizationId: "inst_riverbend_clinic", segment: "institution" }),
];

const businessSlots: RiverbendRoleSlot[] = [
  ...repeatSlot(1, { roleCode: "ironvale.owner", occupationCode: "business_owner", employmentStatus: "employed", organizationId: "biz_ironvale", segment: "business" }),
  ...repeatSlot(1, { roleCode: "ironvale.operations_manager", occupationCode: "operations_manager", employmentStatus: "employed", organizationId: "biz_ironvale", segment: "business" }),
  ...repeatSlot(2, { roleCode: "ironvale.engineer", occupationCode: "engineer", employmentStatus: "employed", organizationId: "biz_ironvale", segment: "business" }),
  ...repeatSlot(1, { roleCode: "ironvale.accountant", occupationCode: "accountant", employmentStatus: "employed", organizationId: "biz_ironvale", segment: "business" }),
  ...repeatSlot(8, { roleCode: "ironvale.factory_worker", occupationCode: "factory_worker", employmentStatus: "employed", organizationId: "biz_ironvale", segment: "business" }),
  ...repeatSlot(1, { roleCode: "hearthside.owner", occupationCode: "business_owner", employmentStatus: "employed", organizationId: "biz_hearthside", segment: "business" }),
  ...repeatSlot(4, { roleCode: "hearthside.retail_worker", occupationCode: "retail_worker", employmentStatus: "employed", organizationId: "biz_hearthside", segment: "business" }),
  ...repeatSlot(1, { roleCode: "fogline.owner", occupationCode: "business_owner", employmentStatus: "employed", organizationId: "biz_fogline", segment: "business" }),
  ...repeatSlot(2, { roleCode: "fogline.service_worker", occupationCode: "service_worker", employmentStatus: "employed", organizationId: "biz_fogline", segment: "business" }),
  ...repeatSlot(1, { roleCode: "willow_rye.owner", occupationCode: "business_owner", employmentStatus: "employed", organizationId: "biz_willow_rye", segment: "business" }),
  ...repeatSlot(3, { roleCode: "willow_rye.cook_server", occupationCode: "cook_server", employmentStatus: "employed", organizationId: "biz_willow_rye", segment: "business" }),
  ...repeatSlot(1, { roleCode: "bluepine.owner", occupationCode: "business_owner", employmentStatus: "employed", organizationId: "biz_bluepine", segment: "business" }),
  ...repeatSlot(3, { roleCode: "bluepine.construction_worker", occupationCode: "construction_worker", employmentStatus: "employed", organizationId: "biz_bluepine", segment: "business" }),
  ...repeatSlot(1, { roleCode: "cedar_sage.owner", occupationCode: "business_owner", employmentStatus: "employed", organizationId: "biz_cedar_sage", segment: "business" }),
  ...repeatSlot(1, { roleCode: "cedar_sage.junior_accountant", occupationCode: "junior_accountant", employmentStatus: "employed", organizationId: "biz_cedar_sage", segment: "business" }),
];

const independentSlots: RiverbendRoleSlot[] = [
  ...repeatSlot(2, { roleCode: "independent.software_engineer", occupationCode: "freelance_software_engineer", employmentStatus: "employed", organizationId: null, segment: "independent" }),
  ...repeatSlot(1, { roleCode: "independent.investor", occupationCode: "independent_investor", employmentStatus: "employed", organizationId: null, segment: "independent" }),
  ...repeatSlot(1, { roleCode: "independent.journalist", occupationCode: "freelance_journalist", employmentStatus: "employed", organizationId: null, segment: "independent" }),
  ...repeatSlot(2, { roleCode: "independent.gig_delivery", occupationCode: "gig_delivery_worker", employmentStatus: "employed", organizationId: null, segment: "independent" }),
  ...repeatSlot(11, { roleCode: "independent.student", occupationCode: "student", employmentStatus: "student", organizationId: "inst_riverbend_school", segment: "independent", maxAge: 22 }),
  ...repeatSlot(5, { roleCode: "independent.unemployed", occupationCode: "unemployed", employmentStatus: "unemployed", organizationId: null, segment: "independent", maxAge: 64 }),
  ...repeatSlot(9, { roleCode: "independent.retiree", occupationCode: "retiree", employmentStatus: "retired", organizationId: null, segment: "independent" }),
  ...repeatSlot(3, { roleCode: "independent.homemaker", occupationCode: "homemaker", employmentStatus: "homemaker", organizationId: null, segment: "independent", maxAge: 64 }),
];

export const RIVERBEND_ROLE_SLOTS: readonly RiverbendRoleSlot[] = Object.freeze([
  ...institutionSlots,
  ...businessSlots,
  ...independentSlots,
]);

export const RIVERBEND_BUSINESS_IDS = Object.freeze([
  "biz_ironvale",
  "biz_hearthside",
  "biz_fogline",
  "biz_willow_rye",
  "biz_bluepine",
  "biz_cedar_sage",
]);

export const RIVERBEND_ROLE_COUNTS: Readonly<Record<string, number>> = Object.freeze(
  RIVERBEND_ROLE_SLOTS.reduce<Record<string, number>>((counts, slot) => {
    counts[slot.roleCode] = (counts[slot.roleCode] ?? 0) + 1;
    return counts;
  }, {}),
);

if (institutionSlots.length !== 35 || businessSlots.length !== 31 || independentSlots.length !== 34) {
  throw new Error("Riverbend role roster must remain 35 institution + 31 business + 34 independent");
}
