// ============================================================
//  RLS — Row-Level Security (Supabase-style)
//
//  Identity:  HMAC-SHA256 signed JWT tokens.
//             Secret lives in PropertiesService — never exposed
//             to callers.  Caller can't spoof user identity.
//
//  Ownership: Every table has an owner_id column.
//             Stamped server-side on INSERT from the verified
//             JWT.  Never accepted from the request body.
//
//  Policy:    SELECT / UPDATE / DELETE paths unconditionally
//             AND  owner_id = auth.uid()  onto whatever WHERE
//             the caller sent.  No query can escape it.
//
//  Service key (KEYS.masterKey) bypasses all policies.
// ============================================================

// ============================================================
//  JWT — create, verify, helpers
// ============================================================

function getJwtSecret() {
  const props = PropertiesService.getScriptProperties();
  var secret = props.getProperty("JWT_SECRET");
  if (!secret) {
    // Generate a cryptographically random secret on first use.
    // Two UUIDs concatenated ≈ 72 chars of entropy.
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty("JWT_SECRET", secret);
  }
  return secret;
}

/**
 * Create a signed JWT for a user.
 * Payload: { sub: userId, iat: now, exp: now+24h }
 * Permissions (gperms, tables) are looked up from __users at
 * verification time so revocations take effect immediately.
 */
function createJwt(userId) {
  var header = { alg: "HS256", typ: "JWT" };
  var now = Math.floor(Date.now() / 1000);
  var payload = {
    sub: userId,
    iat: now,
    exp: now + 86400          // 24-hour expiry
  };

  var secret = getJwtSecret();
  var headerEnc = base64UrlEncode(JSON.stringify(header));
  var payloadEnc = base64UrlEncode(JSON.stringify(payload));
  var data = headerEnc + "." + payloadEnc;
  var sigBytes = Utilities.computeHmacSha256Signature(data, secret);
  var sigEnc = base64UrlEncode(sigBytes);

  return data + "." + sigEnc;
}

/**
 * Verify a JWT and return the payload, or null if invalid/expired.
 */
function verifyJwt(token) {
  try {
    var parts = token.split(".");
    if (parts.length !== 3) return null;

    var secret = getJwtSecret();
    var data = parts[0] + "." + parts[1];

    var expectedSig = Utilities.computeHmacSha256Signature(data, secret);
    var actualSig = base64UrlDecode(parts[2]);

    // Constant-time-ish byte comparison
    if (expectedSig.length !== actualSig.length) return null;
    for (var i = 0; i < expectedSig.length; i++) {
      if (expectedSig[i] !== actualSig[i]) return null;
    }

    var payload = JSON.parse(base64UrlDecodeToString(parts[1]));

    // Check expiry
    var now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;

    return payload;
  } catch (e) {
    return null;
  }
}

// --- base64url helpers (no padding, URL-safe charset) ---

function base64UrlEncode(data) {
  var bytes = typeof data === "string"
    ? Utilities.newBlob(data).getBytes()
    : data;
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, "");
}

function base64UrlDecode(str) {
  // Restore padding and convert to standard base64
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Utilities.base64Decode(str);
}

function base64UrlDecodeToString(str) {
  return Utilities.newBlob(base64UrlDecode(str)).getDataAsString();
}

// ============================================================
//  Auth token extraction
// ============================================================

/**
 * Extract the auth token from request.
 * Precedence: Authorization: Bearer <jwt>  →  body.auth  →  x-auth-key header
 */
function extractAuthToken(body, headers) {
  body = body || {};
  headers = headers || {};

  // Authorization: Bearer <token>
  var authHeader = headers["Authorization"] || headers["authorization"] || "";
  if (authHeader && authHeader.substring(0, 7) === "Bearer ") {
    return authHeader.substring(7);
  }

  // Fallback: body.auth or x-auth-key (legacy / service key)
  return body.auth || headers["x-auth-key"] || headers["X-Auth-Key"] || "";
}

// ============================================================
//  User Context Builder
// ============================================================

/**
 * Build the user context from an auth token.
 *
 * Three tiers:
 *   1. Service key (KEYS.masterKey) → isServiceKey:true, bypasses all RLS
 *   2. Valid JWT                   → resolved user from __users, policy enforced
 *   3. Invalid / missing           → null (401)
 *
 * When RLS is toggled OFF, any valid JWT or the legacy readKey
 * gets full access (backward-compatible escape hatch).
 */
