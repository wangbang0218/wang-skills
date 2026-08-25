export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(String(text), "utf8") / 2);
}

export function selectContextFiles(catalog, {
  budgetTokens,
  requiredPaths = [],
}) {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) throw new Error("budgetTokens must be positive.");
  const required = new Set(requiredPaths);
  const byPath = new Map(catalog.map((item) => [item.path, item]));
  const missing = [...required].filter((item) => !byPath.has(item));
  if (missing.length > 0) {
    return { status: "BLOCKED", reason: `Missing mandatory context: ${missing.join(", ")}`, selected: [], omitted: [] };
  }

  const mandatory = [...required].map((item) => byPath.get(item)).sort(compareCatalog);
  const mandatoryTokens = mandatory.reduce((sum, item) => sum + item.estimated_tokens, 0);
  if (mandatoryTokens > budgetTokens) {
    return {
      status: "BLOCKED",
      reason: `The mandatory context requires ${mandatoryTokens} tokens, exceeding the ${budgetTokens} token budget.`,
      selected: [],
      omitted: [],
    };
  }

  const selected = [...mandatory];
  const omitted = [];
  let used = mandatoryTokens;
  const candidates = catalog
    .filter((item) => !required.has(item.path))
    .sort(compareCatalog);
  for (const item of candidates) {
    if (used + item.estimated_tokens <= budgetTokens) {
      selected.push(item);
      used += item.estimated_tokens;
    } else {
      omitted.push({
        path: item.path,
        sha256: item.sha256,
        reason: "context_budget",
        estimated_tokens: item.estimated_tokens,
      });
    }
  }
  return {
    status: "READY",
    selected,
    omitted,
    estimated_tokens: used,
    mandatory_tokens: mandatoryTokens,
    budget_tokens: budgetTokens,
  };
}

function compareCatalog(left, right) {
  return (left.tier ?? 99) - (right.tier ?? 99) || left.path.localeCompare(right.path);
}
