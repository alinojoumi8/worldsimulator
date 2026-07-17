/** Immutable M02 catalogs and curated synthetic naming inputs. */

import { EngineError } from "./envelope";
import { occupationSchema, skillSchema } from "./agent";
import type { Occupation, Skill } from "./agent";

function freezeCatalog<T extends object>(items: readonly T[]): readonly Readonly<T>[] {
  return Object.freeze(items.map((item) => Object.freeze(item)));
}

export const SKILL_CATALOG: readonly Readonly<Skill>[] = freezeCatalog(
  [
    ["finance", "Finance", ["banking", "government", "professional_services"]],
    ["sales", "Sales", ["retail", "food_service", "entrepreneurship"]],
    ["operations", "Operations", ["manufacturing", "energy", "administration"]],
    ["engineering", "Engineering", ["manufacturing", "energy", "construction"]],
    ["medicine", "Medicine", ["healthcare"]],
    ["law", "Law", ["legal"]],
    ["teaching", "Teaching", ["education"]],
    ["writing", "Writing", ["media", "professional_services"]],
    ["cooking", "Cooking", ["food_service"]],
    ["construction", "Construction", ["construction"]],
    ["logistics", "Logistics", ["transport", "manufacturing", "retail"]],
    ["software", "Software", ["technology"]],
    ["administration", "Administration", ["government", "education", "healthcare"]],
    ["communication", "Communication", ["media", "education", "services"]],
  ].map(([code, name, sectorAffinity]) => skillSchema.parse({ code, name, sectorAffinity })),
);

type OccupationInput = Omit<Occupation, "personalityTags"> & {
  personalityTags?: readonly string[];
};

function occupation(input: OccupationInput): Occupation {
  return occupationSchema.parse({ ...input, personalityTags: input.personalityTags ?? [] });
}

