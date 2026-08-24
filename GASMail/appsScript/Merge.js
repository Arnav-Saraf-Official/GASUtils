var Merge = (function () {

  var TOKEN = /\{\{\s*([\w.\-]+?)\s*(?::\s*([^}]*?)\s*)?\}\}/g;

  function lookup_(vars, key) {
    if (vars.hasOwnProperty(key)) {
      return vars[key];
    }
    var parts = key.split('.');
    var cur = vars;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null || typeof cur !== 'object' || !cur.hasOwnProperty(parts[i])) {
        return undefined;
      }
      cur = cur[parts[i]];
    }
    return cur;
  }

  function render(text, vars) {
    vars = vars || {};
    var missing = [];
    var out = String(text == null ? '' : text).replace(TOKEN, function (match, key, def) {
      var value = lookup_(vars, key);
      if (value === undefined || value === null || value === '') {
        if (def !== undefined && def !== '') {
          return def;
        }
        missing.push(key);
        return match;
      }
      return String(value);
    });
    return { text: out, missing: unique_(missing) };
  }

  function extractFields(text) {
    var fields = [];
    String(text == null ? '' : text).replace(TOKEN, function (match, key) {
      fields.push(key);
      return match;
    });
    return unique_(fields);
  }

  function renderMessage(parts, vars) {
    var subject = render(parts.subject, vars);
    var html = parts.htmlBody != null ? render(parts.htmlBody, vars) : null;
    var plain = parts.plainBody != null ? render(parts.plainBody, vars) : null;

    var htmlText = html ? html.text : null;
    var plainText = plain ? plain.text : null;
    if (htmlText && !plainText) {
      plainText = stripHtml_(htmlText);
    }
    if (!htmlText && plainText) {
      htmlText = escapeHtml_(plainText).replace(/\n/g, '<br>');
    }
    if (!htmlText && !plainText) {
      throw new GasError('Message has no body.', 'NO_BODY');
    }

    var missing = unique_([].concat(subject.missing, html ? html.missing : [], plain ? plain.missing : []));
    return {
      subject: subject.text,
      htmlBody: htmlText,
      plainBody: plainText,
      missing: missing
    };
  }

  function escapeHtml_(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function unique_(arr) {
    var seen = {};
    var out = [];
    arr.forEach(function (v) {
      if (!seen[v]) { seen[v] = true; out.push(v); }
    });
    return out;
  }

  return {
    render: render,
    extractFields: extractFields,
    renderMessage: renderMessage
  };
})();
