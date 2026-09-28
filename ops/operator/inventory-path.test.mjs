// SPDX-License-Identifier: BUSL-1.1
import { test } from "node:test";
import assert from "node:assert/strict";
import { inventoryPathFor } from "./inventory-path.mjs";

test("an absolute inventoryFile is used as-is — the external-operator layout", () => {
  assert.equal(
    inventoryPathFor("/etc/ditto-operator/operator-config.json", "/var/lib/ditto-operator/nav-inventory.json"),
    "/var/lib/ditto-operator/nav-inventory.json",
  );
});

test("a relative inventoryFile resolves against the config's directory — the pilot's layout", () => {
  assert.equal(inventoryPathFor("/etc/ditto-mainnet/operator-config-0.json", "nav-inventory.json"), "/etc/ditto-mainnet/nav-inventory.json");
});

test("no inventoryFile, no path", () => {
  assert.equal(inventoryPathFor("/etc/x/operator-config.json", undefined), null);
});
