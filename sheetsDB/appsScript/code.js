const SHEET = SpreadsheetApp.getActiveSpreadsheet();

// ============================================================
//  Keys — loaded from ScriptProperties, never hardcoded.
//  Set via: File > Project Properties > Script Properties
//    MASTER_KEY  = <your-service-key>
//    READ_KEY    = <your-read-key>   (optional, legacy)
//  If unset or still the placeholder, the app refuses all
//  requests (fail closed).
// ============================================================

const PLACEHOLDER_MASTER = "your-master-key-here";
const PLACEHOLDER_READ   = "your-read-key-here";

/**
 * Load keys from ScriptProperties.  Never hardcoded in source.
 * Keys that are unset or still the placeholder → the app refuses
 * all requests (fail closed).
 *
 * Called lazily on first request so the script can boot even
 * when keys aren't configured yet — the API just returns a
 * clear error instead of silently running with defaults.
 */
// Lazy-initialized on first request.  All other modules (RLS.js)
// reference KEYS directly — it stays null until keys are configured.
var KEYS = null;

function getKeys() {
  if (KEYS) return KEYS;

  var props = PropertiesService.getScriptProperties();
  var master = props.getProperty("MASTER_KEY") || "";
  var read   = props.getProperty("READ_KEY")   || "";

  // Fail closed: placeholder or missing master key → no auth possible
  if (!master || master === PLACEHOLDER_MASTER) {
    return null;
  }

  KEYS = {
    masterKey: master,
    readKey:   read && read !== PLACEHOLDER_READ ? read : ""
  };
  return KEYS;
}

function doGet(e) {
    return HtmlService.createHtmlOutputFromFile('Index')
        .setTitle('SheetsDB — Google Sheets Database');
}

function doPost(e) {
    const body = e?.postData ? JSON.parse(e.postData.contents) : {};
    const method = body._method || e?.parameter?._method || 'POST';
    return handleRequest(e, method, body);
}

function handleRequest(e, method, body) {
    try {
        // Fail closed: refuse all requests until keys are configured
        if (!getKeys()) {
            return error(
                "MASTER_KEY is unset or still the placeholder. " +
                "Open the Apps Script editor, go to File > Project Properties > Script Properties, " +
                "and add MASTER_KEY with a secure value. See SETUP.md for full instructions.",
                503
            );
        }

        // One-time migration: add owner_id to pre-RLS tables,
        // migrate __users sheet to 3-column format
        if (needsKeysMigration()) {
            migrateExistingTables();
        }

        const headers = e?.postData?.headers || {};
        const auth = extractAuthToken(body, headers);

        const ctx = buildUserContext(auth);
        if (!ctx || !auth) return error('Unauthorized — provide a valid JWT token or service key', 401);

        const path = e?.pathInfo || e?.parameter?.table || body.table;
        if (!path) return error('Table name required', 400);

        switch (method) {
            case 'GET':    return handleGet(path, e?.parameter, ctx);
            case 'POST':   return handlePost(path, body, ctx);
            case 'PUT':    return handlePut(path, body, ctx);
            case 'DELETE': return handleDelete(path, e?.parameter, body, ctx);
            default:       return error('Method not allowed', 405);
        }

    } catch (err) {
        return error(err.toString(), 500);
    }
}

function success(data) {
    return ContentService.createTextOutput(JSON.stringify(data))
        .setMimeType(ContentService.MimeType.JSON);
}

