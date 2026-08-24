function doGet(e) {
  Store.ensure_();
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle(CONFIG.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  var body = null;
  try {
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
  } catch (err) {
    return jsonOut_(failEnvelope_('Invalid JSON body.', 'BAD_REQUEST'));
  }
  if (!body || typeof body !== 'object' || !body.action) {
    return jsonOut_(failEnvelope_('Body must be JSON with an "action" field.', 'BAD_REQUEST'));
  }
  return jsonOut_(Router.httpCall(body));
}

function webCall(action, paramsJson) {
  return Router.webCall(action, paramsJson);
}

function jsonOut_(envelope) {
  return ContentService
    .createTextOutput(JSON.stringify(envelope))
    .setMimeType(ContentService.MimeType.JSON);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