function buildUserContext(authToken) {
  if (!authToken) return null;

  // --- Service key: full bypass ---
  if (authToken === KEYS.masterKey) {
    return {
      isServiceKey: true,
      userId: null
    };
  }

  // --- RLS disabled: any valid token gets full access ---
  if (!isRlsEnabled()) {
    var valid = false;

    // Check JWT
    var jwtPayload = verifyJwt(authToken);
    if (jwtPayload && getUserById(jwtPayload.sub)) valid = true;

    // Legacy readKey fallback
    if (!valid && authToken === KEYS.readKey) valid = true;

    // Legacy plain-text key lookup (pre-migration __users)
    if (!valid) {
      var legacyUser = getUserByPlainKey(authToken);
      if (legacyUser) valid = true;
    }

    if (!valid) return null;

    return {
      isServiceKey: false,
      userId: jwtPayload ? jwtPayload.sub : null,
      rlsDisabled: true
    };
  }

  // --- RLS enabled: verify JWT, look up permissions ---
  var payload = verifyJwt(authToken);
  if (!payload) {
    // Legacy fallback: plain-text readKey
    if (authToken === KEYS.readKey) {
      return {
        isServiceKey: false,
        userId: 0,
        gperms: "r",
        tables: {}
      };
    }

    // Legacy plain-text API key (pre-JWT user)
    var legacyUser = getUserByPlainKey(authToken);
    if (legacyUser) {
      return {
        isServiceKey: false,
        userId: legacyUser._id,
        gperms: legacyUser.gperms,
        tables: legacyUser.tables
      };
    }

    return null;
  }

  // Valid JWT — look up current permissions from __users
  var user = getUserById(payload.sub);
  if (!user) return null;

  return {
    isServiceKey: false,
    userId: user._id,
    gperms: user.gperms,
    tables: user.tables
  };
}

// ============================================================
//  RLS On/Off Toggle
// ============================================================

function isRlsEnabled() {
  var config = getRlsConfigSheet();
  var data = config.getDataRange().getValues();
  if (data.length < 2) return true;   // default: enabled
  return data[1][0] !== false;
}

function setRlsEnabled(enabled) {
  var config = getRlsConfigSheet();
  config.getRange(2, 1).setValue(enabled);
}

function getRlsConfigSheet() {
  var config = SHEET.getSheetByName("__config");
  if (!config) {
    config = SHEET.insertSheet("__config");
    config.appendRow(["rls_enabled"]);
    config.getRange(2, 1).setValue(true);
    config.hideSheet();
  }
  return config;
}

// ============================================================
//  User CRUD  (__users sheet: _id | gperms | tables)
// ============================================================

function getUsersSheet() {
  var users = SHEET.getSheetByName("__users");
  if (!users) {
    users = SHEET.insertSheet("__users");
    users.appendRow(["_id", "gperms", "tables"]);
    users.hideSheet();
  }
  return users;
}

/**
 * Look up user by legacy plain-text key (pre-JWT migration).
 * Only used as fallback during transition.
 */
function getUserByPlainKey(key) {
  if (!key || key === "") return null;
  var users = getUsersSheet();
  var data = users.getDataRange().getValues();
  var headers = data[0];

  // Find the "key" column if it still exists (pre-migration __users)
  var keyCol = -1;
  for (var h = 0; h < headers.length; h++) {
    if (headers[h] === "key") { keyCol = h; break; }
  }
  if (keyCol === -1) return null;

  for (var i = 1; i < data.length; i++) {
    if (data[i][keyCol] === key) {
      return rowToUser(data[i]);
    }
  }
  return null;
}

function getUserById(id) {
  var users = getUsersSheet();
  var data = users.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === id) {
      return rowToUser(data[i]);
    }
  }
  return null;
}

/**
 * Convert a __users row to a user object.
 * Handles both migrated (3-col: _id, gperms, tables) and
 * legacy (4-col: _id, key, gperms, tables) formats.
 */
function rowToUser(row) {
  var headers = getUsersSheet().getDataRange().getValues()[0];
  var idIdx = 0;
  var gpermsIdx = headers.length === 4 ? 2 : 1;   // gperms is col 2 in new, col 3 in old
  var tablesIdx = headers.length === 4 ? 3 : 2;

  return {
    _id: row[idIdx],
    gperms: row[gpermsIdx] || "r",
    tables: parseUserTables(row[tablesIdx])
  };
}