function error(msg, code) {
    return ContentService.createTextOutput(JSON.stringify({
        error: true,
        message: msg,
        code: code || 500
    })).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
//  GET — reads, RLS management
// ============================================================

function handleGet(path, params, ctx) {
    // --- RLS management (service key only) ---
    if (path === '_rls') {
        if (!ctx.isServiceKey) return error('Service key required for RLS management', 403);

        if (params?.status) {
            return success({
                rls_enabled: isRlsEnabled(),
                user_count: listApiUsers().length
            });
        }
        if (params?.toggle === 'on') {
            setRlsEnabled(true);
            return success({ rls_enabled: true });
        }
        if (params?.toggle === 'off') {
            setRlsEnabled(false);
            return success({ rls_enabled: false });
        }
        if (params?.id) {
            const user = getUserById(Number(params.id));
            if (!user) return error('User not found', 404);
            return success(user);
        }
        return success(listApiUsers());
    }

    // --- Table meta ---
    if (path === '_tables') {
        if (params?.name) return success(describeTable(params.name));
        return success(listTables());
    }

    // --- Data query ---
    const query = buildQuery(params);
    validateQuery(path, query);

    // Build RLS policy filter (null if service key or RLS off)
    const rlsWhere = buildRlsPolicy(ctx, path, "SELECT");

    // Policy is ANDed into the where clause inside select()
    let rows = select(path, query, rlsWhere);

    // Strip _keys column from non-service-key responses
    if (!ctx.isServiceKey) {
        rows = stripSensitiveColumns(rows, ctx.isServiceKey);
    }

    return success(rows);
}

// ============================================================
//  POST — inserts, table/schema creation, RLS user creation
// ============================================================

function handlePost(path, body, ctx) {
    // --- RLS: create user (service key only) ---
    if (path === '_rls') {
        if (!ctx.isServiceKey) return error('Service key required for RLS management', 403);
        if (!body.gperms && !body.tables)
            return error('gperms or tables required', 400);

        const user = createApiUser(body.gperms, body.tables);
        return success(user);
    }

    // --- Table creation ---
    if (path === '_tables') {
        if (!ctx.isServiceKey) return error('Only service key can manage tables', 403);
        if (!body.name) return error('Table name required', 400);
        return success(createTable(body.name, body.columns || []));
    }

    // --- Schema ---
    if (path === '_schema') {
        if (!ctx.isServiceKey) return error('Only service key can manage schema', 403);
        if (!body.table)  return error('Table name required', 400);
        if (!body.column) return error('Column definition required', 400);
        return success(addColumn(body.table, body.column));
    }

    // --- Trigger migration (service key only) ---
    if (path === '_migrate') {
        if (!ctx.isServiceKey) return error('Service key required', 403);
        migrateExistingTables();
        return success({ migrated: true });
    }

    // --- Data insert ---
    enforceWriteAccess(ctx, path);

    // owner_id is stamped server-side inside insert/insertMany.
    // ctx.userId is the verified user from the JWT (null for service key).
    const ownerId = ctx.isServiceKey ? null : ctx.userId;

    if (body.records && Array.isArray(body.records)) {
        return success(insertMany(path, body.records, ownerId));
    }

    return success(insert(path, body, ownerId));
}

// ============================================================
//  PUT — updates, renames, RLS user updates
// ============================================================

function handlePut(path, body, ctx) {
    // --- RLS: update user (service key only) ---
    if (path === '_rls') {
        if (!ctx.isServiceKey) return error('Service key required for RLS management', 403);
        if (!body.id) return error('User id required', 400);

        const updates = {};
        if (body.gperms !== undefined) updates.gperms = body.gperms;
        if (body.tables !== undefined) updates.tables = body.tables;
        if (Object.keys(updates).length === 0)
            return error('gperms or tables required', 400);

        const user = updateApiUser(body.id, updates);
        return success(user);
    }

    // --- Table rename ---
    if (path === '_tables') {
        if (!ctx.isServiceKey) return error('Only service key can manage tables', 403);
        if (!body.oldName || !body.newName) return error('oldName and newName required', 400);
        return success(renameTable(body.oldName, body.newName));
    }

    // --- Schema ---
    if (path === '_schema') {
        if (!ctx.isServiceKey) return error('Only service key can manage schema', 403);
        if (body.oldName && body.newName) {
            return success(renameColumn(body.table, body.oldName, body.newName));
        }
        if (body.column && body.type) {
            return success(changeColumnType(body.table, body.column, body.type));
        }
        return error('oldName/newName or column/type required', 400);
    }

    // --- Data update ---
    enforceWriteAccess(ctx, path);

    let where = body.where;
    if (typeof where === 'string') where = parseWhere(where);
    if (!where) return error('where clause required', 400);

    // Build RLS policy — ANDed unconditionally into where clause inside update()
    const rlsWhere = buildRlsPolicy(ctx, path, "UPDATE");

    return success(update(path, where, body.values || {}, rlsWhere));
}

// ============================================================
//  DELETE — deletes, drops, RLS user deletion
// ============================================================

function handleDelete(path, params, body, ctx) {
    // --- RLS: delete user (service key only) ---
    if (path === '_rls') {
        if (!ctx.isServiceKey) return error('Service key required for RLS management', 403);
        const id = body?.id || (params?.id ? Number(params.id) : null);
        if (!id) return error('User id required', 400);
        deleteApiUser(id);
        return success({ deleted: true });
    }

    // --- Table drop ---
    if (path === '_tables') {
        if (!ctx.isServiceKey) return error('Only service key can manage tables', 403);
        const name = body?.name || params?.name;
        if (!name) return error('Table name required', 400);
        return success(dropTable(name));
    }

    // --- Schema ---
    if (path === '_schema') {
        if (!ctx.isServiceKey) return error('Only service key can manage schema', 403);
        const table  = body?.table  || params?.table;
        const column = body?.column || params?.column;
        if (!table || !column) return error('table and column required', 400);
        return success(removeColumn(table, column));
    }

    // --- Data delete ---
    enforceWriteAccess(ctx, path);

    let where = body?.where || params?.where;
    if (typeof where === 'string') where = parseWhere(where);
    if (!where) return error('where clause required', 400);

    // Build RLS policy — ANDed unconditionally into where clause inside remove()
    const rlsWhere = buildRlsPolicy(ctx, path, "DELETE");

    return success(remove(path, where, rlsWhere));
}
