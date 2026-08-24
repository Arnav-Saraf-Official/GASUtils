const QUERY_OPERATORS = [
    "=",
    "!=",
    ">",
    "<",
    ">=",
    "<=",
    "contains",
    "startsWith",
    "endsWith",
    "in"
];

function buildQuery(params = {}) {
    const query = {
        where: parseWhere(params.where),
        sort: parseSort(params.sort),
        select: parseSelect(params.select),
        limit: parseLimit(params.limit),
        offset: parseOffset(params.offset)
    };

    return query;
}

function validateQuery(table, query) {
    query = query || {};

    const schema = getSchema(table);
    const columns = schema.map(c => c.name);

    if (query.select) {
        query.select.forEach(column => {
            if (!columns.includes(column))
                throw new Error(`Unknown column '${column}'.`);
        });
    }

    if (query.sort) {
        const column = query.sort.startsWith("-")
            ? query.sort.substring(1)
            : query.sort;

        if (!columns.includes(column))
            throw new Error(`Unknown column '${column}'.`);
    }

    if (Array.isArray(query.where)) {
        query.where.forEach(condition => {

            if (condition.length !== 3)
                throw new Error("Invalid where condition.");

            const [column, operator] = condition;

            if (!columns.includes(column))
                throw new Error(`Unknown column '${column}'.`);

            if (!QUERY_OPERATORS.includes(operator))
                throw new Error(`Unsupported operator '${operator}'.`);
        });
    }

    if (
        query.where &&
        !Array.isArray(query.where)
    ) {
        Object.keys(query.where).forEach(column => {

            if (!columns.includes(column))
                throw new Error(`Unknown column '${column}'.`);

        });
    }

    return query;
}

function parseWhere(where) {

    if (
        where === undefined ||
        where === null ||
        where === ""
    )
        return null;

    if (Array.isArray(where))
        return where;

    if (typeof where === "object")
        return where;

    if (typeof where !== "string")
        throw new Error("Invalid where clause.");

    const conditions = where
        .split(";")
        .map(c => c.trim())
        .filter(Boolean);

    return conditions.map(parseCondition);
}

function parseCondition(condition) {

    const operators = [
        "startsWith",
        "endsWith",
        "contains",
        "!=",
        ">=",
        "<=",
        ">",
        "<",
        "=",
        "in"
    ];

    for (const operator of operators) {

        const index = condition.indexOf(operator);

        if (index === -1)
            continue;

        const column = condition.substring(0, index).trim();

        let value = condition.substring(index + operator.length).trim();

        if (!column)
            throw new Error("Missing column name.");

        if (operator === "in") {

            value = value
                .replace(/^\[/, "")
                .replace(/\]$/, "")
                .split(",")
                .map(v => parseValue(v.trim()));

        } else {

            value = parseValue(value);

        }

        return [
            column,
            operator,
            value
        ];
    }

    throw new Error(`Invalid condition '${condition}'.`);
}

function parseSelect(select) {

    if (
        select === undefined ||
        select === null ||
        select === ""
    )
        return null;

    if (Array.isArray(select))
        return select;

    if (typeof select !== "string")
        throw new Error("Invalid select clause.");

    return select
        .split(",")
        .map(c => c.trim())
        .filter(Boolean);
}

function parseSort(sort) {

    if (
        sort === undefined ||
        sort === null ||
        sort === ""
    )
        return null;

    if (typeof sort !== "string")
        throw new Error("Invalid sort clause.");

    sort = sort.trim();

    const descending = sort.startsWith("-");

    const column = descending
        ? sort.substring(1)
        : sort;

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column))
        throw new Error("Invalid sort column.");

    return descending
        ? "-" + column
        : column;
}

function parseLimit(limit) {

    if (
        limit === undefined ||
        limit === null ||
        limit === ""
    )
        return null;

    limit = Number(limit);

    if (!Number.isInteger(limit) || limit < 0)
        throw new Error("Invalid limit.");

    return limit;
}

function parseOffset(offset) {

    if (
        offset === undefined ||
        offset === null ||
        offset === ""
    )
        return 0;

    offset = Number(offset);

    if (!Number.isInteger(offset) || offset < 0)
        throw new Error("Invalid offset.");

    return offset;
}

function parseValue(value) {

    if (value === "")
        return "";

    if (value === "true")
        return true;

    if (value === "false")
        return false;

    if (value === "null")
        return null;

    if (/^-?\d+(\.\d+)?$/.test(value))
        return Number(value);

    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
    )
        return value.substring(1, value.length - 1);

    return value;
}

function parseBody(body) {

    body = body || {};

    return {
        where: parseWhere(body.where),
        values: body.values || {},
        record: body.record || body,
        records: body.records || [],
        sort: parseSort(body.sort),
        select: parseSelect(body.select),
        limit: parseLimit(body.limit),
        offset: parseOffset(body.offset)
    };
}