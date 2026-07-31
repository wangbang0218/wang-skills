import assert from "node:assert/strict";
import test from "node:test";

import { selectK3Model } from "../lib/preflight.mjs";

const catalog = {
  models: {
    "kimi-code/k3": {
      model: "k3",
      maxContextSize: 1_048_576,
      supportEfforts: ["low", "high", "max"],
    },
    "kimi-code/k3-256k": {
      model: "k3-256k",
      maxContextSize: 262_144,
      supportEfforts: ["low", "high", "max"],
    },
  },
};

test("preflight accepts only K3 with a one-million-token context", () => {
  assert.equal(selectK3Model(catalog).alias, "kimi-code/k3");
  assert.throws(() => selectK3Model(catalog, "kimi-code/k3-256k"), /1,048,576/);
});

test("preflight rejects missing effort capabilities", () => {
  const invalid = structuredClone(catalog);
  invalid.models["kimi-code/k3"].supportEfforts = ["low", "high"];
  assert.throws(() => selectK3Model(invalid), /max/);
});
