var Router = (function () {

  var routes_ = null;

  function routes() {
    if (!routes_) {
      routes_ = {
        'ping': function (p) { return ping_(p); },

        'mail.send': function (p) { return Mail.send(p); },
        'mail.sendTemplated': function (p) { return Mail.sendTemplated(p); },
        'mail.sendMass': function (p) { return Mail.sendMass(p); },
        'mail.previewCampaign': function (p) { return Mail.previewCampaign(p); },
        'mail.quota': function (p) { return Mail.quota(); },

        'template.list': function (p) { return Templates.list(p); },
        'template.get': function (p) { return Templates.get(required_(p, 'templateId')); },
        'template.create': function (p) { return Templates.create(p); },
        'template.update': function (p) { return Templates.update(required_(p, 'templateId'), without_(p, 'templateId')); },
        'template.delete': function (p) { return Templates.remove(required_(p, 'templateId')); },
        'template.preview': function (p) { return Templates.preview({ templateId: required_(p, 'templateId'), vars: p.vars }); },

        'contact.list': function (p) { return Contacts.list(p); },
        'contact.get': function (p) { return Contacts.get(required_(p, 'contactId')); },
        'contact.find': function (p) { return Contacts.findByEmail(required_(p, 'email')); },
        'contact.create': function (p) { return Contacts.create(p); },
        'contact.update': function (p) { return Contacts.update(required_(p, 'contactId'), without_(p, 'contactId')); },
        'contact.delete': function (p) { return Contacts.remove(required_(p, 'contactId')); },
        'contact.import': function (p) { return Contacts.import(p); },

        'list.list': function (p) { return Lists.list(); },
        'list.create': function (p) { return Lists.create(p); },
        'list.delete': function (p) { return Lists.remove(required_(p, 'listId')); },
        'list.contacts': function (p) { return Lists.contacts(p); },
        'list.addContacts': function (p) { return Contacts.addToList(p); },
        'list.removeContacts': function (p) { return Contacts.removeFromList(p); },

        'campaign.create': function (p) { return Mail.sendMass(p); },
        'campaign.list': function (p) { return Scheduler.listCampaigns(p); },
        'campaign.get': function (p) { return Scheduler.getCampaign(p); },
        'campaign.recipients': function (p) { return Scheduler.getRecipients(p); },
        'campaign.cancel': function (p) { return Scheduler.cancelCampaign(p); },
        'campaign.retryFailed': function (p) { return Scheduler.retryFailed(p); },
        'scheduler.status': function (p) { return Scheduler.schedulerStatus(); },

        'log.get': function (p) { return Log.get(p); },

        'admin.keyInfo': function (p) { return Auth.keyInfo(); },
        'admin.endpointInfo': function (p) { return { url: ScriptApp.getService().getUrl() }; },
        'admin.rotateApiKey': function (p) { return Auth.rotateApiKey(); }
      };
    }
    return routes_;
  }

  var PUBLIC_ACTIONS = ['ping'];

  function isPublic(action) {
    return PUBLIC_ACTIONS.indexOf(action) !== -1;
  }

  function dispatch(action, params) {
    params = params || {};
    if (!action || typeof action !== 'string') {
      throw new GasError('Missing "action".', 'BAD_REQUEST');
    }
    var handler = routes()[action];
    if (!handler) {
      throw new GasError('Unknown action: ' + action, 'UNKNOWN_ACTION');
    }
    Store.ensure_();
    return handler(params);
  }

  function safeDispatch(action, params) {
    try {
      return okEnvelope_(dispatch(action, params));
    } catch (err) {
      return errorToEnvelope_(err);
    }
  }

  function webCall(action, paramsJson) {
    var params = {};
    try {
      if (paramsJson) {
        params = JSON.parse(paramsJson);
      }
    } catch (e) {
      return JSON.stringify(failEnvelope_('Invalid JSON params.', 'BAD_REQUEST'));
    }
    return JSON.stringify(safeDispatch(action, params));
  }

  function httpCall(bodyObj) {
    var action = bodyObj.action;
    if (!isPublic(action)) {
      var key = bodyObj.key || bodyObj.apiKey || '';
      var authorized = false;
      try {
        authorized = Auth.verify(String(key));
      } catch (err) {
        return errorToEnvelope_(err);
      }
      if (!authorized) {
        return failEnvelope_('Invalid or missing API key.', 'UNAUTHORIZED');
      }
    }
    return safeDispatch(action, bodyObj.params);
  }

  function required_(params, field) {
    if (params[field] === undefined || params[field] === null || params[field] === '') {
      throw new GasError('"' + field + '" is required.', 'VALIDATION');
    }
    return params[field];
  }

  function without_(obj, key) {
    var copy = {};
    Object.keys(obj).forEach(function (k) {
      if (k !== key) { copy[k] = obj[k]; }
    });
    return copy;
  }

  function ping_(p) {
    return {
      service: CONFIG.APP_NAME,
      version: CONFIG.VERSION,
      time: nowIso_()
    };
  }

  return {
    dispatch: dispatch,
    safeDispatch: safeDispatch,
    webCall: webCall,
    httpCall: httpCall,
    isPublic: isPublic
  };
})();
