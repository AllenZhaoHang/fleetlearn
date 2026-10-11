import test from "node:test";
import assert from "node:assert/strict";
import { FleetStore } from "../src/store.js";

test("memory store versions and activates an evaluated harness", async () => {
  const store = new FleetStore();
  await store.init();
  await store.saveHarness({
    version: 2,
    name: "candidate",
    status: "candidate",
    parentVersion: 1,
    recoverySteps: ["inspect_local", "update_local_map", "replan", "follow_route"],
    maxRecoveryCycles: 3
  });

  const activated = await store.activateHarness(2);
  assert.equal(activated.status, "active");
  assert.equal((await store.getHarness(1)).status, "retired");
});
