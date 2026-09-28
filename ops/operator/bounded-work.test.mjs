import test from "node:test";
import assert from "node:assert/strict";
import { BoundedWork, WorkLimitExceeded } from "./bounded-work.mjs";

test("identical in-flight requests run once; completed retries must revalidate", async () => {
  const jobs = new BoundedWork(1, 2);
  let resolve, calls = 0;
  const work = () => { calls++; return new Promise(r => { resolve = r; }); };
  const a = jobs.run("exact bytes", work);
  const b = jobs.run("exact bytes", work);
  assert.throws(() => jobs.run("exact bytes", work), WorkLimitExceeded);
  assert.throws(() => jobs.run("changed nonce/body", work), WorkLimitExceeded);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve("signature");
  assert.deepEqual(await Promise.all([a, b]), ["signature", "signature"]);
  assert.equal(await jobs.run("exact bytes", () => "fresh refusal"), "fresh refusal");
});

test("failure releases capacity without an unhandled promise rejection", async () => {
  const jobs = new BoundedWork(1);
  const a = jobs.run("a", () => { throw new Error("failed read"); });
  const b = jobs.run("a", () => assert.fail("duplicate executed"));
  await assert.rejects(a, /failed read/);
  await assert.rejects(b, /failed read/);
  assert.equal(await jobs.run("b", () => 1), 1);
});
