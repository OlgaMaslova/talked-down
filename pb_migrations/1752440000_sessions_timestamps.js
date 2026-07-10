/// <reference path="../pb_data/types.d.ts" />
// Add created/updated autodate timestamps to sessions.
// Motivated by session-analysis-2026-07-10: sessions carry no timestamps,
// so the daily analysis cannot measure drop-off/first-message-rate changes
// over time (e.g. before/after the opener-chips UX fix). Idempotent.
migrate((app) => {
  const addFieldIfMissing = (collection, field) => {
    try {
      if (collection.fields.getByName(field.name)) return;
    } catch {}
    collection.fields.add(field);
  };

  const sessions = app.findCollectionByNameOrId("sessions");
  addFieldIfMissing(sessions, new AutodateField({ name: "created", onCreate: true }));
  addFieldIfMissing(sessions, new AutodateField({ name: "updated", onCreate: true, onUpdate: true }));
  app.save(sessions);
}, (app) => {
  try {
    const sessions = app.findCollectionByNameOrId("sessions");
    for (const name of ["created", "updated"]) {
      try {
        const f = sessions.fields.getByName(name);
        if (f) sessions.fields.removeById(f.id);
      } catch {}
    }
    app.save(sessions);
  } catch {}
});
