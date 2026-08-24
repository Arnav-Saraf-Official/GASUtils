const DB_OPERATORS = {
    "=": (a, b) => a == b,
    "!=": (a, b) => a != b,
    ">": (a, b) => a > b,
    "<": (a, b) => a < b,
    ">=": (a, b) => a >= b,
    "<=": (a, b) => a <= b,
    "contains": (a, b) => String(a).includes(String(b)),
    "startsWith": (a, b) => String(a).startsWith(String(b)),
    "endsWith": (a, b) => String(a).endsWith(String(b)),
    "in": (a, b) => Array.isArray(b) && b.includes(a)
};

function insert(table, record, ownerId){
    const lock = LockService.getDocumentLock();
    lock.waitLock(30000);

    try {
        const sheet = getTable(table);
        const schema = getSchema(table);
        const meta = getTableMeta(table);

        const row = [];

        schema.forEach(column => {
            let value;

            if (column.name === "_id")
                value = meta.nextId;
            else if (column.name === "owner_id")
                // Stamped server-side — never from request body.
                // ownerId is null for service key or RLS-disabled inserts.
                value = (ownerId != null) ? ownerId : "";
            else if (record.hasOwnProperty(column.name))
                value = validateValue(record[column.name], column);
            else if (column.hasOwnProperty("default"))
                value = column.default === "NOW"
                    ? new Date()
                    : validateValue(column.default, column);
            else
                value = "";

            row.push(value);
        });

        // Serialize JSON columns for sheet storage
        schema.forEach(function(col, i) {
            if (col.type === "json") {
                row[i] = typeof row[i] === "string" ? row[i] : JSON.stringify(row[i]);
            }
        });

        sheet.appendRow(row);

        updateTableMeta(table, {
            nextId: meta.nextId + 1,
            modified: new Date()
        });

        return{
            success: true,
            id: meta.nextId
        }
    }
    finally {
        lock.releaseLock();
    }
}

function insertMany(table, records, ownerId) {
    const lock = LockService.getDocumentLock();
    lock.waitLock(30000);

    try{
        if (!Array.isArray(records)) throw new Error("Records must be an array.");

        const sheet = getTable(table);
        const schema = getSchema(table);
        const meta = getTableMeta(table);

        let nextId = meta.nextId;

        const rows = records.map(record =>{
            return schema.map(column =>{
                if (column.name === "_id") return nextId++;
                // Stamped server-side — never from request body
                if (column.name === "owner_id") return (ownerId != null) ? ownerId : "";
                if (record.hasOwnProperty(column.name)) return validateValue(record[column.name], column);
                if (column.hasOwnProperty("default")) return column.default === "NOW" ? new Date() : validateValue(column.default, column);
                return "";
            });
        });

        // Serialize JSON columns for sheet storage
        const jsonCols = [];
        schema.forEach(function(col, i) {
            if (col.type === "json") jsonCols.push(i);
        });

        const serializedRows = rows.map(function(row) {
            jsonCols.forEach(function(i) {
                row[i] = typeof row[i] === "string" ? row[i] : JSON.stringify(row[i]);
            });
            return row;
        });

        if (serializedRows.length){
            sheet.getRange(
                sheet.getLastRow() + 1,
                1,
                serializedRows.length,
                schema.length
            ).setValues(serializedRows);
        }
        updateTableMeta(table, {
            nextId,
            modified: new Date()
        });
        return{
            success: true,
            inserted: rows.length
        };

    } finally {
        lock.releaseLock();
    }
}

/**
 * select with optional RLS policy filter.
 * rlsWhere is ANDed unconditionally with options.where.
 */
function select(table, options, rlsWhere){
    options = options || {};
    const sheet = getTable(table);
    const schema = getSchema(table);

    const values = sheet.getDataRange().getValues();

    if(values.length <= 1) return [];

    const headers = values[0];

    let rows = values.slice(1).map(row => {
        const obj = {};
        headers.forEach((header, index) => {
            obj[header] = row[index];
        });
        return obj;
    });

    // Deserialize JSON columns
    const jsonColumns = schema.filter(function(c) { return c.type === "json"; });
    if (jsonColumns.length) {
        rows.forEach(function(row) {
            jsonColumns.forEach(function(col) {
                const val = row[col.name];
                if (val && typeof val === "string") {
                    try { row[col.name] = JSON.parse(val); } catch (e) {}
                } else if (val === "" || val === undefined || val === null) {
                    row[col.name] = col.hasOwnProperty("default") ? col.default : null;
                }
            });
        });
    }

    // Merge RLS policy into where clause (RLS ANDed unconditionally)
    const where = mergeWhere(options.where, rlsWhere);
    if (where) rows = rows.filter(r => matchesWhere(r, where));
    if (options.sort) rows = sortRows(rows, options.sort);
    if (options.offset) rows = rows.slice(options.offset);
    if (options.limit) rows = rows.slice(0, options.limit);

    if(options.select){
        rows = rows.map(row =>{
            const obj = {};
            options.select.forEach(col => {
                obj[col] = row[col];
            });
            return obj;
        });
    }
    return rows;
}

