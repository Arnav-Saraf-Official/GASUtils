var Log = (function () {

  function logSend(entry) {
    var row = {
      _id: uid_('g_'),
      campaignId: entry.campaignId || '',
      to: entry.to || '',
      cc: entry.cc || '',
      bcc: entry.bcc || '',
      templateId: entry.templateId || '',
      subject: truncate_(entry.subject, 500),
      mode: entry.mode || 'plain',
      status: entry.status || 'sent',
      error: truncate_(entry.error, 500),
      sentAt: nowIso_()
    };
    return Store.insert(CONFIG.SHEETS.SEND_LOG, row);
  }

  function updateSend(id, values) {
    return Store.update(CONFIG.SHEETS.SEND_LOG, id, values);
  }

  function get(params) {
    params = params || {};
    var limit = Math.min(parseInt(params.limit, 10) || 100, 1000);
    var rows = Store.readAll(CONFIG.SHEETS.SEND_LOG);
    if (params.status) {
      rows = rows.filter(function (r) { return String(r.status).toLowerCase() === String(params.status).toLowerCase(); });
    }
    if (params.campaignId) {
      rows = rows.filter(function (r) { return String(r.campaignId) === String(params.campaignId); });
    }
    if (params.to) {
      var target = normalizeEmail_(params.to);
      rows = rows.filter(function (r) { return normalizeEmail_(r.to) === target; });
    }
    rows.sort(function (a, b) {
      return String(b.sentAt || '').localeCompare(String(a.sentAt || ''));
    });
    return rows.slice(0, limit);
  }

  function clearOld(days) {
    days = days || 90;
    var cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    var removed = 0;
    Store.readAll(CONFIG.SHEETS.SEND_LOG).forEach(function (row) {
      if (new Date(row.sentAt) < cutoff) {
        Store.remove(CONFIG.SHEETS.SEND_LOG, row._id);
        removed++;
      }
    });
    return { removed: removed };
  }

  return {
    logSend: logSend,
    updateSend: updateSend,
    get: get,
    clearOld: clearOld
  };
})();
