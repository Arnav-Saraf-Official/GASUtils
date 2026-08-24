var CONFIG = {
  APP_NAME: 'GASMail',
  VERSION: '1.0.0',
  SHEETS: {
    TEMPLATES: 'templates',
    CONTACTS: 'contacts',
    LISTS: 'lists',
    SEND_LOG: 'send_log',
    CAMPAIGNS: 'campaigns',
    CAMPAIGN_RECIPIENTS: 'campaign_recipients',
    CONFIG: '_config'
  },
  LIMITS: {
    MAX_BODY_CHARS: 48000,
    SYNC_MASS_LIMIT: 25,
    CAMPAIGN_BATCH_SIZE: 40,
    QUOTA_SAFETY_MARGIN: 5,
    SEND_PAUSE_MS: 250
  },
  SCHEDULER: {
    TRIGGER_MINUTES: 5
  },
  PROPS: {
    KEY_HASH: 'GASMAIL_API_KEY_HASH',
    KEY_CREATED: 'GASMAIL_API_KEY_CREATED'
  }
};

var SCHEMAS = {
  templates: ['_id', 'name', 'subject', 'htmlBody', 'plainBody', 'mergeFields', 'createdAt', 'updatedAt'],
  contacts: ['_id', 'email', 'name', 'lists', 'notes', 'createdAt', 'updatedAt'],
  lists: ['_id', 'name', 'description', 'createdAt'],
  send_log: ['_id', 'campaignId', 'to', 'cc', 'bcc', 'templateId', 'subject', 'mode', 'status', 'error', 'sentAt'],
  campaigns: ['_id', 'name', 'templateId', 'subject', 'bodyHtml', 'bodyPlain', 'defaultVarsJson', 'status', 'total', 'sent', 'failed', 'createdAt', 'startedAt', 'completedAt'],
  campaign_recipients: ['_id', 'campaignId', 'to', 'varsJson', 'status', 'error', 'sentAt']
};

function gasmailSetup() {
  Store.ensure_();
  var key = Auth.ensureApiKey();
  return {
    initialized: true,
    apiKey: key || '(already set - use admin.rotateApiKey to generate a new one)'
  };
}
