import test from "node:test";
import assert from "node:assert/strict";
import { FleetStore } from "../src/store.js";
import { autoEvolve, runLive } from "../src/fleet.js";

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

test("live runs share closures through fleet memory once the harness learns to report and query", async () => {
  const store = new FleetStore();
  await store.init();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.MODEL_API_URL;
  await autoEvolve(store);
  const first = await runLive(store, "construction-main");
  assert.equal(first.status, "delivered");
  assert.equal(first.metrics.blockedEncounters, 1);
  assert.equal((await store.listRoadEvents("construction-main")).length, 1);
  const second = await runLive(store, "construction-main");
  assert.equal(second.metrics.blockedEncounters, 0);
  assert.equal(second.vehicle, 2);
});
