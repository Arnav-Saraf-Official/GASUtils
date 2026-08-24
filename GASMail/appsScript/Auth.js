var Auth = (function () {

  function props_() {
    return PropertiesService.getScriptProperties();
  }

  function sha256_(value) {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
    return bytes.map(function (b) {
      var v = (b < 0 ? b + 256 : b).toString(16);
      return v.length === 1 ? '0' + v : v;
    }).join('');
  }

  function ensureApiKey() {
    if (props_().getProperty(CONFIG.PROPS.KEY_HASH)) {
      return null;
    }
    return generateApiKey();
  }

  function generateApiKey() {
    var raw = Utilities.base64EncodeWebSafe(Utilities.getRandomBytes(32)).replace(/=+$/, '');
    props_().setProperty(CONFIG.PROPS.KEY_HASH, sha256_(raw));
    props_().setProperty(CONFIG.PROPS.KEY_CREATED, nowIso_());
    return raw;
  }

  function rotateApiKey() {
    return { apiKey: generateApiKey(), notice: 'Save this key now - it will not be shown again.' };
  }

  function keyInfo() {
    var created = props_().getProperty(CONFIG.PROPS.KEY_CREATED);
    return { hasKey: !!props_().getProperty(CONFIG.PROPS.KEY_HASH), createdAt: created || '' };
  }

  function verify(raw) {
    if (!raw || typeof raw !== 'string') {
      return false;
    }
    var stored = props_().getProperty(CONFIG.PROPS.KEY_HASH);
    if (!stored) {
      throw new GasError('No API key configured. Run gasmailSetup().', 'NOT_INITIALIZED');
    }
    return safeEqual_(sha256_(raw), stored);
  }

  function safeEqual_(a, b) {
    if (a.length !== b.length) { return false; }
    var diff = 0;
    for (var i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  return {
    ensureApiKey: ensureApiKey,
    rotateApiKey: rotateApiKey,
    keyInfo: keyInfo,
    verify: verify
  };
})();
