# SheetsDB Bugs & Fixes

Comprehensive list of bugs found during logic verification, organized by severity and module.

---

## 🔴 CRITICAL — Must Fix Before Production

### 1. `in` Operator Never Matched (Query.js:107-118)

**Problem:** The `parseCondition` function checks operators in order: `startsWith`, `endsWith`, `contains`, `!=`, `>=`, `<=`, `>`, `<`, `=`, `in`. Since `in` is last, a condition like `tags=in:[a,b]` matches the `=` operator first (at `tags=in:[a,b]`), parsing as column=`tags`, operator=`=`, value=`in:[a,b]`.

**Impact:** `in` operator is completely broken. Users cannot filter by array membership.

**Fix:** Move `in` before `=` in the operators array, OR detect `in:` prefix explicitly.

```javascript
// Query.js line 107-118 — change operators order:
const operators = [
    "startsWith",
    "endsWith", 
    "contains",
    "!=",
    ">=",
    "<=",
    ">",
    "<",
    "in",        // <-- MOVE BEFORE "="
    "="
];
```

**Alternative fix** (more robust): Check for `in:` pattern before single-char operators.

---

### 2. `changeColumnType` Doesn't Convert Existing Data (Schema.js:155-172)

**Problem:** `changeColumnType` updates the schema metadata but leaves existing cell values unchanged. Changing `age` from `number` to `string` leaves numbers in cells; subsequent reads may fail validation or return wrong types.

**Impact:** Data corruption, read errors, silent type mismatches.

**Fix:** Add data conversion during type change. Options:

```javascript
// Schema.js changeColumnType — add after line 165 (col.type = newType):
function changeColumnType(table, column, newType) {
    // ... existing validation ...
    
    const sheet = getTable(table);
    const schema = getSchema(table);
    const col = schema.find(c => c.name === column);
    const colIndex = schema.findIndex(c => c.name === column) + 1; // 1-based
    
    // Convert existing data
    const data = sheet.getDataRange().getValues();
    if (data.length > 1) {
        const converted = data.slice(1).map(row => {
            const val = row[colIndex - 1];
            try {
                return [validateValue(val, { name: column, type: newType })];
            } catch (e) {
                // Conversion failed — decide: throw, use default, or keep original
                throw new Error(`Cannot convert row ${data.indexOf(row)+2} column '${column}': ${e.message}`);
            }
        });
        sheet.getRange(2, colIndex, converted.length, 1).setValues(converted);
    }
    
    col.type = newType;
    updateTableMeta(table, { schema, modified: new Date() });
    return col;
}
```

**Note:** This makes the operation slow for large tables. Consider adding a `force` flag or background job for production.

---

### 3. `owner_id` / `_keys` Not Reserved (Tables.js:145-153)

**Problem:** `RESERVED_COLUMNS` = `["_id", "__row", "__deleted"]` but `createTable` auto-adds `owner_id` and `_keys`. User can define their own `owner_id` column, causing duplicate columns and schema corruption.

**Impact:** Table creation succeeds but schema has duplicate `owner_id` — breaks queries, inserts, RLS.

**Fix:** Add to `RESERVED_COLUMNS`:

```javascript
// Tables.js line 6-10
const RESERVED_COLUMNS = [
    "_id",
    "__row", 
    "__deleted",
    "owner_id",    // <-- ADD
    "_keys"        // <-- ADD
];
```

---

### 4. Empty String for `owner_id` (Number Column) — Multiple Locations

**Problem:** `owner_id` column type is `number` but code writes `""` (empty string) for service-key inserts and pre-migration rows.

| Location | Code |
|----------|------|
| CRUD.js:33 | `value = (ownerId != null) ? ownerId : "";` |
| CRUD.js:87 | `return (ownerId != null) ? ownerId : "";` |
| RLS.js:564 | `emptyVals.push([""]);` |

**Impact:** Type mismatch in sheet. `validateValue` for `number` throws on `""`. Reads return `""` string instead of number/null.

**Fix:** Use `null` (blank cell) instead of `""`:

```javascript
// CRUD.js line 33, 87
value = (ownerId != null) ? ownerId : null;  // null → blank cell in Sheets

// RLS.js line 564
emptyVals.push([null]);  // or just [] since setValues handles null
```

**Note:** Google Sheets treats `null` as blank cell. `validateValue` for `number` at Schema.js:191-195 returns `""` for null/undefined (line 217-218), but that's for *input* validation. For stored values, blank cell = `null` when read.

---

### 5. `listTables()` Accessible Without Auth (code.js:143-146)

