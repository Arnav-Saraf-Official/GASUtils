var Store = (function () {

  function book_() {
    return SpreadsheetApp.getActiveSpreadsheet();
  }

  function sheet_(table) {
    var sh = book_().getSheetByName(table);
    if (!sh) {
      throw new GasError('Sheet "' + table + '" not found. Run gasmailSetup().', 'NOT_INITIALIZED');
    }
    return sh;
  }

  function lock_(fn) {
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      return fn();
    } finally {
      try { lock.releaseLock(); } catch (e) { }
    }
  }

  function ensure_() {
    var book = book_();
    Object.keys(SCHEMAS).forEach(function (table) {
      var sh = book.getSheetByName(table);
      if (!sh) {
        sh = book.insertSheet(table);
        sh.getRange(1, 1, 1, SCHEMAS[table].length).setValues([SCHEMAS[table]]);
        sh.setFrozenRows(1);
        sh.getRange(1, 1, 1, SCHEMAS[table].length).setFontWeight('bold');
        if (table === CONFIG.SHEETS.CONFIG) {
          sh.hideSheet();
        }
      }
    });
    return true;
  }

  function scan_(table) {
    var sh = sheet_(table);
    var lastRow = sh.getLastRow();
    if (lastRow < 2) {
      return [];
    }
    var values = sh.getRange(1, 1, lastRow, Math.max(sh.getLastColumn(), 1)).getValues();
    var heads = values[0].map(String);
    var rows = [];
    for (var i = 1; i < values.length; i++) {
      var rowValues = values[i];
      var obj = { __row: i + 1 };
      var hasData = false;
      for (var c = 0; c < heads.length; c++) {
        obj[heads[c]] = rowValues[c];
        if (rowValues[c] !== '' && rowValues[c] !== null) {
          hasData = true;
        }
      }
      if (hasData) {
        rows.push(obj);
      }
    }
    return rows;
  }

  function public_(obj) {
    var clean = {};
    Object.keys(obj).forEach(function (k) {
      if (k !== '__row') {
        clean[k] = obj[k];
      }
    });
    return clean;
  }

  function readAll(table) {
    return scan_(table).map(public_);
  }

  function findById(table, id) {
    var found = scan_(table).filter(function (r) { return String(r._id) === String(id); })[0];
    return found ? public_(found) : null;
  }

  function findOne(table, predicate) {
    var found = scan_(table).filter(predicate)[0];
    return found ? public_(found) : null;
  }

  function extendHeaders_(sh, table, keys) {
    var heads = sh.getLastColumn() > 0
      ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String)
      : [];
    var missing = keys.filter(function (k) { return heads.indexOf(k) === -1; });
    if (missing.length) {
      sh.getRange(1, heads.length + 1, 1, missing.length).setValues([missing]);
      heads = heads.concat(missing);
    }
    return heads;
  }

  function insert(table, obj) {
    return lock_(function () {
      insertManyUnlocked_(table, [obj]);
      return public_(obj);
    });
  }

  function insertUnlocked_(table, obj) {
    insertManyUnlocked_(table, [obj]);
    return obj;
  }

  function insertMany(table, objs) {
    return lock_(function () {
      insertManyUnlocked_(table, objs);
      return objs;
    });
  }

  function insertManyUnlocked_(table, objs) {
    if (!objs || !objs.length) {
      return [];
    }
    var sh = sheet_(table);
    var keySet = {};
    objs.forEach(function (o) {
      if (!o._id) {
        o._id = uid_(table.charAt(0) + '_');
      }
      Object.keys(o).forEach(function (k) { keySet[k] = true; });
    });
    var heads = extendHeaders_(sh, table, Object.keys(keySet));
    var startRow = Math.max(sh.getLastRow(), 1) + 1;
    var rows = objs.map(function (o) {
      return heads.map(function (h) { return o.hasOwnProperty(h) ? o[h] : ''; });
    });
    sh.getRange(startRow, 1, rows.length, heads.length).setValues(rows);
    return objs;
  }

  function update(table, id, values) {
    return lock_(function () {
      updateUnlocked_(table, id, values);
      return findByIdUnlocked_(table, id);
    });
  }

  function updateUnlocked_(table, id, values) {
    var sh = sheet_(table);
    var target = null;
    scan_(table).some(function (r) {
      if (String(r._id) === String(id)) { target = r; return true; }
      return false;
    });
    if (!target) {
      throw new GasError('Record not found in "' + table + '": ' + id, 'NOT_FOUND');
    }
    var merged = {};
    Object.keys(target).forEach(function (k) { merged[k] = target[k]; });
    Object.keys(values).forEach(function (k) { merged[k] = values[k]; });
    delete merged.__row;
    var heads = extendHeaders_(sh, table, Object.keys(merged));
    var row = heads.map(function (h) { return merged.hasOwnProperty(h) ? merged[h] : ''; });
    sh.getRange(target.__row, 1, 1, heads.length).setValues([row]);
    return merged;
  }

  function findByIdUnlocked_(table, id) {
    var found = scan_(table).filter(function (r) { return String(r._id) === String(id); })[0];
    return found ? public_(found) : null;
  }

  function remove(table, id) {
    return lock_(function () {
      var sh = sheet_(table);
      var target = null;
      scan_(table).some(function (r) {
        if (String(r._id) === String(id)) { target = r; return true; }
        return false;
      });
      if (!target) {
        throw new GasError('Record not found in "' + table + '": ' + id, 'NOT_FOUND');
      }
      sh.deleteRow(target.__row);
      return { _id: id, deleted: true };
    });
  }

  return {
    ensure_: ensure_,
    readAll: readAll,
    findById: findById,
    findOne: findOne,
    insert: insert,
    insertMany: insertMany,
    update: update,
    remove: remove,
    lock_: lock_,
    insertUnlocked_: insertUnlocked_,
    updateUnlocked_: updateUnlocked_
  };
})();