function parseUserTables(val) {
  if (!val || val === "" || val === "{}") return {};
  if (typeof val === "object") return val;
  try { return JSON.parse(val); } catch (e) { return {}; }
}

function getNextUserId() {
  var users = getUsersSheet();
  var data = users.getDataRange().getValues();
  var maxId = 0;
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] > maxId) maxId = data[i][0];
  }
  return maxId + 1;
}

/**
 * Create an API user. Returns a signed JWT — the caller must
 * store this token.  The full token is never shown again.
 */
function createApiUser(gperms, tables) {
  var id = getNextUserId();
  var gpermVal = gperms || "r";
  var tablesVal = tables ? JSON.stringify(tables) : "";

  // __users now has 3 columns: _id | gperms | tables
  getUsersSheet().appendRow([id, gpermVal, tablesVal]);

  // Issue a JWT for this user
  var token = createJwt(id);

  return {
    _id: id,
    token: token,
    gperms: gpermVal,
    tables: tables || {},
    warning: "Store this token now — the full token is never shown again."
  };
}

function updateApiUser(id, updates) {
  var users = getUsersSheet();
  var data = users.getDataRange().getValues();
  var headers = data[0];
  var gpermsCol = headers.length === 4 ? 3 : 2;   // 1-based
  var tablesCol = headers.length === 4 ? 4 : 3;

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === id) {
      var row = i + 1;
      if (updates.gperms !== undefined) {
        users.getRange(row, gpermsCol).setValue(updates.gperms);
      }
      if (updates.tables !== undefined) {
        users.getRange(row, tablesCol).setValue(
          typeof updates.tables === "string"
            ? updates.tables
            : JSON.stringify(updates.tables)
        );
      }
      return getUserById(id);
    }
  }
  throw new Error("User " + id + " not found.");
}

function deleteApiUser(id) {
  var users = getUsersSheet();
  var data = users.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === id) {
      users.deleteRow(i + 1);
      return true;
    }
  }
  throw new Error("User " + id + " not found.");
}

function listApiUsers() {
  var users = getUsersSheet();
  var data = users.getDataRange().getValues();
  var headers = data[0];
  var hasTokenCol = false;  // New format has no "key" column

  var result = [];
  for (var i = 1; i < data.length; i++) {
    result.push({
      _id: data[i][0],
      // No key/token shown — JWTs are never displayed after creation
      gperms: headers.length >= 3 ? (data[i][headers.length === 4 ? 2 : 1] || "r") : "r",
      tables: parseUserTables(data[i][headers.length === 4 ? 3 : 2])
    });
  }
  return result;
}

/**
 * Mask a token for display. JWT tokens are long; show first 20 + last 8.
 */
function maskToken(token) {
  if (!token || token.length < 30) return "***";
  return token.substring(0, 20) + "..." + token.substring(token.length - 8);
}

// Backward-compat: old code references maskKey
function maskKey(key) {
  return maskToken(key);
}

// ============================================================
//  Permission Resolution
// ============================================================

function resolveTablePermission(user, tableName) {
  if (!user) return "r";

  // Per-table override
  if (user.tables && user.tables.hasOwnProperty(tableName)) {
    return user.tables[tableName];
  }

  // Global permission
  return user.gperms || "r";
}

function canUserWrite(user, tableName) {
  if (!user) return false;
  return resolveTablePermission(user, tableName) === "w";
}

// ============================================================
//  RLS Policy Builder
// ============================================================

/**
 * Build the RLS policy filter for a given user + table + operation.
 *
 * Returns a where-clause array (ANDed with user's where) or null
 * if no filter is needed (service key, RLS off, table has no owner_id).
 *
 * Default policy:
 *   SELECT:  owner_id = auth.uid()
 *   INSERT:  (handled via server-side stamp, no where clause needed)
 *   UPDATE:  owner_id = auth.uid()
 *   DELETE:  owner_id = auth.uid()
 *
 * Write-permission ("w") users: still scoped to their own rows
 * for UPDATE/DELETE.  INSERT is always allowed for "w" users
 * (owner_id stamped server-side).
 */
function buildRlsPolicy(ctx, table, operation) {
  // Service key bypasses all policies
  if (ctx.isServiceKey) return null;

  // RLS disabled — no policy
  if (ctx.rlsDisabled) return null;

  // Check table has owner_id column
  var schema = getSchema(table);
  var hasOwnerId = schema.some(function (c) { return c.name === "owner_id"; });
  if (!hasOwnerId) return null;

  // INSERT: owner_id stamped server-side — no where filter needed
  if (operation === "INSERT") return null;

  // SELECT / UPDATE / DELETE: enforce owner_id = auth.uid()
  // Even "w" users are scoped to their own rows for modification
  return [["owner_id", "=", ctx.userId]];
}