**Problem:** `handleGet` for `_tables` allows unauthenticated `listTables()` call when RLS enabled. Only `describeTable` checks service key.

**Impact:** Table names exposed to unauthorized users.

**Fix:** Add auth check:

```javascript
// code.js line 143-146
if (path === '_tables') {
    if (!ctx.isServiceKey) return error('Service key required for table management', 403);
    if (params?.name) return success(describeTable(params.name));
    return success(listTables());
}
```

**Alternative:** If table listing should be public, document it explicitly and keep current behavior.

---

## 🟠 HIGH — Significant Issues

### 6. `remove()` Re-sequences `_id` (CRUD.js:279-285)

**Problem:** After deletion, `_id` values are reassigned sequentially (1, 2, 3...). This **breaks referential integrity** — any foreign keys pointing to deleted rows now point to wrong records.

**Impact:** Data corruption in relational data. `_id` is primary key; changing it violates relational model.

**Fix Options:**

**Option A — Keep gaps (recommended):**
```javascript
// CRUD.js remove() — REMOVE lines 279-285 entirely
// Just delete rows, don't renumber _id
```

**Option B — Make it configurable:**
```javascript
// Add parameter: remove(table, where, rlsWhere, { resequenceIds: false })
// Default false for safety
```

**Option C — Add warning in docs:** Document that `_id` is not stable after deletions.

---

### 7. `count()` / `exists()` Fetch All Rows (CRUD.js:303-309)

**Problem:** Both call `select()` with no limit, fetching ALL matching rows into memory just to count them.

**Impact:** O(n) memory and time on large tables. Will hit Apps Script 6min timeout on ~50k+ rows.

**Fix:** Add optimized count using sheet formulas or direct range inspection:

```javascript
// CRUD.js — add new function:
function countFast(table, where, rlsWhere) {
    const sheet = getTable(table);
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return 0;
    
    const headers = data[0];
    const effectiveWhere = mergeWhere(where, rlsWhere);
    
    let count = 0;
    for (let r = 1; r < data.length; r++) {
        const row = {};
        headers.forEach((h, c) => row[h] = data[r][c]);
        if (matchesWhere(row, effectiveWhere)) count++;
    }
    return count;
}

// Then update count/exists:
function count(table, where, rlsWhere) {
    return countFast(table, where, rlsWhere);
}
function exists(table, where, rlsWhere) {
    return countFast(table, where, rlsWhere) > 0;
}
```

This avoids creating row objects for projection/sort/limit.

---

### 8. Auto-generated JWT Secret Invalidates Tokens on Redeploy (RLS.js:23-33)

**Problem:** `getJwtSecret()` generates a new secret on first use if not set in ScriptProperties. Any redeployment or property reset invalidates ALL existing JWTs.

**Impact:** All users logged out unexpectedly after deploy.

**Fix:** Document that `JWT_SECRET` **must** be set manually in Script Properties before first production deploy. Or auto-generate once and never change:

```javascript
// RLS.js getJwtSecret() — add warning comment:
function getJwtSecret() {
    const props = PropertiesService.getScriptProperties();
    var secret = props.getProperty("JWT_SECRET");
    if (!secret) {
        // WARNING: Only runs once! Set JWT_SECRET in Script Properties for production.
        // Redeployment without JWT_SECRET set will invalidate all tokens.
        secret = Utilities.getUuid() + Utilities.getUuid();
        props.setProperty("JWT_SECRET", secret);
    }
    return secret;
}
```

**Production Checklist Addition:** 
- [ ] Set `JWT_SECRET` in Script Properties before first deploy
- [ ] Never clear Script Properties

---

### 9. `readKey` Fallback Gets `owner_id = 0` (RLS.js:488-489, 190-196)

**Problem:** When RLS enabled, legacy `readKey` fallback creates context with `userId: 0`. `buildRlsPolicy` returns `owner_id = 0`, matching rows inserted by service key (which get `owner_id = null/""`).

**Impact:** Read-only legacy key can see service-key-created rows.

