# SheetsDB Documentation

SheetsDB turns Google Sheets into a functional database with a REST API, Row-Level Security (RLS), JWT authentication, schema management, and SQL-like query capabilities.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Quick Start](#quick-start)
3. [Authentication](#authentication)
4. [API Reference](#api-reference)
   - [Table Management](#table-management)
   - [Schema Management](#schema-management)
   - [Data Operations (CRUD)](#data-operations-crud)
   - [Query Parameters](#query-parameters)
   - [Row-Level Security (RLS)](#row-level-security-rls)
5. [Data Types & Validation](#data-types--validation)
6. [Error Handling](#error-handling)
7. [Demo Site](#demo-site)
8. [Deployment](#deployment)
9. [Best Practices](#best-practices)
10. [Migration & Upgrades](#migration--upgrades)

---

## Architecture Overview

```
HTTP Request
      │
      ▼
API Router (code.js:doPost)
      │
      ▼
Authentication (RLS.js:extractAuthToken, buildUserContext)
      │
      ▼
Database Engine (Tables.js, Schema.js, Query.js, CRUD.js)
      │
      ▼
Google Sheets (via SpreadsheetApp)
```

### System Sheets (Hidden)

| Sheet | Purpose |
|-------|---------|
| `__tables` | Table metadata: name, created, modified, schema (JSON), next auto-increment ID |
| `__indexes` | Index definitions (reserved for future use) |
| `__users` | API users: `_id`, `gperms` (global permission), `tables` (per-table overrides as JSON) |
| `__config` | RLS configuration: `rls_enabled` boolean |

### User Data Tables

Every user-created table automatically includes these reserved columns:
- `_id` — Auto-incrementing primary key (number)
- `owner_id` — Row owner user ID (number, for RLS)
- `_keys` — Legacy column (JSON array, being phased out in favor of `owner_id`)

---

## Quick Start

### Prerequisites

- Google Account
- Google Sheet created
- Node.js + npm (for Clasp CLI)

### Setup Steps

1. **Create Google Sheet & Apps Script**
   - Open your Google Sheet
   - Extensions → Apps Script
   - This creates a bound script project

2. **Enable Apps Script API**
   - Go to <https://script.google.com/home/usersettings>
   - Enable "Google Apps Script API"

3. **Clone & Configure**
   ```bash
   git clone https://github.com/Arnav-Saraf-Official/sheetsDB.git
   cd sheetsDB
   npm install @google/clasp -g
   clasp login
   ```

4. **Get Script ID**
   - In Apps Script editor: Project Settings → Script ID
   - Copy `.example.clasp.json` to `.clasp.json` and paste the Script ID

5. **Push Code**
   ```bash
   cd appsScript
   clasp push
   ```

6. **Configure Secrets** (Script Properties)
   - Apps Script Editor → File → Project Properties → Script Properties
   - Add:
     - `MASTER_KEY` — Secure random string (e.g., `openssl rand -hex 32`). Full admin access.
     - `READ_KEY` — (Optional) Legacy read-only key for backward compatibility.
     - `JWT_SECRET` — Auto-generated on first use if not set.

   > **Never commit these values.** The app reads them from `PropertiesService.getScriptProperties()` at runtime. If `MASTER_KEY` is unset or still the placeholder, the API refuses all requests (fail closed).

7. **Deploy as Web App**
   - Apps Script Editor → Deploy → New Deployment
   - Type: Web App
   - Execute as: **User deploying the web app**
   - Who has access: **Anyone** (or "Anyone with link")
   - Copy the deployment URL

8. **Test with Demo Site**
   ```bash
   cd demoSite
   python -m http.server 8080
   ```
   Open <http://localhost:8080>, enter your deployment URL and `MASTER_KEY` as the auth key.

---

## Authentication

SheetsDB supports three authentication tiers:

### 1. Service Key (Full Admin)
- Value: `MASTER_KEY` from Script Properties
- Header: `Authorization: Bearer <MASTER_KEY>` or `x-auth-key: <MASTER_KEY>`
- Bypasses all RLS policies
- Can manage tables, schema, and RLS users

### 2. JWT Token (RLS Enforced)
- Issued via `POST /_rls` with service key
- Header: `Authorization: Bearer <jwt_token>`
- Payload: `{ sub: userId, iat: timestamp, exp: timestamp+24h }`
- Signed with HMAC-SHA256 using `JWT_SECRET` from Script Properties
- Permissions looked up from `__users` at verification time (revocation is immediate)
- 24-hour expiry

### 3. Legacy Keys (Backward Compatibility)
- `READ_KEY` from Script Properties (read-only when RLS disabled)
- Plain-text keys stored in legacy `__users` format (pre-migration)
- **Deprecated** — migrate to JWT

### Token Extraction Priority
```javascript
// 1. Authorization: Bearer <token>
const authHeader = headers["Authorization"] || headers["authorization"];
if (authHeader.startsWith("Bearer ")) return authHeader.slice(7);

// 2. Body: { auth: "..." }
if (body.auth) return body.auth;

// 3. Header: x-auth-key
return headers["x-auth-key"] || headers["X-Auth-Key"] || "";
```

### Permission Model

| Permission | Value | Description |
|------------|-------|-------------|
| Read | `r` | SELECT only |
| Write | `w` | SELECT + INSERT/UPDATE/DELETE (scoped to own rows) |

Per-table overrides in `tables` JSON:
```json
{
  "users": "w",
  "orders": "r"
}
```
Global permission (`gperms`) applies to tables not explicitly listed.

---

## API Reference

All requests are **POST** to the web app URL with a `_method` parameter or body field.

**Base URL**: `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`

### Request Format
```json
POST /exec
Content-Type: text/plain
Authorization: Bearer <token>

{
  "_method": "GET|POST|PUT|DELETE",
  "table": "table_name",
  "where": "...",
  "values": { ... },
  "record": { ... },
  "records": [ ... ],
  "sort": "column|-column",
  "select": "col1,col2",
  "limit": 50,
  "offset": 0
}
```

### Response Format
```json
// Success
{ "success": true, "data": ..., "id": 123, "inserted": 5, "updated": 2, "deleted": 1 }

// Error
{ "error": true, "message": "Error description", "code": 400 }
```

---

### Table Management

#### List Tables
```http
GET /exec?table=_tables
```
```json
// Response
{ "success": true, "data": ["users", "orders", "products"] }
```

#### Describe Table
```http
GET /exec?table=_tables&name=users
```
```json
// Response
{
  "success": true,
  "data": {
    "table": "users",
    "rows": 42,
    "columns": [
      { "name": "_id", "type": "number", "primary": true, "autoIncrement": true, "unique": true, "required": true },
      { "name": "owner_id", "type": "number", "required": false },
      { "name": "_keys", "type": "json", "default": [] },
      { "name": "name", "type": "string" },
      { "name": "email", "type": "string", "unique": true },
      { "name": "age", "type": "number" },
      { "name": "created_at", "type": "date", "default": "NOW" }
    ]
  }
}
```

#### Create Table
```http
POST /exec
{
  "_method": "POST",
  "table": "_tables",
  "name": "users",
  "columns": [
    { "name": "name", "type": "string", "required": true },
    { "name": "email", "type": "string", "unique": true },
    { "name": "age", "type": "number" },
    { "name": "created_at", "type": "date", "default": "NOW" }
  ]
}
```
- Requires service key
- Auto-adds `_id`, `owner_id`, `_keys` columns
- Column names must start with letter, contain only alphanumeric/underscore

#### Drop Table
```http
DELETE /exec
{
  "_method": "DELETE",
  "table": "_tables",
  "name": "users"
}
```
- Requires service key
- Permanently deletes sheet and metadata

#### Rename Table
```http
PUT /exec
{
  "_method": "PUT",
  "table": "_tables",
  "oldName": "users",
  "newName": "members"
}
```
- Requires service key

---

### Schema Management

#### Add Column
```http
POST /exec
{
  "_method": "POST",
  "table": "_schema",
  "table": "users",
  "column": { "name": "phone", "type": "string" }
}
```
- Requires service key
- Types: `string`, `number`, `boolean`, `date`, `json`
- Optional: `default`, `required`, `unique`

#### Remove Column
```http
DELETE /exec
{
  "_method": "DELETE",
  "table": "_schema",
  "table": "users",
  "column": "phone"
}
```
- Requires service key
- Cannot remove `_id`

#### Rename Column
```http
PUT /exec
{
  "_method": "PUT",
  "table": "_schema",
  "table": "users",
  "oldName": "phone",
  "newName": "mobile"
}
```
- Requires service key
- Cannot rename `_id`

#### Change Column Type
```http
PUT /exec
{
  "_method": "PUT",
  "table": "_schema",
  "table": "users",
  "column": "age",
  "type": "string"
}
```
- Requires service key
- Valid types: `string`, `number`, `boolean`, `date`, `json`

---

### Data Operations (CRUD)

All data operations target a user table (not system tables).

#### Query / Select
```http
GET /exec?table=users&where=age>18&sort=-name&limit=10&offset=0&select=name,email
```
```http
POST /exec
{
  "_method": "GET",
  "table": "users",
  "where": "age>18;name=John",
  "sort": "-created_at",
  "limit": 10,
  "offset": 0,
  "select": "name,email"
}
```
- RLS policy `owner_id = auth.uid()` automatically ANDed for non-service keys
- Returns array of objects

#### Insert Single Record
```http
POST /exec
{
  "_method": "POST",
  "table": "users",
  "name": "John",
  "email": "john@example.com",
  "age": 30
}
```
```json
// Response
{ "success": true, "id": 42 }
```
- `_id` auto-assigned
- `owner_id` stamped server-side from JWT (null for service key)
- Missing columns use defaults or empty string

#### Bulk Insert
```http
POST /exec
{
  "_method": "POST",
  "table": "users",
  "records": [
    { "name": "John", "email": "john@example.com", "age": 30 },
    { "name": "Jane", "email": "jane@example.com", "age": 25 }
  ]
}
```
```json
// Response
{ "success": true, "inserted": 2 }
```
- Much faster than individual inserts

#### Update Records
```http
PUT /exec
{
  "_method": "PUT",
  "table": "users",
  "where": "id=42",
  "values": { "email": "john.new@example.com" }
}
```
```json
// Response
{ "success": true, "updated": 1 }
```
- RLS policy `owner_id = auth.uid()` automatically ANDed
- `owner_id` cannot be updated via request body

#### Delete Records
```http
DELETE /exec
{
  "_method": "DELETE",
  "table": "users",
  "where": "id=42"
}
```
```json
// Response
{ "success": true, "deleted": 1 }
```
- RLS policy `owner_id = auth.uid()` automatically ANDed
- `_id` values re-sequenced after deletion (no gaps)

---

### Query Parameters

All query parameters can be passed as URL query string (GET) or in request body (POST).

| Parameter | Type | Description |
|-----------|------|-------------|
| `where` | string/object/array | Filter conditions |
| `sort` | string | Sort column, prefix `-` for descending |
| `select` | string/array | Columns to return (comma-separated) |
| `limit` | integer | Max rows to return |
| `offset` | integer | Rows to skip |

#### Where Clause Formats

**String (simple):**
```
?where=age>18
?where=name=John;age>=18
?where=email=john@example.com
```

**Array (explicit):**
```json
"where": [
  ["age", ">", 18],
  ["name", "=", "John"]
]
```

**Object (equality shorthand):**
```json
"where": { "age": 18, "name": "John" }
```

#### Supported Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `=` | Equal | `age=25` |
| `!=` | Not equal | `status!=deleted` |
| `>` | Greater than | `age>18` |
| `<` | Less than | `price<100` |
| `>=` | Greater or equal | `age>=18` |
| `<=` | Less or equal | `price<=100` |
| `contains` | Substring match | `email=contains:@gmail.com` |
| `startsWith` | Prefix match | `name=startsWith:Jo` |
| `endsWith` | Suffix match | `email=endsWith:.com` |
| `in` | In array | `status=in:[active,pending]` |

#### Sort Examples
```
?sort=name           // Ascending
?sort=-created_at    // Descending
```

#### Select Examples
```
?select=name,email
?select=["name","email"]
```

---

### Row-Level Security (RLS)

RLS enforces row ownership: users can only access their own rows.

#### Enable/Disable RLS (Service Key Only)
```http
GET /exec?table=_rls&toggle=on
GET /exec?table=_rls&toggle=off
GET /exec?table=_rls&status=1
```

#### Create API User (Service Key Only)
```http
POST /exec
{
  "_method": "POST",
  "table": "_rls",
  "gperms": "r",
  "tables": { "users": "w", "orders": "r" }
}
```
```json
// Response — SAVE THE TOKEN IMMEDIATELY (never shown again)
{
  "success": true,
  "data": {
    "_id": 1,
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "gperms": "r",
    "tables": { "users": "w", "orders": "r" },
    "warning": "Store this token now — the full token is never shown again."
  }
}
```

#### List Users (Service Key Only)
```http
GET /exec?table=_rls
```

#### Get User (Service Key Only)
```http
GET /exec?table=_rls&id=1
```

#### Update User (Service Key Only)
```http
PUT /exec
{
  "_method": "PUT",
  "table": "_rls",
  "id": 1,
  "gperms": "w",
  "tables": { "users": "w", "orders": "w" }
}
```

#### Delete User (Service Key Only)
```http
DELETE /exec
{
  "_method": "DELETE",
  "table": "_rls",
  "id": 1
}
```

#### RLS Policy Behavior

| Operation | Policy Applied |
|-----------|----------------|
| `SELECT` | `WHERE owner_id = auth.uid()` ANDed with user's where |
| `INSERT` | `owner_id` stamped server-side from JWT (no where needed) |
| `UPDATE` | `WHERE owner_id = auth.uid()` ANDed with user's where |
| `DELETE` | `WHERE owner_id = auth.uid()` ANDed with user's where |

- Service key bypasses all policies
- When RLS disabled: any valid token gets full read+write access (legacy mode)
- Write permission (`w`) still scopes UPDATE/DELETE to own rows

---

## Data Types & Validation

| Type | Input Accepted | Stored As | Notes |
|------|----------------|-----------|-------|
| `string` | Any | String | Default if not specified |
| `number` | Number or numeric string | Number | `NaN` throws error |
| `boolean` | `true`/`false`, `"true"`/`"false"`, `1`/`0` | Boolean | |
| `date` | `Date` object, ISO string, timestamp | Date | Invalid throws error |
| `json` | Object or array | JSON string in sheet | Parsed on read |

### Default Values
```json
{ "name": "created_at", "type": "date", "default": "NOW" }
{ "name": "tags", "type": "json", "default": [] }
{ "name": "status", "type": "string", "default": "active" }
```

### Validation Rules
- Column names: must start with letter, only alphanumeric/underscore
- Reserved: `_id`, `__row`, `__deleted`, `owner_id`, `_keys`
- `_id` is required in schema (auto-added on table creation)

---

## Error Handling

All errors return HTTP 200 with JSON error body:

```json
{
  "error": true,
  "message": "Descriptive error message",
  "code": 400
}
```

| Code | Meaning |
|------|---------|
| 400 | Bad request (validation, missing params) |
| 401 | Unauthorized (invalid/missing token) |
| 403 | Forbidden (service key required, write denied) |
| 404 | Not found (table, user) |
| 405 | Method not allowed |
| 500 | Internal server error |
| 503 | Service unavailable (keys not configured) |

### Common Errors
- `"MASTER_KEY is unset or still the placeholder"` — Configure Script Properties
- `"Unauthorized — provide a valid JWT token or service key"` — Invalid/missing auth
- `"Write access denied on table 'X'. Token has read-only permission."` — Need `w` permission
- `"Table 'X' does not exist"` — Check table name
- `"Column 'X' does not exist"` — Check column name
- `"Invalid where clause"` — Check where syntax

---

## Demo Site

The `demoSite/` folder contains a single-page UI for testing.

### Features
- Connection test with key type detection (Service/JWT/Legacy)
- Table management (create, list, describe, rename, drop)
- Query builder (where, sort, select, limit, offset)
- Insert / Bulk insert / Update / Delete forms
- Schema management (add/remove/rename columns, change type)
- RLS management (enable/disable, create/list/update/delete users)
- LocalStorage persistence of API URL and auth key
- Keyboard shortcut: `Ctrl/Cmd+Enter` to submit active form

### Usage
```bash
cd demoSite
python -m http.server 8080
# Open http://localhost:8080
```
Enter your web app URL and auth key (service key or JWT), click **Connect**.

---

## Deployment

### Production Checklist
- [ ] `MASTER_KEY` set to strong random value in Script Properties
- [ ] `JWT_SECRET` set (or allow auto-generation)
- [ ] `READ_KEY` removed or set to strong value (legacy only)
- [ ] Web App deployed with "Execute as: User deploying" and "Anyone" access
- [ ] CORS handled (Apps Script web apps allow cross-origin by default)
- [ ] Demo site not exposed publicly (or behind auth)

### Clasp Commands
```bash
cd appsScript
clasp push              # Push local changes
clasp pull              # Pull remote changes
clasp deploy            # Create/update deployment
clasp deployments       # List deployments
clasp logs              # View execution logs
clasp open              # Open Apps Script editor
```

### Wrangler Alternative
For Cloudflare Workers deployment (not included), you'd need to port the logic to Workers + D1/R2.

---

## Best Practices

### Security
1. **Always use service key for admin operations** — never expose it client-side
2. **Issue JWT tokens per user** — store securely, rotate periodically
3. **Enable RLS** for multi-tenant data isolation
4. **Use per-table permissions** — grant `w` only where needed
5. **Monitor `__users` sheet** for unexpected entries

### Performance
1. **Use bulk insert** (`insertMany`) for multiple records
2. **Select only needed columns** (`?select=col1,col2`)
3. **Paginate large results** (`limit=100&offset=0`)
4. **Avoid full-table scans** — add indexes manually in `__indexes` (future)
5. **Keep sheets under 50k rows** for reasonable latency

### Schema Design
1. **Use appropriate types** — `number` for IDs/counts, `date` for timestamps, `json` for flexible data
2. **Set defaults** — `"default": "NOW"` for created_at
3. **Mark required columns** — `"required": true` (validated on insert)
4. **Plan for migrations** — use `addColumn`, `renameColumn`, `changeColumnType`

### RLS Design
1. **One JWT per user/application** — don't share tokens
2. **Use `tables` overrides** for fine-grained access
3. **Service key for backend services** — full access for sync jobs, webhooks
4. **Disable RLS only for testing** — not production

---

## Migration & Upgrades

### Automatic Migrations (run on first request if needed)
- `ensureOwnerIdColumns()` — Adds `owner_id` to tables missing it
- `migrateUsersSheet()` — Converts `__users` from 4-column (with `key`) to 3-column format
- Triggered by `needsKeysMigration()` check in `code.js:handleRequest`

### Manual Migration
```http
POST /exec
{
  "_method": "POST",
  "table": "_migrate"
}
```
- Requires service key
- Runs both migrations

### Version History
- **v1** — Legacy plain-text keys, `_keys` column for row ownership
- **v2** — JWT tokens, `owner_id` column, `__users` 3-column format, RLS toggle

### Breaking Changes
- `_keys` column deprecated — use `owner_id`
- Plain-text API keys deprecated — use JWT
- `__users` sheet format changed — run migration

---

## Appendix: Internal Functions Reference

### Tables.js
| Function | Description |
|----------|-------------|
| `createTable(name, columns)` | Create new table with schema |
| `dropTable(name)` | Delete table and metadata |
| `renameTable(oldName, newName)` | Rename table |
| `listTables()` | Return array of user table names |
| `describeTable(name)` | Return table metadata + schema |
| `getSchema(table)` | Return column definitions |
| `validateTableName(name)` | Throw if invalid |
| `getTableMeta(table)` | Return row, schema, nextId |

### Schema.js
| Function | Description |
|----------|-------------|
| `addColumn(table, definition)` | Add column to table |
| `removeColumn(table, column)` | Remove column |
| `renameColumn(table, oldName, newName)` | Rename column |
| `changeColumnType(table, column, type)` | Change type |
| `validateValue(value, column)` | Coerce/validate value per type |
| `validateSchema(schema)` | Validate schema array |

### Query.js
| Function | Description |
|----------|-------------|
| `buildQuery(params)` | Parse query params to structured object |
| `parseWhere(where)` | Parse string/object/array to condition array |
| `parseSelect(select)` | Parse to column array |
| `parseSort(sort)` | Parse to column with direction |
| `parseLimit/parseOffset` | Parse integers |
| `validateQuery(table, query)` | Validate columns exist |

### CRUD.js
| Function | Description |
|----------|-------------|
| `insert(table, record, ownerId)` | Insert single row |
| `insertMany(table, records, ownerId)` | Bulk insert |
| `select(table, options, rlsWhere)` | Query with filtering, sorting, pagination |
| `update(table, where, values, rlsWhere)` | Update matching rows |
| `remove(table, where, rlsWhere)` | Delete matching rows |
| `count/exists` | Convenience wrappers |

### RLS.js
| Function | Description |
|----------|-------------|
| `createJwt(userId)` | Issue signed JWT |
| `verifyJwt(token)` | Verify and return payload |
| `extractAuthToken(body, headers)` | Extract token from request |
| `buildUserContext(authToken)` | Build context with permissions |
| `createApiUser(gperms, tables)` | Create user, return JWT |
| `updateApiUser(id, updates)` | Update permissions |
| `deleteApiUser(id)` | Delete user |
| `listApiUsers()` | List all users (no tokens) |
| `buildRlsPolicy(ctx, table, op)` | Return RLS where clause |
| `mergeWhere(userWhere, rlsWhere)` | AND user + RLS conditions |
| `enforceWriteAccess(ctx, table)` | Throw if no write permission |
| `isRlsEnabled/setRlsEnabled` | Toggle RLS |

---

## Support

- **Issues**: <https://github.com/Arnav-Saraf-Official/sheetsDB/issues>
- **Plan/Design**: See `PLAN.md` for implementation roadmap
- **License**: See `LICENSE`

---

*Generated from source code analysis. Last updated: 2026*