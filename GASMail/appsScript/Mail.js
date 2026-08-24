var Mail = (function () {

  function validateRecipients_(value, field) {
    if (!value) {
      throw new GasError('"' + field + '" is required.', 'VALIDATION');
    }
    var list = String(value).split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
    if (!list.length) {
      throw new GasError('"' + field + '" must contain at least one address.', 'VALIDATION');
    }
    list.forEach(function (addr) {
      if (!isEmail_(addr)) {
        throw new GasError('Invalid email address in "' + field + '": ' + addr, 'VALIDATION');
      }
    });
    return list.join(',');
  }

  function send(params) {
    var to = validateRecipients_(params.to, 'to');
    var cc = params.cc ? validateRecipients_(params.cc, 'cc') : '';
    var bcc = params.bcc ? validateRecipients_(params.bcc, 'bcc') : '';
    if (!params.subject || !String(params.subject).trim()) {
      throw new GasError('Subject is required.', 'VALIDATION');
    }
    var htmlBody = params.htmlBody != null ? String(params.htmlBody) : '';
    var body = params.body != null ? String(params.body) : stripHtml_(htmlBody);
    if (!body.trim() && !htmlBody.trim()) {
      throw new GasError('Provide a body or htmlBody.', 'VALIDATION');
    }
    if (htmlBody.length > CONFIG.LIMITS.MAX_BODY_CHARS) {
      throw new GasError('htmlBody exceeds the ' + CONFIG.LIMITS.MAX_BODY_CHARS + ' character limit.', 'TOO_LARGE');
    }
    var vars = params.vars || {};
    var renderedSubject = Merge.render(String(params.subject), vars).text;
    var renderedBody = Merge.render(body, vars).text;
    var options = {
      to: to,
      cc: cc,
      bcc: bcc,
      subject: truncate_(renderedSubject, 990),
      body: renderedBody
    };
    if (htmlBody.trim()) {
      options.htmlBody = Merge.render(htmlBody, vars).text;
    }
    applyOptions_(options, params.options);
    try {
      MailApp.sendEmail(options);
    } catch (err) {
      Log.logSend({ to: to, cc: cc, bcc: bcc, templateId: '', subject: options.subject, mode: htmlBody ? 'html' : 'plain', status: 'failed', error: err.message });
      throw new GasError('Failed to send email: ' + err.message, 'SEND_FAILED');
    }
    var entry = Log.logSend({ to: to, cc: cc, bcc: bcc, templateId: params.templateId || '', subject: options.subject, mode: htmlBody ? 'html' : 'plain', status: 'sent' });
    return { status: 'sent', logId: entry._id, to: to };
  }

  function applyOptions_(options, opts) {
    opts = opts || {};
    ['name', 'replyTo', 'from'].forEach(function (k) {
      if (opts[k]) { options[k] = String(opts[k]); }
    });
    if (opts.attachments && opts.attachments.length) {
      options.attachments = opts.attachments.map(function (a) {
        return Utilities.newBlob(Utilities.base64Decode(a.content), a.mimeType || 'application/octet-stream', a.filename || 'attachment');
      });
    }
  }

  function sendTemplated(params) {
    var t = Templates.get(params.templateId);
    var rendered = Merge.renderMessage({
      subject: t.subject,
      htmlBody: t.htmlBody,
      plainBody: t.plainBody
    }, params.vars || {});
    var result = send({
      to: params.to,
      cc: params.cc,
      bcc: params.bcc,
      subject: rendered.subject,
      body: rendered.plainBody,
      htmlBody: rendered.htmlBody,
      templateId: t._id,
      options: params.options
    });
    result.unresolvedFields = rendered.missing;
    return result;
  }

  function quota() {
    return { remainingDailyQuota: MailApp.getRemainingDailyQuota() };
  }

  function normalizeRecipients_(raw) {
    var out = [];
    var seen = {};
    raw.forEach(function (r) {
      var item = typeof r === 'string' ? { email: r } : r;
      var email = item && item.email ? normalizeEmail_(item.email) : '';
      if (!isEmail_(email)) {
        out.push({ error: 'invalid', input: r });
        return;
      }
      if (seen[email]) { return; }
      seen[email] = true;
      out.push({
        email: email,
        name: item.name != null ? String(item.name) : '',
        vars: item.vars || {}
      });
    });
    return out;
  }

  function resolveAudience_(params) {
    if (params.listName || params.listId) {
      var ref = params.listName || params.listId;
      var contacts = Lists.contacts({ list: ref });
      if (!contacts.length) {
        throw new GasError('List "' + ref + '" has no contacts.', 'EMPTY_LIST');
      }
      return contacts.map(function (c) {
        var vars = {};
        Object.keys(c).forEach(function (k) {
          if (['_id', 'createdAt', 'updatedAt'].indexOf(k) === -1) {
            vars[k] = c[k];
          }
        });
        return { email: normalizeEmail_(c.email), name: String(c.name || ''), vars: vars };
      });
    }
    if (params.recipients && params.recipients.length) {
      return normalizeRecipients_(params.recipients).filter(function (r) { return !r.error; });
    }
    throw new GasError('Provide recipients[] or listName/listId.', 'VALIDATION');
  }

  function buildContent_(params) {
    if (params.templateId) {
      var t = Templates.get(params.templateId);
      return {
        templateId: t._id,
        subject: t.subject,
        htmlBody: t.htmlBody,
        plainBody: t.plainBody,
        defaultVars: {}
      };
    }
    if (!params.subject || !String(params.subject).trim()) {
      throw new GasError('Subject is required for manual campaigns.', 'VALIDATION');
    }
    var html = params.htmlBody != null ? String(params.htmlBody) : '';
    var plain = params.body != null ? String(params.body) : '';
    if (!html.trim() && !plain.trim()) {
      throw new GasError('Provide body or htmlBody for manual campaigns.', 'VALIDATION');
    }
    if (html.length > CONFIG.LIMITS.MAX_BODY_CHARS || plain.length > CONFIG.LIMITS.MAX_BODY_CHARS) {
      throw new GasError('Campaign body exceeds the ' + CONFIG.LIMITS.MAX_BODY_CHARS + ' character limit.', 'TOO_LARGE');
    }
    return {
      templateId: '',
      subject: String(params.subject),
      htmlBody: html,
      plainBody: plain,
      defaultVars: params.defaultVars || {}
    };
  }

  function renderForRecipient_(content, recipient) {
    var vars = {};
    Object.keys(content.defaultVars).forEach(function (k) { vars[k] = content.defaultVars[k]; });
    Object.keys(recipient.vars || {}).forEach(function (k) { vars[k] = recipient.vars[k]; });
    if (recipient.name && !vars.name) { vars.name = recipient.name; }
    return Merge.renderMessage({
      subject: content.subject,
      htmlBody: content.htmlBody,
      plainBody: content.plainBody
    }, vars);
  }

  function deliverOne_(content, recipient, campaignId) {
    var rendered = renderForRecipient_(content, recipient);
    var options = {
      to: recipient.email,
      subject: truncate_(rendered.subject, 990),
      body: rendered.plainBody,
      htmlBody: rendered.htmlBody
    };
    try {
      MailApp.sendEmail(options);
    } catch (err) {
      Log.logSend({
        campaignId: campaignId,
        to: recipient.email,
        templateId: content.templateId,
        subject: options.subject,
        mode: content.htmlBody ? 'html' : 'plain',
        status: 'failed',
        error: err.message
      });
      return { ok: false, error: truncate_(err.message, 500) };
    }
    Log.logSend({
      campaignId: campaignId,
      to: recipient.email,
      templateId: content.templateId,
      subject: options.subject,
      mode: content.htmlBody ? 'html' : 'plain',
      status: 'sent'
    });
    return { ok: true };
  }

  function sendMass(params) {
    Store.ensure_();
    var audience = resolveAudience_(params);
    if (!audience.length) {
      throw new GasError('No valid recipients found.', 'VALIDATION');
    }
    var content = buildContent_(params);
    var remainingQuota = MailApp.getRemainingDailyQuota();
    var syncCap = Math.min(CONFIG.LIMITS.SYNC_MASS_LIMIT, remainingQuota - CONFIG.LIMITS.QUOTA_SAFETY_MARGIN);

    if (audience.length <= Math.max(syncCap, 0)) {
      var campaignId = uid_('cmp_s_');
      var sent = 0;
      var failed = 0;
      audience.forEach(function (recipient) {
        var outcome = deliverOne_(content, recipient, campaignId);
        if (outcome.ok) { sent++; } else { failed++; }
        Utilities.sleep(CONFIG.LIMITS.SEND_PAUSE_MS);
      });
      return {
        mode: 'sync',
        campaignId: campaignId,
        total: audience.length,
        sent: sent,
        failed: failed,
        quotaRemaining: MailApp.getRemainingDailyQuota()
      };
    }
    return Scheduler.createCampaign_(content, audience, params.name);
  }

  function previewCampaign(params) {
    var content = buildContent_(params);
    var sample = (params.recipients && params.recipients[0]) || { email: 'sample@example.com', name: 'Sample Name', vars: {} };
    var rendered = renderForRecipient_(content, sample);
    return { rendered: rendered };
  }

  return {
    send: send,
    sendTemplated: sendTemplated,
    sendMass: sendMass,
    quota: quota,
    previewCampaign: previewCampaign,
    deliverOne_: deliverOne_,
    renderForRecipient_: renderForRecipient_
  };
})();
