/* Déchiffrement ECMA-376 Agile pour fichiers Office protégés par mot de passe.
   Utilise CFB (inclus dans SheetJS) + CryptoJS (fonctionne sur file://). */
window.decryptOfficeFile = function decryptOfficeFile(arrayBuffer, password) {
  'use strict';

  var data = new Uint8Array(arrayBuffer);

  var cfb = XLSX.CFB.read(data, { type: 'array' });
  var infoEntry = XLSX.CFB.find(cfb, '/EncryptionInfo');
  var pkgEntry = XLSX.CFB.find(cfb, '/EncryptedPackage');
  if (!infoEntry || !pkgEntry) throw new Error('Fichier non chiffré ou format inconnu.');

  var infoBuf = new Uint8Array(infoEntry.content);
  var pkgBuf = new Uint8Array(pkgEntry.content);

  var view = new DataView(infoBuf.buffer, infoBuf.byteOffset, infoBuf.byteLength);
  var vMajor = view.getUint16(0, true);
  var vMinor = view.getUint16(2, true);

  if (vMajor === 4 && vMinor === 4) {
    return decryptAgile(infoBuf, pkgBuf, password);
  }
  throw new Error('Type de chiffrement non supporté (version ' + vMajor + '.' + vMinor + ').');

  function decryptAgile(infoBuf, pkgBuf, password) {
    var xmlStr = new TextDecoder('utf-8').decode(infoBuf.slice(8));
    var parser = new DOMParser();
    var xml = parser.parseFromString(xmlStr, 'text/xml');

    var keyDataNode = xml.querySelector('keyData');
    var passwordNode = xml.querySelector('keyEncryptor > p\\:encryptedKey, keyEncryptor > encryptedKey, encryptedKey');
    if (!keyDataNode || !passwordNode) throw new Error('XML de chiffrement invalide.');

    var kd = {
      saltValue: b64ToArr(keyDataNode.getAttribute('saltValue')),
      blockSize: parseInt(keyDataNode.getAttribute('blockSize')),
      keyBits: parseInt(keyDataNode.getAttribute('keyBits')),
      hashAlgo: keyDataNode.getAttribute('hashAlgorithm'),
    };

    var pe = {
      saltValue: b64ToArr(passwordNode.getAttribute('saltValue')),
      blockSize: parseInt(passwordNode.getAttribute('blockSize')),
      keyBits: parseInt(passwordNode.getAttribute('keyBits')),
      hashAlgo: passwordNode.getAttribute('hashAlgorithm'),
      spinCount: parseInt(passwordNode.getAttribute('spinCount')),
      encryptedKeyValue: b64ToArr(passwordNode.getAttribute('encryptedKeyValue')),
    };

    var passBytes = encodeUTF16LE(password);

    // Decrypt data key (skip password verification — XLSX.read validates the result)
    var dataKey = decryptDataKey(pe, passBytes, kd);

    // Decrypt package
    var pkgData = pkgBuf.slice(8);
    var decrypted = decryptPackage(pkgData, dataKey, kd);

    return decrypted.buffer;

    function iterateHash(pe, passBytes) {
      var h = hashDigest(pe.hashAlgo, concat(pe.saltValue, passBytes));
      for (var i = 0; i < pe.spinCount; i++) {
        var iter = new Uint8Array(4);
        new DataView(iter.buffer).setUint32(0, i, true);
        h = hashDigest(pe.hashAlgo, concat(iter, h));
      }
      return h;
    }

    function deriveKeyWithBlock(pe, passBytes, blockKey) {
      var h = iterateHash(pe, passBytes);
      var derivedKey = hashDigest(pe.hashAlgo, concat(h, blockKey));
      return adjustKeyLength(derivedKey, pe.keyBits / 8);
    }

    function decryptDataKey(pe, passBytes, kd) {
      var dataBlockKey = new Uint8Array([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]);
      var key = deriveKeyWithBlock(pe, passBytes, dataBlockKey);
      var decryptedKey = aesCbcDecrypt(key, pe.saltValue, pe.encryptedKeyValue, pe.blockSize);
      return decryptedKey.slice(0, kd.keyBits / 8);
    }

    function decryptPackage(data, key, kd) {
      var segmentSize = 4096;
      var parts = [];
      for (var offset = 0; offset < data.length; offset += segmentSize) {
        var segment = data.slice(offset, offset + segmentSize);
        var segIdx = offset / segmentSize;
        var blockBytes = new Uint8Array(4);
        new DataView(blockBytes.buffer).setUint32(0, segIdx, true);
        var iv = hashDigest(kd.hashAlgo, concat(kd.saltValue, blockBytes));
        iv = adjustIV(iv, kd.blockSize);
        var dec = aesCbcDecryptRaw(key, iv, segment);
        parts.push(dec);
      }
      var actualSize = new DataView(pkgBuf.buffer, pkgBuf.byteOffset, 8).getUint32(0, true);
      var full = concatAll(parts);
      return full.slice(0, actualSize);
    }
  }

  // ── CryptoJS-based primitives ──

  function u8ToWordArray(u8) {
    var words = [];
    for (var i = 0; i < u8.length; i += 4) {
      words.push(
        ((u8[i] || 0) << 24) |
        ((u8[i + 1] || 0) << 16) |
        ((u8[i + 2] || 0) << 8) |
        (u8[i + 3] || 0)
      );
    }
    return CryptoJS.lib.WordArray.create(words, u8.length);
  }

  function wordArrayToU8(wa) {
    var words = wa.words;
    var sigBytes = wa.sigBytes;
    var u8 = new Uint8Array(sigBytes);
    for (var i = 0; i < sigBytes; i++) {
      u8[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
    }
    return u8;
  }

  function hashDigest(algo, data) {
    var wa = u8ToWordArray(data);
    var hash;
    var a = (algo || '').replace('-', '').toUpperCase();
    if (a === 'SHA1' || a === 'SHA160') {
      hash = CryptoJS.SHA1(wa);
    } else if (a === 'SHA256') {
      hash = CryptoJS.SHA256(wa);
    } else if (a === 'SHA384') {
      hash = CryptoJS.SHA384(wa);
    } else if (a === 'SHA512') {
      hash = CryptoJS.SHA512(wa);
    } else {
      throw new Error('Hash non supporté: ' + algo);
    }
    return wordArrayToU8(hash);
  }

  function aesCbcDecrypt(keyBytes, ivBytes, data, blockSize) {
    var iv = adjustIV(ivBytes, blockSize);
    var keyWA = u8ToWordArray(keyBytes);
    var ivWA = u8ToWordArray(iv);
    var dataWA = u8ToWordArray(data);
    var cipherParams = CryptoJS.lib.CipherParams.create({ ciphertext: dataWA });
    var decrypted = CryptoJS.AES.decrypt(cipherParams, keyWA, {
      iv: ivWA,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.NoPadding,
    });
    return wordArrayToU8(decrypted);
  }

  function aesCbcDecryptRaw(keyBytes, iv, data) {
    var padded = data;
    if (data.length % 16 !== 0) {
      padded = new Uint8Array(Math.ceil(data.length / 16) * 16);
      padded.set(data);
    }
    var keyWA = u8ToWordArray(keyBytes);
    var ivWA = u8ToWordArray(iv);
    var dataWA = u8ToWordArray(padded);
    var cipherParams = CryptoJS.lib.CipherParams.create({ ciphertext: dataWA });
    var decrypted = CryptoJS.AES.decrypt(cipherParams, keyWA, {
      iv: ivWA,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.NoPadding,
    });
    return wordArrayToU8(decrypted);
  }

  // ── Utility functions ──

  function b64ToArr(b64) {
    var bin = atob(b64);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function encodeUTF16LE(str) {
    var buf = new Uint8Array(str.length * 2);
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      buf[i * 2] = code & 0xff;
      buf[i * 2 + 1] = (code >> 8) & 0xff;
    }
    return buf;
  }

  function concat(a, b) {
    var c = new Uint8Array(a.length + b.length);
    c.set(a);
    c.set(b, a.length);
    return c;
  }

  function concatAll(arrays) {
    var total = 0;
    for (var i = 0; i < arrays.length; i++) total += arrays[i].length;
    var result = new Uint8Array(total);
    var offset = 0;
    for (var i = 0; i < arrays.length; i++) {
      result.set(arrays[i], offset);
      offset += arrays[i].length;
    }
    return result;
  }

  function adjustKeyLength(key, targetLen) {
    if (key.length === targetLen) return key;
    if (key.length > targetLen) return key.slice(0, targetLen);
    var padded = new Uint8Array(targetLen);
    padded.set(key);
    for (var i = key.length; i < targetLen; i++) padded[i] = 0x36;
    return padded;
  }

  function adjustIV(iv, blockSize) {
    if (iv.length === blockSize) return iv;
    if (iv.length > blockSize) return iv.slice(0, blockSize);
    var padded = new Uint8Array(blockSize);
    padded.set(iv);
    for (var i = iv.length; i < blockSize; i++) padded[i] = 0x36;
    return padded;
  }
};
