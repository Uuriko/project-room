// Local test double with its own database. Never imported by a deployed entrypoint.
import { DatabaseSync } from "node:sqlite";
export class SyntheticMailFixture {
  kind = "synthetic";
  mode = "accepted";
  submits = 0;
  lookups = 0;
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec("CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, envelope TEXT NOT NULL, receipt TEXT NOT NULL)");
  }
  async submit({ operationId, envelope }) {
    this.submits++;
    if (this.mode === "before") throw new Error("Synthetic unavailable before submission");
    let row = this.db.prepare("SELECT * FROM messages WHERE id=?").get(operationId);
    if (row && row.envelope !== JSON.stringify(envelope)) throw new Error("Synthetic correlation conflict");
    if (!row) {
      const outcome = this.mode === "rejected" ? "rejected" : "accepted";
      const receipt = { operationId, previewVersion: envelope.previewVersion, outcome, providerId: outcome === "rejected" ? null : operationId };
      this.db.prepare("INSERT INTO messages VALUES(?,?,?)").run(operationId, JSON.stringify(envelope), JSON.stringify(receipt));
      row = { receipt: JSON.stringify(receipt) };
    }
    if (this.mode === "after") throw new Error("Synthetic acknowledgement lost after acceptance");
    return JSON.parse(row.receipt);
  }
  async lookup({ operationId }) {
    this.lookups++;
    return JSON.parse(this.db.prepare("SELECT receipt FROM messages WHERE id=?").get(operationId)?.receipt ?? "null");
  }
  outcome(operationId, outcome) {
    const receipt = JSON.parse(this.db.prepare("SELECT receipt FROM messages WHERE id=?").get(operationId).receipt);
    this.db.prepare("UPDATE messages SET receipt=? WHERE id=?").run(JSON.stringify({ ...receipt, outcome }), operationId);
  }
  count() { return this.db.prepare("SELECT count(*) n FROM messages").get().n; }
  close() { this.db.close(); }
}
