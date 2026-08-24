const TABLES_SHEET = "__tables";
const INDEXES_SHEET = "__indexes";

const RESERVED_TABLE_PREFIX = "__";

const RESERVED_COLUMNS = [
    "_id",
    "__row",
    "__deleted"
];

function ensureSystemSheets() {
    let tables = SHEET.getSheetByName(TABLES_SHEET);

    if (!tables) {
        tables = SHEET.insertSheet(TABLES_SHEET);

        tables.appendRow([
            "Table",
            "Created",
            "Modified",
            "Schema",
            "NextID"
        ]);

        tables.hideSheet();
    }

    let indexes = SHEET.getSheetByName(INDEXES_SHEET);

    if (!indexes) {
        indexes = SHEET.insertSheet(INDEXES_SHEET);

        indexes.appendRow([
            "Table",
            "Column",
            "IndexType",
            "SheetName"
        ]);

        indexes.hideSheet();
    }

    // RLS sheets (idempotent — creates __users + __config if missing)
    getUsersSheet();
    getRlsConfigSheet();
}

function validateTableName(name) {
    if (!name || typeof name !== "string")
        throw new Error("Table name is required.");

    name = name.trim();

    if (name.length === 0)
        throw new Error("Table name cannot be empty.");

    if (name.startsWith(RESERVED_TABLE_PREFIX))
        throw new Error("Names beginning with '__' are reserved.");

    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
        throw new Error("Table names must begin with a letter and contain only letters, numbers and underscores.");
}

function tableExists(name) {
    return SHEET.getSheetByName(name) !== null;
}

function getTable(name) {
    const sheet = SHEET.getSheetByName(name);

    if (!sheet)
        throw new Error(`Table '${name}' does not exist.`);

    return sheet;
}

function getTablesSheet() {
    ensureSystemSheets();
    return SHEET.getSheetByName(TABLES_SHEET);
}

function getIndexesSheet() {
    ensureSystemSheets();
    return SHEET.getSheetByName(INDEXES_SHEET);
}

function getTableMetaRow(table) {
    const meta = getTablesSheet();
    const values = meta.getDataRange().getValues();

    for (let i = 1; i < values.length; i++) {
        if (values[i][0] === table)
            return i + 1;
    }

    return null;
}

function getTableMeta(table) {
    const row = getTableMetaRow(table);

    if (!row)
        throw new Error(`Metadata for '${table}' not found.`);

    const meta = getTablesSheet();
    const values = meta.getRange(row, 1, 1, 5).getValues()[0];

    return {
        row,
        table: values[0],
        created: values[1],
        modified: values[2],
        schema: JSON.parse(values[3]),
        nextId: values[4]
    };
}

function updateTableMeta(table, updates) {
    const metaInfo = getTableMeta(table);
    const meta = getTablesSheet();

    meta.getRange(metaInfo.row, 1, 1, 5).setValues([[
        updates.table ?? metaInfo.table,
        updates.created ?? metaInfo.created,
        updates.modified ?? metaInfo.modified,
        JSON.stringify(updates.schema ?? metaInfo.schema),
        updates.nextId ?? metaInfo.nextId
    ]]);
}

function createTable(name, columns = []) {
    const lock = LockService.getDocumentLock();
    lock.waitLock(30000);

    try {
        validateTableName(name);

        if (tableExists(name))
            throw new Error(`Table '${name}' already exists.`);

        if (!Array.isArray(columns))
            throw new Error("Columns must be an array.");

        columns.forEach(col => {
            const column = typeof col === "string" ? { name: col, type: "string" } : col;

            if (!column.name)
                throw new Error("Every column requires a name.");

            if (RESERVED_COLUMNS.includes(column.name))
                throw new Error(`Column '${column.name}' is reserved.`);
        });

        const schema = [
            {
                name: "_id",
                type: "number",
                primary: true,
                autoIncrement: true,
                unique: true,
                required: true
            },
            {
                name: "owner_id",
                type: "number",
                required: false
            },
            {
                name: "_keys",
                type: "json",
                default: []
            },
            ...columns.map(col =>
                typeof col === "string"
                    ? { name: col, type: "string" }
                    : col
            )
        ];

        const sheet = SHEET.insertSheet(name);

        sheet.getRange(1, 1, 1, schema.length)
            .setValues([schema.map(c => c.name)]);

        sheet.setFrozenRows(1);

        getTablesSheet().appendRow([
            name,
            new Date(),
            new Date(),
            JSON.stringify(schema),
            1
        ]);

        return {
            success: true,
            table: name
        };

    } finally {
        lock.releaseLock();
    }
}

function dropTable(name) {
    const lock = LockService.getDocumentLock();
    lock.waitLock(30000);

    try {
        const sheet = getTable(name);
        SHEET.deleteSheet(sheet);

        const row = getTableMetaRow(name);

        if (row)
            getTablesSheet().deleteRow(row);

        const indexes = getIndexesSheet();
        const values = indexes.getDataRange().getValues();

        for (let i = values.length - 1; i >= 1; i--) {
            if (values[i][0] === name)
                indexes.deleteRow(i + 1);
        }

        return {
            success: true
        };

    } finally {
        lock.releaseLock();
    }
}

function renameTable(oldName, newName) {
    const lock = LockService.getDocumentLock();
    lock.waitLock(30000);

    try {
        validateTableName(newName);

        if (tableExists(newName))
            throw new Error(`Table '${newName}' already exists.`);

        const sheet = getTable(oldName);
        sheet.setName(newName);

        updateTableMeta(oldName, {
            table: newName,
            modified: new Date()
        });

        const indexes = getIndexesSheet();
        const values = indexes.getDataRange().getValues();

        for (let i = 1; i < values.length; i++) {
            if (values[i][0] === oldName)
                indexes.getRange(i + 1, 1).setValue(newName);
        }

        return {
            success: true
        };

    } finally {
        lock.releaseLock();
    }
}

function listTables() {
    ensureSystemSheets();

    return SHEET.getSheets()
        .map(sheet => sheet.getName())
        .filter(name => !name.startsWith("__"));
}

function describeTable(name) {
    const sheet = getTable(name);
    const meta = getTableMeta(name);

    return {
        table: name,
        rows: Math.max(sheet.getLastRow() - 1, 0),
        columns: meta.schema
    };
}