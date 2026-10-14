/**
 * Phase 2.4 category contract. A new category is registered here. The
 * Marketplace does not gain a case for it. Hooks stay the existing
 * settlementGuard / consumedUnits pair.
 */
export const BUILTIN_CATEGORIES = ["COMPUTE", "STORAGE", "API", "DATA", "IOT_M2M"] as const;

export type CategoryContract = {
  categoryId: string;
  inputSchema: string;
  outputSchema: string;
  requirements: readonly string[];
  slaHeights: number;
};

const ID = /^[A-Z][A-Z0-9_]{1,31}$/;

export function assertCategoryContract(contract: CategoryContract): CategoryContract {
  if (!ID.test(contract.categoryId)) throw new Error("CATEGORY_ID_INVALID");
  if (!contract.inputSchema || !contract.outputSchema) throw new Error("CATEGORY_SCHEMA_REQUIRED");
  if (!Number.isSafeInteger(contract.slaHeights) || contract.slaHeights < 0) throw new Error("CATEGORY_SLA_INVALID");
  return {
    categoryId: contract.categoryId,
    inputSchema: contract.inputSchema,
    outputSchema: contract.outputSchema,
    requirements: Object.freeze([...contract.requirements]),
    slaHeights: contract.slaHeights,
  };
}

export function builtinContracts(): CategoryContract[] {
  return BUILTIN_CATEGORIES.map((categoryId) => ({
    categoryId,
    inputSchema: `${categoryId}:input`,
    outputSchema: `${categoryId}:output`,
    requirements: [],
    slaHeights: 0,
  }));
}
