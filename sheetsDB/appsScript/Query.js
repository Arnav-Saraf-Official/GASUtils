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

    condition = condition.trim();

    if (!condition)
        throw new Error("Invalid condition.");

    // Condition format:  COLUMN <operator> VALUE
    //   Symbol operators:  col=25, col!=x, col>=18, col>3, col<2
    //   Word operators:    col=contains:val, col=startsWith:val,
    //                      col=endsWith:val, col=in:[a,b]
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(condition);

    if (!match)
        throw new Error(`Invalid condition '${condition}'.`);

    const column = match[1];
    const rest = match[2];

    // Word operators use an explicit '=' + operator + ':' separator so they
    // are never confused with the plain '=' equality operator (col=...).
    const wordOp = /^=((?:in|contains|startsWith|endsWith)):(.*)$/.exec(rest);

    let operator;
    let valueStr;

    if (wordOp) {
        operator = wordOp[1];
        valueStr = wordOp[2];
    } else {
        const symbolOp = /^(>=|<=|!=|>|<|=)(.*)$/.exec(rest);

        if (!symbolOp)
            throw new Error(`Invalid operator in condition '${condition}'.`);

        operator = symbolOp[1];
        valueStr = symbolOp[2];
    }

    const value = operator === "in"
        ? parseInValue(valueStr)
        : parseValue(valueStr.trim());

    return [
        column,
        operator,
        value
    ];
}

/**
 * Parse the value of an `in` operator.
 *
 * Accepts both bracket forms, e.g. `[a,b,c]` and `["a","b"]`/`["a,b","c"]`
 * (quoted JSON, which supports values containing commas), as well as a
 * bare comma-separated list `a,b,c` (legacy).
 */
function parseInValue(value) {

    value = value.trim();

    if (value === "")
        return [];

    // Bare list without brackets: a,b,c
    if (!value.startsWith("["))
        return value.split(",").map(v => parseValue(v.trim()));

    // Bracket form — prefer strict JSON so quoted/escaped values (", \,
    // commas inside quotes) parse correctly.
    try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed;
    } catch (e) {
        // Not strict JSON — fall through to manual comma-split below.
    }

    // Manual comma-split for unquoted arrays like [a,b,c]
    const inner = value.replace(/^\[/, "").replace(/\]$/, "");

    return inner.split(",").map(v => parseValue(v.trim()));
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