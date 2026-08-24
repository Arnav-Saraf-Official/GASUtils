var Scheduler = (function () {

  function createCampaign_(content, audience, name) {
    var now = nowIso_();
    var campaign = Store.insert(CONFIG.SHEETS.CAMPAIGNS, {
      _id: uid_('cmp_'),
      name: name && String(name).trim() ? String(name).trim() : 'Campaign ' + now.slice(0, 16),
      templateId: content.templateId,
      subject: truncate_(content.subject, 990),
      bodyHtml: content.htmlBody,
      bodyPlain: content.plainBody,
      defaultVarsJson: JSON.stringify(content.defaultVars || {}),
      status: 'queued',
      total: audience.length,
      sent: 0,
      failed: 0,
      createdAt: now
    });
    var recipientRows = audience.map(function (r) {
      return {
        _id: uid_('rcp_'),
        campaignId: campaign._id,
        to: r.email,
        varsJson: JSON.stringify(r.vars || {}),
        status: 'pending'
      };
    });
    for (var i = 0; i < recipientRows.length; i += 500) {
      Store.insertMany(CONFIG.SHEETS.CAMPAIGN_RECIPIENTS, recipientRows.slice(i, i + 500));
    }
    ensureDrainTrigger_();
    return {
      mode: 'campaign',
      campaignId: campaign._id,
      total: audience.length,
      status: 'queued'
    };
  }

  function activeCampaigns_() {
    return Store.readAll(CONFIG.SHEETS.CAMPAIGNS).filter(function (c) {
      return c.status === 'queued' || c.status === 'running';
    });
  }

  function pendingRecipients_(campaignId, limit) {
    return Store.readAll(CONFIG.SHEETS.CAMPAIGN_RECIPIENTS)
      .filter(function (r) { return String(r.campaignId) === String(campaignId) && r.status === 'pending'; })
      .slice(0, limit);
  }

  function countByStatus_(campaignId) {
    var counts = { pending: 0, sent: 0, failed: 0 };
    Store.readAll(CONFIG.SHEETS.CAMPAIGN_RECIPIENTS).forEach(function (r) {
      if (String(r.campaignId) !== String(campaignId)) { return; }
      if (counts[r.status] !== undefined) { counts[r.status]++; }
    });
    return counts;
  }

  function drain() {
    var campaigns = activeCampaigns_();
    for (var i = 0; i < campaigns.length; i++) {
      var remainingQuota = MailApp.getRemainingDailyQuota();
      var budget = Math.min(CONFIG.LIMITS.CAMPAIGN_BATCH_SIZE, remainingQuota - CONFIG.LIMITS.QUOTA_SAFETY_MARGIN);
      if (budget <= 0) {
        break;
      }
      drainCampaignChunk_(campaigns[i], budget);
    }
    if (!activeCampaigns_().length) {
      removeDrainTrigger_();
    }
  }

  function drainCampaignChunk_(campaign, budget) {
    if (campaign.status === 'queued') {
      Store.update(CONFIG.SHEETS.CAMPAIGNS, campaign._id, { status: 'running', startedAt: nowIso_() });
      campaign.status = 'running';
    }
    var recipients = pendingRecipients_(campaign._id, budget);
    if (!recipients.length) {
      completeCampaign_(campaign);
      return;
    }
    var content = {
      templateId: campaign.templateId,
      subject: campaign.subject,
      htmlBody: campaign.bodyHtml,
      plainBody: campaign.bodyPlain,
      defaultVars: safeParseJson_(campaign.defaultVarsJson)
    };
    var sent = 0;
    var failed = 0;
    recipients.forEach(function (recipient) {
      if (MailApp.getRemainingDailyQuota() <= CONFIG.LIMITS.QUOTA_SAFETY_MARGIN) {
        return;
      }
      var person = { email: recipient.to, name: '', vars: safeParseJson_(recipient.varsJson) };
      var outcome = Mail.deliverOne_(content, person, campaign._id);
      if (outcome.ok) { sent++; } else { failed++; }
      Store.update(CONFIG.SHEETS.CAMPAIGN_RECIPIENTS, recipient._id, {
        status: outcome.ok ? 'sent' : 'failed',
        error: outcome.error || '',
        sentAt: nowIso_()
      });
      Utilities.sleep(CONFIG.LIMITS.SEND_PAUSE_MS);
    });
    var totals = countByStatus_(campaign._id);
    Store.update(CONFIG.SHEETS.CAMPAIGNS, campaign._id, { sent: totals.sent, failed: totals.failed });
    if (totals.pending === 0) {
      completeCampaign_(campaign);
    }
  }

  function completeCampaign_(campaign) {
    var totals = countByStatus_(campaign._id);
    Store.update(CONFIG.SHEETS.CAMPAIGNS, campaign._id, {
      status: 'completed',
      sent: totals.sent,
      failed: totals.failed,
      completedAt: nowIso_()
    });
  }

  function listCampaigns(params) {
    params = params || {};
    var rows = Store.readAll(CONFIG.SHEETS.CAMPAIGNS);
    rows.sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
    return params.limit ? rows.slice(0, Number(params.limit)) : rows;
  }

  function getCampaign(params) {
    var row = Store.findById(CONFIG.SHEETS.CAMPAIGNS, params.campaignId);
    if (!row) {
      throw new GasError('Campaign not found: ' + params.campaignId, 'NOT_FOUND');
    }
    row.counts = countByStatus_(row._id);
    return row;
  }

  function getRecipients(params) {
    var campaign = getCampaign({ campaignId: params.campaignId });
    var rows = Store.readAll(CONFIG.SHEETS.CAMPAIGN_RECIPIENTS).filter(function (r) {
      return String(r.campaignId) === String(campaign._id);
    });
    if (params.status) {
      rows = rows.filter(function (r) { return String(r.status).toLowerCase() === String(params.status).toLowerCase(); });
    }
    return rows;
  }

  function cancelCampaign(params) {
    var campaign = getCampaign({ campaignId: params.campaignId });
    if (campaign.status === 'completed' || campaign.status === 'cancelled') {
      throw new GasError('Campaign is already ' + campaign.status + '.', 'INVALID_STATE');
    }
    Store.readAll(CONFIG.SHEETS.CAMPAIGN_RECIPIENTS)
      .filter(function (r) { return String(r.campaignId) === String(campaign._id) && r.status === 'pending'; })
      .forEach(function (r) {
        Store.update(CONFIG.SHEETS.CAMPAIGN_RECIPIENTS, r._id, { status: 'cancelled' });
      });
    var result = Store.update(CONFIG.SHEETS.CAMPAIGNS, campaign._id, { status: 'cancelled', completedAt: nowIso_() });
    if (!activeCampaigns_().length) {
      removeDrainTrigger_();
    }
    return result;
  }

  function retryFailed(params) {
    var campaign = getCampaign({ campaignId: params.campaignId });
    var reset = 0;
    Store.readAll(CONFIG.SHEETS.CAMPAIGN_RECIPIENTS)
      .filter(function (r) { return String(r.campaignId) === String(campaign._id) && r.status === 'failed'; })
      .forEach(function (r) {
        Store.update(CONFIG.SHEETS.CAMPAIGN_RECIPIENTS, r._id, { status: 'pending', error: '' });
        reset++;
      });
    if (reset > 0 && (campaign.status === 'completed' || campaign.status === 'cancelled')) {
      Store.update(CONFIG.SHEETS.CAMPAIGNS, campaign._id, { status: 'queued', completedAt: '' });
    }
    if (reset > 0) {
      ensureDrainTrigger_();
    }
    return { campaignId: campaign._id, requeued: reset };
  }

  function ensureDrainTrigger_() {
    var existing = ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === 'drainCampaigns';
    });
    if (!existing) {
      ScriptApp.newTrigger('drainCampaigns')
        .timeBased()
        .everyMinutes(CONFIG.SCHEDULER.TRIGGER_MINUTES)
        .create();
    }
    return true;
  }

  function removeDrainTrigger_() {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === 'drainCampaigns') {
        ScriptApp.deleteTrigger(t);
      }
    });
    return true;
  }

  function schedulerStatus() {
    var hasTrigger = ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === 'drainCampaigns';
    });
    return { drainTriggerActive: hasTrigger, activeCampaigns: activeCampaigns_().length };
  }

  function safeParseJson_(str) {
    try {
      var v = JSON.parse(str || '{}');
      return v && typeof v === 'object' ? v : {};
    } catch (e) {
      return {};
    }
  }

  return {
    drain: drain,
    listCampaigns: listCampaigns,
    getCampaign: getCampaign,
    getRecipients: getRecipients,
    cancelCampaign: cancelCampaign,
    retryFailed: retryFailed,
    schedulerStatus: schedulerStatus
  };
})();

function drainCampaigns() {
  Scheduler.drain();
}