**Fix:** Service key inserts should use a distinct owner_id (e.g., `-1` or `null` that doesn't match 0):

```javascript
// CRUD.js insert/insertMany — for service key (ownerId === null):
// Use a sentinel value that no real user has
const SERVICE_OWNER_ID = -1;  // or null, but handle in RLS policy

// In buildRlsPolicy (RLS.js:488):
// Exclude SERVICE_OWNER_ID from user matches
if (ctx.userId === 0 || ctx.userId === SERVICE_OWNER_ID) {
    // readKey or service key rows — no RLS filter for these
    return null;  // or handle specially
}
```

**Simpler fix:** Don't allow `readKey` fallback when RLS enabled. Force JWT migration.

---

### 10. `in` Operator Parsing Breaks on Quoted Commas (Query.js:134-140)

**Problem:** `tags=in:["a,b","c"]` splits on comma inside quotes, producing `["a,b"`, `"c"]` instead of `["a,b", "c"]`.

**Impact:** Cannot use `in` with values containing commas.

**Fix:** Use proper CSV parsing or JSON.parse for array:

```javascript
// Query.js parseCondition — replace lines 134-140:
if (operator === "in") {
    // Try parsing as JSON array first
    try {
        value = JSON.parse(value);
        if (!Array.isArray(value)) throw new Error();
    } catch (e) {
        // Fallback: simple comma split (no quote support)
        value = value
            .replace(/^\[/, "")
            .replace(/\]$/, "")
            .split(",")
            .map(v => parseValue(v.trim()));
    }
}
```

**Better:** Require JSON array format for `in`: `tags=in:["a","b"]` and use `JSON.parse` exclusively.

---

## 🟡 MEDIUM — Should Fix

### 11. `validateValue` for `json` Rejects String Input (Schema.js:211-214)

**Problem:** API receives JSON as object (parsed from request body). But if client sends stringified JSON, `validateValue` throws: `typeof value === "object" && value !== null` fails for string.

**Impact:** Clients must send objects, not JSON strings. Inconsistent with other types that accept strings.

**Fix:** Accept and parse JSON strings:

```javascript
// Schema.js validateValue — case "json":
case "json": {
    if (typeof value === "object" && value !== null) return value;
    if (typeof value === "string") {
        try { return JSON.parse(value); } catch (e) {}
    }
    throw new Error(`Column '${name}' expects a JSON object/array. Got: ${JSON.stringify(value)}`);
}
```

---

### 12. Migration `migrateUsersSheet` Deletes Wrong Column (RLS.js:581-592)

**Problem:** `users.deleteColumn(2)` assumes "key" column is always column B. If headers changed or multiple migrations run, deletes wrong column.

**Fix:** Find column by header name:

```javascript
// RLS.js migrateUsersSheet()
function migrateUsersSheet() {
    var users = getUsersSheet();
    var data = users.getDataRange().getValues();
    if (data.length === 0) return;
    if (data[0].length <= 3) return;
    
    // Find "key" column index
    var keyCol = -1;
    for (var h = 0; h < data[0].length; h++) {
        if (data[0][h] === "key") { keyCol = h; break; }
    }
    if (keyCol === -1) return;
    
    // Delete by 1-based index
    users.deleteColumn(keyCol + 1);
}
```

---

### 13. No Constraint Enforcement (UNIQUE, NOT NULL)

**Problem:** Schema supports `unique: true` and `required: true` in column definitions (per PLAN.md and createTable), but `insert`/`update` never validate them.

**Impact:** Duplicate emails, null required fields silently allowed.

**Fix:** Add validation in `insert` and `update`:

```javascript
// CRUD.js insert() — after building row, before append:
schema.forEach(column => {
    if (column.required && (row[colIndex] === "" || row[colIndex] === null)) {
        throw new Error(`Column '${column.name}' is required`);
    }
    if (column.unique) {
        // Check existing values — slow but necessary
        const colIndex = schema.findIndex(c => c.name === column.name);
        const existing = sheet.getRange(2, colIndex + 1, sheet.getLastRow() - 1, 1).getValues();
        if (existing.flat().includes(row[colIndex])) {
            throw new Error(`Column '${column.name}' must be unique`);
        }
    }
});
```

**Note:** UNIQUE check is O(n). Consider indexes for performance.

---

### 14. Cross-Module Load Order Dependency Risk

**Problem:** All modules use global scope. `CRUD.js` calls `mergeWhere` (RLS.js), `RLS.js` calls `getSchema` (Schema.js), `Schema.js` calls `getTableMeta` (Tables.js). While function declarations are hoisted, `const` variables at top-level could have Temporal Dead Zone issues if initialization order matters.

**Current State:** No top-level `const` cross-references found. But risk exists if added.

**Fix:** Document load order independence, or use a single namespace object:

```javascript
// At top of each file:
var SheetsDB = SheetsDB || {};

// Then:
SheetsDB.Tables = { createTable, dropTable, ... };
SheetsDB.Schema = { addColumn, validateValue, ... };
// etc.
```

---

## 🟢 LOW — Nice to Fix

### 15. `needsKeysMigration()` Runs on Every Request (code.js:72-74)

**Problem:** Checks all tables for `owner_id` on every request until migration runs once.

**Fix:** Cache result in ScriptProperties or global variable:

```javascript
// code.js
var MIGRATION_CHECKED = false;
function handleRequest(...) {
    if (!MIGRATION_CHECKED) {
        MIGRATION_CHECKED = true;
        if (needsKeysMigration()) migrateExistingTables();
    }
}
```

---

### 16. `listTables()` Re-scans All Sheets Every Call (Tables.js:271-277)

**Problem:** Calls `SHEET.getSheets()` and filters every time.

**Fix:** Cache with invalidation on create/drop/rename:

```javascript
// Tables.js
var _tablesCache = null;
var _tablesCacheTime = 0;
const CACHE_TTL = 60000; // 1 min

function listTables() {
    const now = Date.now();
    if (_tablesCache && (now - _tablesCacheTime) < CACHE_TTL) {
        return _tablesCache;
    }
    ensureSystemSheets();
    _tablesCache = SHEET.getSheets()
        .map(s => s.getName())
        .filter(n => !n.startsWith("__"));
    _tablesCacheTime = now;
    return _tablesCache;
}

// Invalidate in createTable, dropTable, renameTable:
_tablesCache = null;
```

---

### 17. No Request Size Limits / Rate Limiting

**Problem:** Large payloads or DoS possible. Apps Script has quotas but no app-level protection.

**Fix:** Add in `handleRequest`:

```javascript
// code.js handleRequest() — early:
const MAX_BODY_SIZE = 100 * 1024; // 100KB
if (e.postData && e.postData.contents.length > MAX_BODY_SIZE) {
    return error("Request body too large", 413);
}
```

---

### 18. Missing Features from PLAN.md

| Feature | Status | Priority |
|---------|--------|----------|
| `reorderColumns` | Not implemented | Low |
| `distinct` | Not implemented | Low |
| `aggregate` | Not implemented | Low |
| Batch operations (multi-statement) | Not implemented | Medium |
| Index utilization | `__indexes` sheet created, unused | Medium |
| UNIQUE/NOT NULL enforcement | Schema supports, not enforced | High |

---

## 📋 Fix Priority Order

1. **Critical #1** — `in` operator broken (Query.js)
2. **Critical #2** — `changeColumnType` data corruption (Schema.js)
3. **Critical #3** — `owner_id` not reserved (Tables.js)
4. **Critical #4** — Empty string for number column (CRUD.js, RLS.js)
5. **Critical #5** — Unauthenticated table listing (code.js)
6. **High #6** — `_id` re-sequencing breaks FKs (CRUD.js)
7. **High #7** — Slow count/exists (CRUD.js)
8. **High #8** — JWT secret rotation (RLS.js) — *documentation fix*
9. **High #9** — readKey sees service rows (RLS.js)
10. **High #10** — `in` parsing with quotes (Query.js)
11. **Medium #11** — JSON string input (Schema.js)
12. **Medium #12** — Migration column delete (RLS.js)
13. **Medium #13** — Constraint enforcement (CRUD.js)
14. **Low #15-18** — Performance, missing features

---

## 🧪 Testing Recommendations

After fixes, add tests for:

```javascript
// Test cases to verify:
1. in operator: where=tags=in:["a","b"] returns correct rows
2. changeColumnType: number→string converts existing values
3. createTable with owner_id column throws error
4. Service key insert: owner_id is blank (not "")
5. Unauthenticated _tables request returns 403
6. Delete doesn't renumber _id (or document it does)
7. count() on 10k rows completes < 1s
8. JWT_SECRET set → redeploy → tokens still valid
9. readKey with RLS enabled returns 401 (or no service rows)
10. in operator with quoted commas works
11. insert with duplicate unique column throws
12. insert missing required column throws
```

---

## 📝 Files to Modify

| File | Functions to Fix |
|------|------------------|
| `Query.js` | `parseCondition` (operators order, in parsing) |
| `Schema.js` | `changeColumnType` (data conversion), `validateValue` (json string) |
| `Tables.js` | `RESERVED_COLUMNS` array, `listTables` caching |
| `CRUD.js` | `insert`/`insertMany` (owner_id null), `remove` (no resequence), `count`/`exists` (optimized) |
| `RLS.js` | `getJwtSecret` (docs), `migrateUsersSheet` (find column), `buildRlsPolicy` (readKey handling), `ensureOwnerIdColumns` (null not "") |
| `code.js` | `handleGet` `_tables` auth check, `handleRequest` migration cache |

---

*Generated from logic verification on 2026-08-29*