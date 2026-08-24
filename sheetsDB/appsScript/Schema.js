function getSchema(table){
    return getTableMeta(table).schema;
}

function setSchema(table, schema){
    validateSchema(schema);

    const sheet = getTable(table);
    const headers = schema.map(c => c.name);

    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

    const currentColumns = sheet.getLastColumn();
    
    if (currentColumns > headers.length) {
        sheet.deleteColumns(headers.length + 1, currentColumns - headers.length);
    }
    updateTableMeta(table, {
        schema, 
        modified: new Date()
    })
    return schema;
}

function validateSchema(schema){
    if (!Array.isArray(schema)) throw new Error("Schema must be an array.");

    const names = new Set();
    schema.forEach(col => {
        if (!col.name) throw new Error("Every column requires a name.");
        if (names.has(col.name)) throw new Error(`Duplicate column name: ${col.name}`);
        names.add(col.name);

        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(col.name))
            throw new Error(`Invalid column name: ${col.name}. `)
        if (!col.type) col.type = "string";
        if (!["string", "number", "boolean", "date", "json"].includes(col.type))
            throw new Error(`Invalid column type: ${col.type}. Must be one of string, number, boolean, date, json.`);
         
    });
    if (!schema.find(c => c.name === "_id"))
            throw new Error("Schema must include a primary key column named '_id'.");
}

function columnExists(table, column) {
    return getSchema(table).some(c => c.name === column);
}

function getColumn(table, column) {
    const col = getSchema(table).find(c => c.name === column);
    if (!col)
        throw new Error(`Column '${column}' does not exist.`);

    return col;
}

function addColumn(table, definition){
    if (typeof definition === "string"){
        definition = {
            name: definition,
            type: "string"
        };
    }
    if (!definition.name)
        throw new Error("Column definition must include a name.");
    if (RESERVED_COLUMNS.includes(definition.name))
        throw new Error(`Column name '${definition.name}' is reserved.`);
    if (columnExists(table, definition.name))
        throw new Error(`Column '${definition.name}' already exists.`);

    definition.type = definition.type || "string";

    const schema = getSchema(table);
    schema.push(definition);

    validateSchema(schema);

    const sheet = getTable(table);
    const currentCols = sheet.getLastColumn();
    const newCol = currentCols + 1;

    sheet.insertColumnAfter(currentCols);

    sheet.getRange(1, newCol).setValue(definition.name);

    const rows = sheet.getLastRow();

    if (rows > 1) {
        let value = "";

        if (definition.hasOwnProperty("default"))
            value = definition.default;

        const values = Array(rows - 1)
            .fill(null)
            .map(() => [value]);

        sheet.getRange(2, newCol, rows - 1, 1).setValues(values);
    }
    
    updateTableMeta(table, {
        schema,
        modified: new Date()
    });
    return definition;
}

function removeColumn(table, column) {
    if (column === "_id") throw new Error("Cannot remove primary key column '_id'.");

    const schema = getSchema(table);
    const index = schema.findIndex(c => c.name === column);

    if (index === -1) throw new Error(`Column '${column}' does not exist.`);

    schema.splice(index, 1);

    const sheet = getTable(table);

    sheet.deleteColumn(index + 1);

    updateTableMeta(table, {
        schema,
        modified: new Date()
    });
    return true;
}

function renameColumn(table, oldName, newName) {
    if (oldName === "_id") throw new Error("Cannot rename primary key column '_id'.");
    if (RESERVED_COLUMNS.includes(newName)) throw new Error(`Column name '${newName}' is reserved.`);
    if (!columnExists(table, oldName)) throw new Error(`Column '${oldName}' does not exist.`);
    if (columnExists(table, newName)) throw new Error(`Column '${newName}' already exists.`);

    const schema = getSchema(table);
    const column = schema.find(c => c.name === oldName);
    if (!column) throw new Error(`Column '${oldName}' does not exist.`);

    column.name = newName;

    validateSchema(schema);

    const sheet = getTable(table);
    const headers = schema.map(c => c.name);

    sheet.getRange(1, 1, 1, headers.length).setValues([headers]); 

    updateTableMeta(table, {
        schema,
        modified: new Date()
    });
    return column;
}

function changeColumnType(table, column, newType) {
    const allowed = ["string", "number", "boolean", "date", "json"];
    if (!allowed.includes(newType)) throw new Error(`Invalid column type '${newType}'. Allowed types are: ${allowed.join(", ")}.`);

    const schema = getSchema(table);

    const col = schema.find(c => c.name === column);

    if (!col) throw new Error(`Column '${column}' does not exist.`);
    
    col.type = newType;

    updateTableMeta(table, {
        schema,
        modified: new Date()
    });
    return col;
}

function listColumns(table) {
    return getSchema(table).map(c => c.name);
}

function describeColumn(table, column) {
    return getColumn(table, column);
}

// ============================================================
//  Value type validation & coercion
// ============================================================

function validateValue(value, column) {
    const type = (column.type || "string").toLowerCase();
    const name = column.name;

    switch (type) {
        case "number": {
            if (typeof value === "number" && !isNaN(value)) return value;
            if (typeof value === "string" && value.trim() !== "" && !isNaN(Number(value)))
                return Number(value);
            throw new Error(`Column '${name}' expects a number. Got: ${JSON.stringify(value)}`);
        }
        case "boolean": {
            if (typeof value === "boolean") return value;
            if (value === "true" || value === 1)  return true;
            if (value === "false" || value === 0) return false;
            throw new Error(`Column '${name}' expects a boolean. Got: ${JSON.stringify(value)}`);
        }
        case "date": {
            if (value instanceof Date) return value;
            if (typeof value === "string") {
                const d = new Date(value);
                if (!isNaN(d.getTime())) return d;
            }
            throw new Error(`Column '${name}' expects a date. Got: ${JSON.stringify(value)}`);
        }
        case "json": {
            if (typeof value === "object" && value !== null) return value;
            throw new Error(`Column '${name}' expects a JSON object/array. Got: ${JSON.stringify(value)}`);
        }
        case "string":
        default: {
            if (value === null || value === undefined) return "";
            return String(value);
        }
    }
}
