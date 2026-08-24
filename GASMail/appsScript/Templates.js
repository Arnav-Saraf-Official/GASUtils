var Templates = (function () {

  function validate_(input) {
    if (!input.name || !String(input.name).trim()) {
      throw new GasError('Template name is required.', 'VALIDATION');
    }
    var html = input.htmlBody != null ? String(input.htmlBody) : '';
    var plain = input.plainBody != null ? String(input.plainBody) : '';
    if (!html.trim() && !plain.trim()) {
      throw new GasError('Template needs an htmlBody or plainBody.', 'VALIDATION');
    }
    if (html.length > CONFIG.LIMITS.MAX_BODY_CHARS) {
      throw new GasError('htmlBody exceeds the ' + CONFIG.LIMITS.MAX_BODY_CHARS + ' character limit (' + html.length + ').', 'TOO_LARGE');
    }
    if (plain.length > CONFIG.LIMITS.MAX_BODY_CHARS) {
      throw new GasError('plainBody exceeds the ' + CONFIG.LIMITS.MAX_BODY_CHARS + ' character limit (' + plain.length + ').', 'TOO_LARGE');
    }
    return {
      name: String(input.name).trim(),
      subject: input.subject != null ? String(input.subject) : '',
      htmlBody: html,
      plainBody: plain
    };
  }

  function mergeFields_(t) {
    var fields = [].concat(
      Merge.extractFields(t.subject),
      Merge.extractFields(t.htmlBody),
      Merge.extractFields(t.plainBody)
    );
    var seen = {};
    return fields.filter(function (f) {
      if (seen[f]) { return false; }
      seen[f] = true;
      return true;
    });
  }

  function create(input) {
    var clean = validate_(input);
    var now = nowIso_();
    var row = {
      _id: uid_('t_'),
      name: clean.name,
      subject: clean.subject,
      htmlBody: clean.htmlBody,
      plainBody: clean.plainBody,
      createdAt: now,
      updatedAt: now
    };
    row.mergeFields = mergeFields_(row).join(',');
    return Store.insert(CONFIG.SHEETS.TEMPLATES, row);
  }

  function update(id, patch) {
    var existing = get(id);
    var merged = {
      name: patch.name !== undefined ? patch.name : existing.name,
      subject: patch.subject !== undefined ? patch.subject : existing.subject,
      htmlBody: patch.htmlBody !== undefined ? patch.htmlBody : existing.htmlBody,
      plainBody: patch.plainBody !== undefined ? patch.plainBody : existing.plainBody
    };
    var clean = validate_(merged);
    var values = {
      name: clean.name,
      subject: clean.subject,
      htmlBody: clean.htmlBody,
      plainBody: clean.plainBody,
      mergeFields: '',
      updatedAt: nowIso_()
    };
    values.mergeFields = mergeFields_({
      subject: clean.subject,
      htmlBody: clean.htmlBody,
      plainBody: clean.plainBody
    }).join(',');
    return Store.update(CONFIG.SHEETS.TEMPLATES, id, values);
  }

  function get(id) {
    var row = Store.findById(CONFIG.SHEETS.TEMPLATES, id);
    if (!row) {
      throw new GasError('Template not found: ' + id, 'NOT_FOUND');
    }
    return row;
  }

  function list(opts) {
    opts = opts || {};
    var rows = Store.readAll(CONFIG.SHEETS.TEMPLATES);
    if (opts.q) {
      var q = String(opts.q).toLowerCase();
      rows = rows.filter(function (r) {
        return String(r.name).toLowerCase().indexOf(q) !== -1 ||
          String(r.subject).toLowerCase().indexOf(q) !== -1;
      });
    }
    rows.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    return rows;
  }

  function remove(id) {
    get(id);
    return Store.remove(CONFIG.SHEETS.TEMPLATES, id);
  }

  function preview(params) {
    var t = get(params.templateId);
    var rendered = Merge.renderMessage({
      subject: t.subject,
      htmlBody: t.htmlBody,
      plainBody: t.plainBody
    }, params.vars || {});
    return {
      templateId: t._id,
      rendered: rendered
    };
  }

  return {
    create: create,
    update: update,
    get: get,
    list: list,
    remove: remove,
    preview: preview,
    mergeFields_: mergeFields_
  };
})();
