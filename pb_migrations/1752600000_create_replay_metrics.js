/// <reference path="../pb_data/types.d.ts" />
// Durable, server-only timing telemetry for three-minute replay sessions.
// Every operation is guarded so an interrupted migration can be applied again.
migrate((app) => {
  const fieldByName = (collection, name) => {
    try {
      if (collection.fields && collection.fields.getByName) {
        return collection.fields.getByName(name);
      }
    } catch {}
    for (const field of collection.fields || []) {
      if (field.name === name) {
        return field;
      }
    }
    return null;
  };

  const addFieldIfMissing = (collection, field) => {
    if (fieldByName(collection, field.name)) {
      return false;
    }
    if (collection.fields && collection.fields.add) {
      collection.fields.add(field);
    } else {
      collection.fields = collection.fields || [];
      collection.fields.push(field);
    }
    return true;
  };

  const hasIndex = (collection, name) => {
    for (const index of collection.indexes || []) {
      if (String(index).indexOf(name) !== -1) {
        return true;
      }
    }
    return false;
  };

  let scenarios;
  try {
    scenarios = app.findCollectionByNameOrId("scenarios");
  } catch {
    // Earlier game migrations create scenarios. Do not create an incomplete
    // replay_metrics collection if they are unexpectedly unavailable.
    return;
  }

  let replayMetrics;
  try {
    replayMetrics = app.findCollectionByNameOrId("replay_metrics");
  } catch {
    replayMetrics = new Collection({ name: "replay_metrics", type: "base" });
    replayMetrics.fields = [];
    replayMetrics.indexes = [];
  }

  addFieldIfMissing(replayMetrics, new TextField({ name: "session_token", required: true, max: 64 }));
  addFieldIfMissing(replayMetrics, new TextField({ name: "device_id", max: 64 }));
  addFieldIfMissing(replayMetrics, new NumberField({ name: "day_number", min: 0, onlyInt: true }));
  addFieldIfMissing(replayMetrics, new RelationField({
    name: "scenario",
    collectionId: scenarios.id,
    required: true,
    maxSelect: 1,
  }));
  addFieldIfMissing(replayMetrics, new SelectField({
    name: "status",
    required: true,
    maxSelect: 1,
    values: ["active", "paused", "completed", "expired"],
  }));
  addFieldIfMissing(replayMetrics, new NumberField({ name: "pause_count", min: 0, onlyInt: true }));
  addFieldIfMissing(replayMetrics, new NumberField({ name: "pause_total_ms", min: 0, onlyInt: true }));
  addFieldIfMissing(replayMetrics, new JSONField({ name: "pause_events", maxSize: 50000 }));
  addFieldIfMissing(replayMetrics, new NumberField({ name: "elapsed_ms", min: 0, onlyInt: true }));
  addFieldIfMissing(replayMetrics, new AutodateField({ name: "created", onCreate: true }));
  addFieldIfMissing(replayMetrics, new AutodateField({ name: "updated", onCreate: true, onUpdate: true }));

  const statusField = fieldByName(replayMetrics, "status");
  if (statusField) {
    const values = [];
    for (const value of statusField.values || []) {
      values.push(value);
    }
    for (const value of ["active", "paused", "completed", "expired"]) {
      if (values.indexOf(value) === -1) {
        values.push(value);
      }
    }
    statusField.values = values;
    statusField.required = true;
  }

  replayMetrics.listRule = null;
  replayMetrics.viewRule = null;
  replayMetrics.createRule = null;
  replayMetrics.updateRule = null;
  replayMetrics.deleteRule = null;
  replayMetrics.indexes = replayMetrics.indexes || [];
  if (!hasIndex(replayMetrics, "idx_replay_metrics_session_token")) {
    replayMetrics.indexes.push("CREATE UNIQUE INDEX IF NOT EXISTS idx_replay_metrics_session_token ON replay_metrics (session_token)");
  }
  app.save(replayMetrics);

  // Sessions are still the normal game session records, but replay expiry
  // needs a durable terminal status in addition to the metrics status.
  try {
    const sessions = app.findCollectionByNameOrId("sessions");
    const sessionStatus = fieldByName(sessions, "status");
    if (sessionStatus) {
      const values = [];
      for (const value of sessionStatus.values || []) {
        values.push(value);
      }
      if (values.indexOf("expired") === -1) {
        values.push("expired");
        sessionStatus.values = values;
        app.save(sessions);
      }
    }
  } catch {}
}, (app) => {
  try {
    app.delete(app.findCollectionByNameOrId("replay_metrics"));
  } catch {}
});
