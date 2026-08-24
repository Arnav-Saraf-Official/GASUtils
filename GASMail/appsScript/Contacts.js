var Contacts = (function () {

  function normalizeListNames_(value) {
    var arr = [];
    if (Object.prototype.toString.call(value) === '[object Array]') {
      arr = value;
    } else if (typeof value === 'string') {
      arr = value.split(',');
    } else {
      return '';
    }
    var seen = {};
    var names = arr.map(function (s) { return String(s).trim(); })
      .filter(function (s) { return s.length > 0; })
      .filter(function (s) {
        var k = s.toLowerCase();
        if (seen[k]) { return false; }
        seen[k] = true;
        return true;
      });
    return names.join(',');
  }

  function inList_(contact, listName) {
    var lists = String(contact.lists || '').toLowerCase().split(',').map(function (s) { return s.trim(); });
    return lists.indexOf(String(listName).toLowerCase()) !== -1;
  }

  function create(input) {
    if (!isEmail_(input.email)) {
      throw new GasError('Valid email is required.', 'VALIDATION');
    }
    var email = normalizeEmail_(input.email);
    var existing = findByEmail(email);
    if (existing) {
      throw new GasError('Contact already exists: ' + email, 'DUPLICATE');
    }
    var now = nowIso_();
    var row = {
      _id: uid_('c_'),
      email: email,
      name: input.name != null ? String(input.name) : '',
      lists: normalizeListNames_(input.lists),
      notes: input.notes != null ? String(input.notes) : '',
      createdAt: now,
      updatedAt: now
    };
    Object.keys(input).forEach(function (k) {
      if (!row.hasOwnProperty(k) && ['_id', 'createdAt', 'updatedAt'].indexOf(k) === -1) {
        row[k] = input[k];
      }
    });
    return Store.insert(CONFIG.SHEETS.CONTACTS, row);
  }

  function update(id, patch) {
    var existing = get(id);
    var values = { updatedAt: nowIso_() };
    ['name', 'notes'].forEach(function (k) {
      if (patch[k] !== undefined) { values[k] = String(patch[k]); }
    });
    if (patch.lists !== undefined) { values.lists = normalizeListNames_(patch.lists); }
    if (patch.email !== undefined) {
      if (!isEmail_(patch.email)) {
        throw new GasError('Valid email is required.', 'VALIDATION');
      }
      values.email = normalizeEmail_(patch.email);
    }
    Object.keys(patch).forEach(function (k) {
      if (values.hasOwnProperty(k) || ['_id', 'email', 'createdAt', 'updatedAt'].indexOf(k) !== -1) { return; }
      if (['_id', 'createdAt', 'updatedAt'].indexOf(k) === -1) { values[k] = patch[k]; }
    });
    return Store.update(CONFIG.SHEETS.CONTACTS, id, values);
  }

  function get(id) {
    var row = Store.findById(CONFIG.SHEETS.CONTACTS, id);
    if (!row) {
      throw new GasError('Contact not found: ' + id, 'NOT_FOUND');
    }
    return row;
  }

  function findByEmail(email) {
    var target = normalizeEmail_(email);
    return Store.findOne(CONFIG.SHEETS.CONTACTS, function (r) {
      return normalizeEmail_(r.email) === target;
    });
  }

  function list(opts) {
    opts = opts || {};
    var rows = Store.readAll(CONFIG.SHEETS.CONTACTS);
    if (opts.listName) {
      rows = rows.filter(function (r) { return inList_(r, opts.listName); });
    }
    if (opts.q) {
      var q = String(opts.q).toLowerCase();
      rows = rows.filter(function (r) {
        return String(r.email).toLowerCase().indexOf(q) !== -1 ||
          String(r.name).toLowerCase().indexOf(q) !== -1 ||
          String(r.lists).toLowerCase().indexOf(q) !== -1;
      });
    }
    rows.sort(function (a, b) { return String(a.email).localeCompare(String(b.email)); });
    return rows;
  }

  function remove(id) {
    get(id);
    return Store.remove(CONFIG.SHEETS.CONTACTS, id);
  }

  function importContacts(params) {
    params = params || {};
    var rowsIn = params.rows || [];
    if (!rowsIn.length) {
      throw new GasError('No rows to import.', 'VALIDATION');
    }
    var existingEmails = {};
    Store.readAll(CONFIG.SHEETS.CONTACTS).forEach(function (c) {
      existingEmails[normalizeEmail_(c.email)] = true;
    });

    var now = nowIso_();
    var added = [];
    var skipped = [];
    var batchSeen = {};

    rowsIn.forEach(function (raw) {
      var email = normalizeEmail_(raw.email);
      if (!isEmail_(email) || existingEmails[email] || batchSeen[email]) {
        skipped.push({ email: raw.email || '', reason: existingEmails[email] ? 'duplicate' : (batchSeen[email] ? 'duplicate-in-batch' : 'invalid') });
        if (email) { batchSeen[email] = true; }
        return;
      }
      batchSeen[email] = true;
      var row = {
        _id: uid_('c_'),
        email: email,
        name: raw.name != null ? String(raw.name) : '',
        lists: normalizeListNames_(params.listName ? [raw.lists].concat([params.listName]) : raw.lists),
        notes: raw.notes != null ? String(raw.notes) : '',
        createdAt: now,
        updatedAt: now
      };
      Object.keys(raw).forEach(function (k) {
        if (!row.hasOwnProperty(k) && ['_id', 'createdAt', 'updatedAt'].indexOf(k) === -1) {
          row[k] = raw[k];
        }
      });
      added.push(row);
    });

    if (added.length) {
      Store.insertMany(CONFIG.SHEETS.CONTACTS, added);
    }
    return { added: added.length, skippedCount: skipped.length, skipped: skipped.slice(0, 50) };
  }

  function addToList(params) {
    var listName = requireList_(params.list);
    var emails = (params.emails || []).map(normalizeEmail_);
    var updated = 0;
    emails.forEach(function (email) {
      var contact = findByEmail(email);
      if (!contact) {
        contact = create({ email: email, lists: [listName] });
        updated++;
        return;
      }
      if (!inList_(contact, listName)) {
        var lists = String(contact.lists || '').split(',').filter(function (s) { return s.trim(); });
        lists.push(listName);
        Store.update(CONFIG.SHEETS.CONTACTS, contact._id, { lists: normalizeListNames_(lists), updatedAt: nowIso_() });
        updated++;
      }
    });
    return { list: listName, contactsUpdated: updated };
  }

  function removeFromList(params) {
    var listName = requireList_(params.list);
    var emails = (params.emails || []).map(normalizeEmail_);
    var updated = 0;
    emails.forEach(function (email) {
      var contact = findByEmail(email);
      if (!contact || !inList_(contact, listName)) { return; }
      var lists = String(contact.lists || '').split(',')
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s.toLowerCase() !== listName.toLowerCase() && s; });
      Store.update(CONFIG.SHEETS.CONTACTS, contact._id, { lists: normalizeListNames_(lists), updatedAt: nowIso_() });
      updated++;
    });
    return { list: listName, contactsUpdated: updated };
  }

  function requireList_(name) {
    if (!name || !String(name).trim()) {
      throw new GasError('List name is required.', 'VALIDATION');
    }
    return String(name).trim();
  }

  return {
    create: create,
    update: update,
    get: get,
    list: list,
    remove: remove,
    import: importContacts,
    findByEmail: findByEmail,
    addToList: addToList,
    removeFromList: removeFromList,
    inList_: inList_
  };
})();

