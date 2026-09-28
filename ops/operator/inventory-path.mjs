// SPDX-License-Identifier: BUSL-1.1
import { dirname, resolve } from "node:path";

/**
 * Where this seat's NAV inventory lives. `resolve`, not `join`: an ABSOLUTE inventoryFile is the
 * documented external-operator setup (/var/lib/ditto-operator/nav-inventory.json, written by the
 * reconciler, while the config sits under /etc), and `path.join` does not honour an absolute second
 * argument — it concatenates, so the seat opened /etc/ditto-operator/var/lib/… and failed every
 * price-setting task with ENOENT. Found 2026-09-04 by the onboarding rehearsal, on the sixth seat's
 * first signing round; the five pilot seats use a relative path beside their config and never hit it.
 * check-operator-ready.sh applies the same rule in Python; the two must agree.
 */
export function inventoryPathFor(configPath, inventoryFile) {
  return inventoryFile ? resolve(dirname(configPath), inventoryFile) : null;
}