/**
 * update with optional RLS policy filter.
 * rlsWhere is ANDed unconditionally with the user's where clause.
 */
function update(table, where, values, rlsWhere){
    const lock = LockService.getDocumentLock();
    lock.waitLock(30000);

    try{
        const sheet = getTable(table);
        const schema = getSchema(table);
        const data = sheet.getDataRange().getValues();

        if (data.length <= 1)
            return {
                success: true,
                updated: 0
            };

        const headers = data[0];
        let updated = 0;

        // Merge RLS policy into where clause
        const effectiveWhere = mergeWhere(where, rlsWhere);

        for (let r = 1; r < data.length ; r++) {
            const row = {};

            headers.forEach((h,c) => row[h] = data[r][c]);
            if (!matchesWhere(row, effectiveWhere)) continue;

            Object.keys(values).forEach(key => {
                // Never allow updating owner_id via request body
                if (key === "owner_id") return;

                const index = headers.indexOf(key);
                if (index === -1) return;
                const colDef = schema.find(c => c.name === key);
                data[r][index] = colDef ? validateValue(values[key], colDef) : values[key];
            });
            updated++;
        }
        sheet.getRange(2, 1, data.length - 1, headers.length).setValues(data.slice(1));
        updateTableMeta(table, {
            modified: new Date()
        });
        return {
            success: true,
            updated
        };
    } finally {
        lock.releaseLock();
    }
}

/**
 * remove with optional RLS policy filter.
 * rlsWhere is ANDed unconditionally with the user's where clause.
 * Only rows matching BOTH the user's where AND the RLS policy are deleted.
 */
function remove(table, where, rlsWhere) {
    const lock = LockService.getDocumentLock();
    lock.waitLock(30000);

    try {
        const sheet = getTable(table);

        const data = sheet.getDataRange().getValues();

        if (data.length <= 1)
            return {
                success: true,
                deleted: 0
            };
        const headers = data[0];
        const keep = [headers];
        let deleted = 0;

        // Merge RLS policy into where clause
        const effectiveWhere = mergeWhere(where, rlsWhere);

        for (let r = 1; r < data.length; r++) {
            const row = {};

            headers.forEach((h, c) => row[h] = data[r][c]);

            if (matchesWhere(row, effectiveWhere)) {
                deleted++;
                continue;
            }
            keep.push(data[r]);
        }

        // Reassign _id sequentially so no gaps remain
        const idIndex = headers.indexOf("_id");
        if (idIndex !== -1 && keep.length > 1) {
            for (let r = 1; r < keep.length; r++) {
                keep[r][idIndex] = r;
            }
        }

        sheet.clearContents();
        sheet.getRange(1, 1, keep.length, headers.length).setValues(keep);
        updateTableMeta(table, {
            modified: new Date(),
            nextId: keep.length  // next available _id = row count + 1, and keep includes header
        });
        return {
            success: true,
            deleted
        };

    } finally {
        lock.releaseLock();
    }
}

function count(table, where, rlsWhere) {
    return select(table, {where: where}, rlsWhere).length;
}

function exists(table, where, rlsWhere){
    return count(table, where, rlsWhere) > 0;
}

function matchesWhere(row, where) {
    if (!where) return true;

    if (Array.isArray(where)) {
        return where.every(condition => {
            const [column, operator, value] = condition;
            return DB_OPERATORS[operator](row[column], value);
        })
    }
    return Object.keys(where).every(key => row[key] == where[key]);
}

function sortRows(rows, sort) {
    const descending = sort.startsWith("-");
    const column = descending ? sort.substring(1) : sort;

    rows.sort((a, b) => {
        if (a[column] < b[column]) return descending ? 1 : -1;
        if (a[column] > b[column]) return descending ? -1 : 1;
        return 0;
    });

    return rows;
}
