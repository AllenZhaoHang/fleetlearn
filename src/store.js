import { MongoClient } from "mongodb";
import { baselineHarness } from "./simulator.js";

export class FleetStore {
  constructor({ uri, databaseName = "fleetlearn" } = {}) {
    this.uri = uri;
    this.databaseName = databaseName;
    this.client = null;
    this.db = null;
    this.mode = "memory";
    this.memory = {
      harnesses: new Map(),
      runs: new Map(),
      evaluations: new Map(),
      roadEvents: []
    };
  }

  async init() {
    if (this.uri) {
      try {
        this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 7000 });
        await this.client.connect();
        this.db = this.client.db(this.databaseName);
        await Promise.all([
          this.db.collection("runs").createIndex({ runId: 1 }, { unique: true }),
          this.db.collection("harness_versions").createIndex({ version: 1 }, { unique: true }),
          this.db.collection("evaluations").createIndex({ evaluationId: 1 }, { unique: true }),
          this.db.collection("road_events").createIndex({ worldId: 1, edge: 1 }, { unique: true })
        ]);
        this.mode = "atlas";
      } catch (error) {
        console.warn(`Atlas unavailable; using in-memory demo mode: ${error.message}`);
        await this.client?.close().catch(() => {});
        this.client = null;
        this.db = null;
      }
    }

    const harnesses = await this.listHarnesses();
    if (!harnesses.length) await this.saveHarness(structuredClone(baselineHarness));
    return this.mode;
  }

  async close() {
    await this.client?.close();
  }

  async saveHarness(harness) {
    const clean = structuredClone(harness);
    if (this.db) {
      await this.db.collection("harness_versions").replaceOne(
        { version: clean.version },
        clean,
        { upsert: true }
      );
    } else {
      this.memory.harnesses.set(clean.version, clean);
    }
    return clean;
  }

  async listHarnesses() {
    if (this.db) {
      return this.db.collection("harness_versions")
        .find({}, { projection: { _id: 0 } })
        .sort({ version: 1 })
        .toArray();
    }
    return [...this.memory.harnesses.values()].sort((a, b) => a.version - b.version);
  }

  async getHarness(version) {
    if (this.db) {
      return this.db.collection("harness_versions").findOne(
        { version: Number(version) },
        { projection: { _id: 0 } }
      );
    }
    return this.memory.harnesses.get(Number(version)) ?? null;
  }

  async getActiveHarness() {
    if (this.db) {
      return this.db.collection("harness_versions").findOne(
        { status: "active" },
        { projection: { _id: 0 }, sort: { version: -1 } }
      );
    }
    return [...this.memory.harnesses.values()]
      .filter((item) => item.status === "active")
      .sort((a, b) => b.version - a.version)[0] ?? null;
  }

  async activateHarness(version) {
    const target = await this.getHarness(version);
    if (!target) throw new Error(`Harness version ${version} does not exist`);
    if (this.db) {
      await this.db.collection("harness_versions").updateMany(
        { status: "active" },
        { $set: { status: "retired" } }
      );
      await this.db.collection("harness_versions").updateOne(
        { version: Number(version) },
        { $set: { status: "active", activatedAt: new Date().toISOString() } }
      );
    } else {
      for (const harness of this.memory.harnesses.values()) {
        if (harness.status === "active") harness.status = "retired";
      }
      target.status = "active";
      target.activatedAt = new Date().toISOString();
      this.memory.harnesses.set(target.version, target);
    }
    return this.getHarness(version);
  }

  async setHarnessStatus(version, status) {
    if (this.db) {
      await this.db.collection("harness_versions").updateOne({ version: Number(version) }, { $set: { status } });
    } else {
      const harness = this.memory.harnesses.get(Number(version));
      if (harness) harness.status = status;
    }
  }

  async listRejected() {
    return (await this.listHarnesses()).filter((harness) => harness.status === "rejected");
  }

  // Fleet memory: closures reported by vehicles, keyed by the road world they were seen in.
  async saveRoadEvents(worldId, edges, run) {
    const docs = edges.map((edge) => ({
      worldId,
      edge,
      reportedBy: run.runId,
      harnessVersion: run.harnessVersion,
      reportedAt: new Date().toISOString()
    }));
    if (!docs.length) return;
    if (this.db) {
      await this.db.collection("road_events").bulkWrite(docs.map((doc) => ({
        updateOne: { filter: { worldId, edge: doc.edge }, update: { $setOnInsert: doc }, upsert: true }
      })));
    } else {
      for (const doc of docs) {
        if (!this.memory.roadEvents.some((item) => item.worldId === worldId && item.edge === doc.edge)) this.memory.roadEvents.push(doc);
      }
    }
  }

  async listRoadEvents(worldId) {
    if (this.db) {
      return this.db.collection("road_events").find(worldId ? { worldId } : {}, { projection: { _id: 0 } }).toArray();
    }
    return this.memory.roadEvents.filter((item) => !worldId || item.worldId === worldId);
  }

  async saveRun(run) {
    const clean = structuredClone(run);
    if (this.db) {
      await this.db.collection("runs").replaceOne(
        { runId: clean.runId },
        clean,
        { upsert: true }
      );
    } else {
      this.memory.runs.set(clean.runId, clean);
    }
    return clean;
  }

  async getRun(runId) {
    if (this.db) {
      return this.db.collection("runs").findOne(
        { runId },
        { projection: { _id: 0 } }
      );
    }
    return this.memory.runs.get(runId) ?? null;
  }

  async listRuns(limit = 8) {
    if (this.db) {
      return this.db.collection("runs")
        .find({}, { projection: { _id: 0, scenario: 0, events: 0 } })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();
    }
    return [...this.memory.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(({ scenario, events, ...run }) => run);
  }

  async saveEvaluation(evaluation) {
    const clean = structuredClone(evaluation);
    if (this.db) {
      await this.db.collection("evaluations").replaceOne(
        { evaluationId: clean.evaluationId },
        clean,
        { upsert: true }
      );
    } else {
      this.memory.evaluations.set(clean.evaluationId, clean);
    }
    return clean;
  }

  async listEvaluations(limit = 4) {
    if (this.db) {
      return this.db.collection("evaluations")
        .find({}, { projection: { _id: 0, baselineResults: 0, candidateResults: 0 } })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();
    }
    return [...this.memory.evaluations.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(({ baselineResults, candidateResults, ...evaluation }) => evaluation);
  }

  async resetDemo() {
    if (this.db) {
      await Promise.all([
        this.db.collection("runs").deleteMany({}),
        this.db.collection("evaluations").deleteMany({}),
        this.db.collection("harness_versions").deleteMany({}),
        this.db.collection("road_events").deleteMany({})
      ]);
    } else {
      this.memory.runs.clear();
      this.memory.evaluations.clear();
      this.memory.harnesses.clear();
      this.memory.roadEvents = [];
    }
    await this.saveHarness(structuredClone(baselineHarness));
  }
}