/**
 * Merge a user-supplied where clause with an RLS policy where clause.
 * Both are ANDed — the RLS filter is unconditional.
 *
 * userWhere: null, array [[col, op, val], ...], or object {col: val}
 * rlsWhere:  array [[col, op, val], ...] or null
 *
 * Returns the merged where clause (always array form if both present)
 * or null if neither is present.
 */
function mergeWhere(userWhere, rlsWhere) {
  if (!rlsWhere || rlsWhere.length === 0) return userWhere;
  if (!userWhere) return rlsWhere;

  // Convert userWhere to array form if it's an object
  if (Array.isArray(userWhere)) {
    return userWhere.concat(rlsWhere);
  }

  // userWhere is an object shorthand {col: val}
  var userConditions = Object.keys(userWhere).map(function (k) {
    return [k, "=", userWhere[k]];
  });
  return userConditions.concat(rlsWhere);
}

// ============================================================
//  Write-access enforcement (used for INSERT)
// ============================================================

function enforceWriteAccess(ctx, tableName) {
  if (ctx.isServiceKey) return;
  if (ctx.rlsDisabled) return;

  if (!canUserWrite(ctx, tableName)) {
    throw new Error("Write access denied on table '" + tableName + "'. Token has read-only permission.");
  }
}

// ============================================================
//  owner_id column helpers
// ============================================================

/**
 * Ensure every user table has an owner_id column.
 * Runs once on startup.  Idempotent.
 */
function ensureOwnerIdColumns() {
  var tables = listTables();
  tables.forEach(function (tableName) {
    var schema = getSchema(tableName);
    if (schema.some(function (c) { return c.name === "owner_id"; })) return;

    // Add owner_id to schema after _id
    var sheet = getTable(tableName);
    var idIndex = schema.findIndex(function (c) { return c.name === "_id"; });

    schema.splice(idIndex + 1, 0, {
      name: "owner_id",
      type: "number",
      required: false
    });

    // Insert column in sheet after _id (1-based)
    sheet.insertColumnAfter(idIndex + 1);
    sheet.getRange(1, idIndex + 2).setValue("owner_id");

    // Existing rows get null owner_id (service key must backfill)
    var rows = sheet.getLastRow();
    if (rows > 1) {
      var emptyVals = [];
      for (var r = 1; r < rows; r++) {
        emptyVals.push([""]);
      }
      sheet.getRange(2, idIndex + 2, rows - 1, 1).setValues(emptyVals);
    }

    updateTableMeta(tableName, {
      schema: schema,
      modified: new Date()
    });
  });
}

/**
 * Migrate __users sheet from legacy 4-column format
 * (_id | key | gperms | tables) to new 3-column format
 * (_id | gperms | tables).
 */
function migrateUsersSheet() {
  var users = getUsersSheet();
  var data = users.getDataRange().getValues();
  if (data.length === 0) return;
  if (data[0].length <= 3) return;  // Already migrated or no "key" column

  // Check if "key" column exists
  if (data[0][1] !== "key") return;

  // Delete the "key" column (column B = index 2 in 1-based)
  users.deleteColumn(2);
}

// ============================================================
//  Legacy _keys column removal (replaced by owner_id)
// ============================================================

/**
 * Strip _keys from query results for non-service keys.
 * owner_id is kept — it's the user's own ID, safe to see.
 */
function stripSensitiveColumns(rows, isServiceKey) {
  if (isServiceKey) return rows;
  return rows.map(function (row) {
    var clean = {};
    for (var key in row) {
      if (key !== "_keys") clean[key] = row[key];
    }
    return clean;
  });
}

// ============================================================
//  Legacy _keys migration (kept for backward compat)
//  New tables use owner_id, not _keys.
// ============================================================

function needsKeysMigration() {
  try {
    var tables = listTables();
    for (var i = 0; i < tables.length; i++) {
      var schema = getSchema(tables[i]);
      // Check for owner_id first (new system)
      if (!schema.some(function (c) { return c.name === "owner_id"; })) {
        return true;
      }
    }
  } catch (e) {
    return false;
  }
  return false;
}

function migrateExistingTables() {
  ensureOwnerIdColumns();
  migrateUsersSheet();
}