var Lists = (function () {

  function create(input) {
    var name = input.name != null ? String(input.name).trim() : '';
    if (!name) {
      throw new GasError('List name is required.', 'VALIDATION');
    }
    var existing = findByName_(name);
    if (existing) {
      throw new GasError('List already exists: ' + name, 'DUPLICATE');
    }
    return Store.insert(CONFIG.SHEETS.LISTS, {
      _id: uid_('l_'),
      name: name,
      description: input.description != null ? String(input.description) : '',
      createdAt: nowIso_()
    });
  }

  function findByName_(name) {
    var target = String(name).toLowerCase();
    return Store.findOne(CONFIG.SHEETS.LISTS, function (r) {
      return String(r.name).toLowerCase() === target;
    });
  }

  function list() {
    var counts = {};
    Store.readAll(CONFIG.SHEETS.CONTACTS).forEach(function (c) {
      String(c.lists || '').split(',').forEach(function (n) {
        n = n.trim().toLowerCase();
        if (n) { counts[n] = (counts[n] || 0) + 1; }
      });
    });
    return Store.readAll(CONFIG.SHEETS.LISTS).map(function (l) {
      l.contactCount = counts[String(l.name).toLowerCase()] || 0;
      return l;
    }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  }

  function resolve(ref) {
    if (!ref) {
      return null;
    }
    var byId = Store.findById(CONFIG.SHEETS.LISTS, ref);
    if (byId) { return byId; }
    return findByName_(ref);
  }

  function remove(id) {
    var row = Store.findById(CONFIG.SHEETS.LISTS, id);
    if (!row) {
      throw new GasError('List not found: ' + id, 'NOT_FOUND');
    }
    var result = Store.remove(CONFIG.SHEETS.LISTS, id);
    Store.readAll(CONFIG.SHEETS.CONTACTS).forEach(function (c) {
      if (Contacts.inList_(c, row.name)) {
        var remaining = String(c.lists || '').split(',')
          .map(function (s) { return s.trim(); })
          .filter(function (s) { return s.toLowerCase() !== String(row.name).toLowerCase() && s; })
          .join(',');
        Store.update(CONFIG.SHEETS.CONTACTS, c._id, { lists: remaining, updatedAt: nowIso_() });
      }
    });
    return result;
  }

  function contacts(params) {
    var l = resolve(params.listId || params.list);
    if (!l) {
      throw new GasError('List not found: ' + (params.listId || params.list), 'NOT_FOUND');
    }
    return Contacts.list({ listName: l.name });
  }

  return {
    create: create,
    list: list,
    remove: remove,
    resolve: resolve,
    contacts: contacts
  };
})();