export const OCCUPATION_CATALOG: readonly Readonly<Occupation>[] = freezeCatalog([
  occupation({ code: "branch_manager", title: "Bank Branch Manager", requiredSkills: ["finance", "operations"], baseWageBand: { minAnnualCents: "9500000", maxAnnualCents: "11500000" }, sector: "banking", minimumAge: 30, minimumEducation: "college", employmentKind: "wage", personalityTags: ["financial_care"] }),
  occupation({ code: "loan_officer", title: "Loan Officer", requiredSkills: ["finance", "communication"], baseWageBand: { minAnnualCents: "5500000", maxAnnualCents: "7000000" }, sector: "banking", minimumAge: 25, minimumEducation: "college", employmentKind: "wage", personalityTags: ["financial_care"] }),
  occupation({ code: "teller", title: "Bank Teller", requiredSkills: ["finance", "communication"], baseWageBand: { minAnnualCents: "3400000", maxAnnualCents: "4000000" }, sector: "banking", minimumAge: 18, minimumEducation: "hs", employmentKind: "wage" }),
  occupation({ code: "vc_partner", title: "Venture Capital Partner", requiredSkills: ["finance", "sales"], baseWageBand: { minAnnualCents: "17000000", maxAnnualCents: "20000000" }, sector: "investment", minimumAge: 30, minimumEducation: "college", employmentKind: "wage", personalityTags: ["vc_partner"] }),
  occupation({ code: "vc_analyst", title: "Venture Capital Analyst", requiredSkills: ["finance", "communication"], baseWageBand: { minAnnualCents: "7000000", maxAnnualCents: "8500000" }, sector: "investment", minimumAge: 23, minimumEducation: "college", employmentKind: "wage" }),
  occupation({ code: "lawyer", title: "Lawyer", requiredSkills: ["law", "communication"], baseWageBand: { minAnnualCents: "15000000", maxAnnualCents: "18000000" }, sector: "legal", minimumAge: 25, minimumEducation: "graduate", employmentKind: "wage" }),
  occupation({ code: "paralegal", title: "Paralegal", requiredSkills: ["law", "administration"], baseWageBand: { minAnnualCents: "4500000", maxAnnualCents: "5500000" }, sector: "legal", minimumAge: 21, minimumEducation: "college", employmentKind: "wage" }),
  occupation({ code: "school_principal", title: "School Principal", requiredSkills: ["teaching", "administration"], baseWageBand: { minAnnualCents: "8500000", maxAnnualCents: "9500000" }, sector: "education", minimumAge: 30, minimumEducation: "college", employmentKind: "wage", personalityTags: ["care_worker"] }),
  occupation({ code: "teacher", title: "Teacher", requiredSkills: ["teaching", "communication"], baseWageBand: { minAnnualCents: "4800000", maxAnnualCents: "6200000" }, sector: "education", minimumAge: 22, minimumEducation: "college", employmentKind: "wage", personalityTags: ["care_worker"] }),
  occupation({ code: "news_editor", title: "News Editor", requiredSkills: ["writing", "communication"], baseWageBand: { minAnnualCents: "7000000", maxAnnualCents: "8000000" }, sector: "media", minimumAge: 28, minimumEducation: "college", employmentKind: "wage", personalityTags: ["journalist_freelancer"] }),
  occupation({ code: "journalist", title: "Journalist", requiredSkills: ["writing", "communication"], baseWageBand: { minAnnualCents: "4500000", maxAnnualCents: "5800000" }, sector: "media", minimumAge: 21, minimumEducation: "college", employmentKind: "wage", personalityTags: ["journalist_freelancer"] }),
  occupation({ code: "mayor", title: "Mayor", requiredSkills: ["communication", "administration"], baseWageBand: { minAnnualCents: "9000000", maxAnnualCents: "9000000" }, sector: "government", minimumAge: 35, minimumEducation: "college", employmentKind: "wage", personalityTags: ["public_employee"] }),
  occupation({ code: "treasurer", title: "Town Treasurer", requiredSkills: ["finance", "administration"], baseWageBand: { minAnnualCents: "7800000", maxAnnualCents: "7800000" }, sector: "government", minimumAge: 25, minimumEducation: "college", employmentKind: "wage", personalityTags: ["financial_care", "public_employee"] }),
  occupation({ code: "town_economist", title: "Town Economist", requiredSkills: ["finance", "administration"], baseWageBand: { minAnnualCents: "7200000", maxAnnualCents: "7200000" }, sector: "government", minimumAge: 25, minimumEducation: "graduate", employmentKind: "wage", personalityTags: ["public_employee"] }),
  occupation({ code: "town_clerk", title: "Town Clerk", requiredSkills: ["administration", "communication"], baseWageBand: { minAnnualCents: "3800000", maxAnnualCents: "4600000" }, sector: "government", minimumAge: 18, minimumEducation: "hs", employmentKind: "wage", personalityTags: ["public_employee"] }),
  occupation({ code: "maintenance_worker", title: "Maintenance Worker", requiredSkills: ["operations", "construction"], baseWageBand: { minAnnualCents: "3600000", maxAnnualCents: "4200000" }, sector: "government", minimumAge: 18, minimumEducation: "hs", employmentKind: "wage", personalityTags: ["public_employee"] }),
  occupation({ code: "exchange_operations_manager", title: "Exchange Operations Manager", requiredSkills: ["operations", "finance"], baseWageBand: { minAnnualCents: "7500000", maxAnnualCents: "7500000" }, sector: "market_operations", minimumAge: 30, minimumEducation: "college", employmentKind: "wage" }),
  occupation({ code: "plant_manager", title: "Plant Manager", requiredSkills: ["operations", "engineering"], baseWageBand: { minAnnualCents: "10500000", maxAnnualCents: "12000000" }, sector: "energy", minimumAge: 30, minimumEducation: "college", employmentKind: "wage" }),
  occupation({ code: "engineer", title: "Engineer", requiredSkills: ["engineering", "operations"], baseWageBand: { minAnnualCents: "8000000", maxAnnualCents: "10000000" }, sector: "engineering", minimumAge: 22, minimumEducation: "college", employmentKind: "wage" }),
  occupation({ code: "energy_technician", title: "Energy Technician", requiredSkills: ["engineering", "operations"], baseWageBand: { minAnnualCents: "5200000", maxAnnualCents: "6400000" }, sector: "energy", minimumAge: 20, minimumEducation: "hs", employmentKind: "wage" }),
  occupation({ code: "doctor", title: "Doctor", requiredSkills: ["medicine", "communication"], baseWageBand: { minAnnualCents: "16500000", maxAnnualCents: "19500000" }, sector: "healthcare", minimumAge: 28, minimumEducation: "graduate", employmentKind: "wage" }),
  occupation({ code: "nurse", title: "Nurse", requiredSkills: ["medicine", "communication"], baseWageBand: { minAnnualCents: "6000000", maxAnnualCents: "7200000" }, sector: "healthcare", minimumAge: 21, minimumEducation: "college", employmentKind: "wage", personalityTags: ["care_worker"] }),
  occupation({ code: "receptionist", title: "Receptionist", requiredSkills: ["administration", "communication"], baseWageBand: { minAnnualCents: "3400000", maxAnnualCents: "3800000" }, sector: "healthcare", minimumAge: 18, minimumEducation: "hs", employmentKind: "wage" }),
  occupation({ code: "business_owner", title: "Owner-Operator", requiredSkills: ["operations", "sales"], baseWageBand: { minAnnualCents: "4500000", maxAnnualCents: "9000000" }, sector: "entrepreneurship", minimumAge: 30, minimumEducation: "hs", employmentKind: "draw", personalityTags: ["owner_founder"] }),
  occupation({ code: "operations_manager", title: "Operations Manager", requiredSkills: ["operations", "communication"], baseWageBand: { minAnnualCents: "7800000", maxAnnualCents: "9000000" }, sector: "manufacturing", minimumAge: 30, minimumEducation: "college", employmentKind: "wage" }),
  occupation({ code: "accountant", title: "Accountant", requiredSkills: ["finance", "administration"], baseWageBand: { minAnnualCents: "6000000", maxAnnualCents: "7500000" }, sector: "professional_services", minimumAge: 22, minimumEducation: "college", employmentKind: "wage", personalityTags: ["financial_care"] }),
  occupation({ code: "factory_worker", title: "Factory Worker", requiredSkills: ["operations", "logistics"], baseWageBand: { minAnnualCents: "4000000", maxAnnualCents: "5000000" }, sector: "manufacturing", minimumAge: 18, minimumEducation: "hs", employmentKind: "wage" }),
  occupation({ code: "retail_worker", title: "Retail Worker", requiredSkills: ["sales", "communication"], baseWageBand: { minAnnualCents: "2800000", maxAnnualCents: "3400000" }, sector: "retail", minimumAge: 16, minimumEducation: "none", employmentKind: "wage" }),
  occupation({ code: "service_worker", title: "Food Service Worker", requiredSkills: ["cooking", "communication"], baseWageBand: { minAnnualCents: "2600000", maxAnnualCents: "3200000" }, sector: "food_service", minimumAge: 16, minimumEducation: "none", employmentKind: "wage" }),
  occupation({ code: "cook_server", title: "Cook and Server", requiredSkills: ["cooking", "communication"], baseWageBand: { minAnnualCents: "2600000", maxAnnualCents: "3400000" }, sector: "food_service", minimumAge: 16, minimumEducation: "none", employmentKind: "wage" }),
  occupation({ code: "construction_worker", title: "Construction Worker", requiredSkills: ["construction", "operations"], baseWageBand: { minAnnualCents: "4400000", maxAnnualCents: "5400000" }, sector: "construction", minimumAge: 18, minimumEducation: "hs", employmentKind: "wage" }),
  occupation({ code: "junior_accountant", title: "Junior Accountant", requiredSkills: ["finance", "administration"], baseWageBand: { minAnnualCents: "4200000", maxAnnualCents: "5000000" }, sector: "professional_services", minimumAge: 20, minimumEducation: "college", employmentKind: "wage", personalityTags: ["financial_care"] }),
  occupation({ code: "freelance_software_engineer", title: "Freelance Software Engineer", requiredSkills: ["software", "communication"], baseWageBand: { minAnnualCents: "8500000", maxAnnualCents: "12000000" }, sector: "technology", minimumAge: 22, minimumEducation: "college", employmentKind: "variable", personalityTags: ["journalist_freelancer"] }),
  occupation({ code: "independent_investor", title: "Independent Investor", requiredSkills: ["finance", "sales"], baseWageBand: { minAnnualCents: "4500000", maxAnnualCents: "10000000" }, sector: "investment", minimumAge: 30, minimumEducation: "college", employmentKind: "capital" }),
  occupation({ code: "freelance_journalist", title: "Freelance Journalist", requiredSkills: ["writing", "communication"], baseWageBand: { minAnnualCents: "4500000", maxAnnualCents: "5800000" }, sector: "media", minimumAge: 21, minimumEducation: "college", employmentKind: "variable", personalityTags: ["journalist_freelancer"] }),
  occupation({ code: "gig_delivery_worker", title: "Gig Delivery Worker", requiredSkills: ["logistics", "communication"], baseWageBand: { minAnnualCents: "2400000", maxAnnualCents: "3200000" }, sector: "transport", minimumAge: 18, minimumEducation: "none", employmentKind: "variable" }),
  occupation({ code: "student", title: "Student", requiredSkills: ["communication", "administration"], baseWageBand: { minAnnualCents: "600000", maxAnnualCents: "1000000" }, sector: "education", minimumAge: 16, minimumEducation: "none", employmentKind: "transfer" }),
  occupation({ code: "unemployed", title: "Job Seeker", requiredSkills: ["communication", "administration"], baseWageBand: { minAnnualCents: "1200000", maxAnnualCents: "1200000" }, sector: "unemployed", minimumAge: 18, minimumEducation: "none", employmentKind: "transfer" }),
  occupation({ code: "retiree", title: "Retiree", requiredSkills: ["communication", "administration"], baseWageBand: { minAnnualCents: "2200000", maxAnnualCents: "3000000" }, sector: "retired", minimumAge: 65, minimumEducation: "none", employmentKind: "transfer" }),
  occupation({ code: "homemaker", title: "Homemaker", requiredSkills: ["cooking", "administration"], baseWageBand: { minAnnualCents: "0", maxAnnualCents: "0" }, sector: "household", minimumAge: 18, minimumEducation: "none", employmentKind: "none" }),
]);

