// SPDX-License-Identifier: BUSL-1.1
import test from "node:test";
import assert from "node:assert/strict";
import { shouldSwapBackForFunding } from "./engine.mjs";

test("funding proposals allow only known closed states, including PartiallyFunded", () => {
  for (let batchStatus = 0n; batchStatus <= 255n; batchStatus++) {
    assert.equal(shouldSwapBackForFunding({ batchStatus, fulfilledOnce: false,
      obligation: 100n, funded: 50n, available: 50n }), [2n, 3n, 4n, 5n].includes(batchStatus),
    `batchStatus ${batchStatus}`);
  }
  assert.equal(shouldSwapBackForFunding({ batchStatus: 5n, fulfilledOnce: true,
    obligation: 100n, funded: 50n, available: 50n }), false);
});
