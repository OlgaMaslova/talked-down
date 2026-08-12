/// <reference path="../pb_data/types.d.ts" />
// Creates the locked claims collection used for magic-link handle claims.
// Safe to re-run: guards collection, fields, and indexes.
migrate((app) => {
  const hasField = (collection, name) => {
    try {
      if (collection.fields && collection.fields.getByName) {
        return !!collection.fields.getByName(name);
      }
    } catch {}
    for (const field of collection.fields || []) {
      if (field.name === name) {
        return true;
      }
    }
    return false;
  };

  const addFieldIfMissing = (collection, field) => {
    if (hasField(collection, field.name)) {
      return;
    }
    if (collection.fields && collection.fields.add) {
      collection.fields.add(field);
    } else {
      collection.fields = collection.fields || [];
      collection.fields.push(field);
    }
  };

  const hasIndex = (collection, name) => {
    for (const index of collection.indexes || []) {
      if (String(index).indexOf(name) !== -1) {
        return true;
      }
    }
    return false;
  };

  const addIndexIfMissing = (collection, name, sql) => {
    collection.indexes = collection.indexes || [];
    if (!hasIndex(collection, name)) {
      collection.indexes.push(sql);
    }
  };

  let claims;
  try {
    claims = app.findCollectionByNameOrId("claims");
  } catch {
    claims = new Collection({ name: "claims", type: "base" });
    claims.fields = [];
    claims.indexes = [];
  }

  addFieldIfMissing(claims, new TextField({ name: "device_id", required: true, max: 64 }));
  addFieldIfMissing(claims, new TextField({ name: "handle", required: true, max: 40 }));
  addFieldIfMissing(claims, new TextField({ name: "email", required: true, max: 254 }));
  addFieldIfMissing(claims, new TextField({ name: "token_hash", required: true, max: 128 }));
  addFieldIfMissing(claims, new DateField({ name: "expires" }));
  addFieldIfMissing(claims, new SelectField({
    name: "status",
    required: true,
    maxSelect: 1,
    values: ["pending", "claimed", "expired"],
  }));
  addFieldIfMissing(claims, new DateField({ name: "claimed_at" }));
  addFieldIfMissing(claims, new AutodateField({ name: "created", onCreate: true }));
  addFieldIfMissing(claims, new AutodateField({ name: "updated", onCreate: true, onUpdate: true }));

  claims.listRule = null;
  claims.viewRule = null;
  claims.createRule = null;
  claims.updateRule = null;
  claims.deleteRule = null;

  addIndexIfMissing(claims, "idx_claims_token_hash", "CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_token_hash ON claims (token_hash)");
  addIndexIfMissing(claims, "idx_claims_device_created", "CREATE INDEX IF NOT EXISTS idx_claims_device_created ON claims (device_id, created)");
  addIndexIfMissing(claims, "idx_claims_email_created", "CREATE INDEX IF NOT EXISTS idx_claims_email_created ON claims (email, created)");
  addIndexIfMissing(claims, "idx_claims_status_expires", "CREATE INDEX IF NOT EXISTS idx_claims_status_expires ON claims (status, expires)");

  app.save(claims);
}, (app) => {
  try {
    app.delete(app.findCollectionByNameOrId("claims"));
  } catch {}
});