export const OCCUPATIONS_BY_CODE: ReadonlyMap<string, Readonly<Occupation>> = new Map(
  OCCUPATION_CATALOG.map((entry) => [entry.code, entry]),
);
export const SKILLS_BY_CODE: ReadonlyMap<string, Readonly<Skill>> = new Map(
  SKILL_CATALOG.map((entry) => [entry.code, entry]),
);

export const SYNTHETIC_FIRST_NAMES = Object.freeze([
  "Aven", "Bria", "Corin", "Della", "Eris", "Faron", "Galen", "Hesta", "Iven", "Jora",
  "Kael", "Luma", "Maren", "Nilo", "Orla", "Perrin", "Quilla", "Riven", "Sela", "Tarin",
  "Una", "Vero", "Wren", "Xara", "Yorin", "Zella", "Amri", "Bex", "Calia", "Dorin",
]);

export const SYNTHETIC_LAST_NAMES = Object.freeze([
  "Alderwick", "Briarfen", "Copperly", "Duskvale", "Emberlin", "Fairmere", "Glenward", "Hollowayr",
  "Ironmere", "Junebrook", "Kestrelby", "Larkspur", "Mossward", "Northfen", "Oakmere", "Pinecroft",
  "Quarryn", "Reedvale", "Stonewick", "Thornmere", "Umberly", "Valehart", "Willowfen", "Yarrowby",
  "Zephyrn", "Ashcombe", "Bellmere", "Cinderly", "Driftwood", "Elmward",
]);

export const PUBLIC_FIGURE_NAME_BLOCKLIST = Object.freeze([
  "barack obama",
  "elon musk",
  "taylor swift",
]);

export function normalizeSyntheticName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function assertSyntheticNameAllowed(
  name: string,
  blocklist: readonly string[] = PUBLIC_FIGURE_NAME_BLOCKLIST,
): void {
  const normalized = normalizeSyntheticName(name);
  const blocked = new Set(blocklist.map(normalizeSyntheticName));
  if (blocked.has(normalized)) {
    throw new EngineError("VALIDATION_FAILED", `synthetic name is blocklisted: ${name}`);
  }
}
