// Test-only virtual WebAuthn authenticator (Issue #141 Step3 tests). No
// browser/authenticator exists in this test environment, so this hand-builds
// the exact byte structures navigator.credentials.create()/.get() would
// produce for a single ES256 credential -- CBOR attestationObject
// (registration) or raw authenticatorData+signature (authentication) --
// using @simplewebauthn/server's own iso/cose helpers so the encoding
// matches what verifyRegistrationResponse()/verifyAuthenticationResponse()
// expect byte-for-byte. Intentionally minimal: one algorithm (ES256), one
// attestation format ('none'), no extensions -- just enough to drive a real
// register->authenticate round trip through the actual verification code
// instead of mocking it away.

import { generateKeyPairSync, createHash, sign as cryptoSign } from 'node:crypto';
import { isoCBOR, isoBase64URL, isoUint8Array, cose } from '@simplewebauthn/server/helpers';

function pad32(buf) {
  if (buf.length === 32) return buf;
  const out = Buffer.alloc(32);
  buf.copy(out, 32 - buf.length);
  return out;
}

export function generateAuthenticatorKeyPair() {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' });
}

function coseEncodedPublicKey(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  const coseKey = new Map();
  coseKey.set(cose.COSEKEYS.kty, cose.COSEKTY.EC2);
  coseKey.set(cose.COSEKEYS.alg, cose.COSEALG.ES256);
  coseKey.set(cose.COSEKEYS.crv, cose.COSECRV.P256);
  coseKey.set(cose.COSEKEYS.x, pad32(isoBase64URL.toBuffer(jwk.x)));
  coseKey.set(cose.COSEKEYS.y, pad32(isoBase64URL.toBuffer(jwk.y)));
  return isoCBOR.encode(coseKey);
}

function buildClientDataJSON(type, challenge, origin) {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
}

// flags: UP (bit0) + UV (bit2) always; AT (bit6) only when attested
// credential data (registration) is present, per the WebAuthn authenticator
// data layout our routes' requireUserPresence/requireUserVerification
// defaults (both true) expect.
function buildAuthenticatorData({ rpID, counter, attestedCredential }) {
  const rpIdHash = createHash('sha256').update(rpID).digest();
  const flags = attestedCredential ? 0b01000101 : 0b00000101;
  const counterBuf = Buffer.alloc(4);
  counterBuf.writeUInt32BE(counter >>> 0, 0);
  const parts = [rpIdHash, Buffer.from([flags]), counterBuf];
  if (attestedCredential) {
    const { credentialId, publicKeyBytes } = attestedCredential;
    const aaguid = Buffer.alloc(16);
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(credentialId.length, 0);
    parts.push(aaguid, credIdLen, credentialId, publicKeyBytes);
  }
  return isoUint8Array.concat(parts);
}

// Mirrors RegistrationResponseJSON (what @simplewebauthn/browser's
// startRegistration() resolves to), body-shaped for register-verify.
export function createRegistrationResponse({ rpID, origin, challenge, credentialId, publicKey }) {
  const authData = buildAuthenticatorData({
    rpID,
    counter: 0,
    attestedCredential: { credentialId, publicKeyBytes: coseEncodedPublicKey(publicKey) },
  });
  const attestationObject = isoCBOR.encode(new Map([
    ['fmt', 'none'],
    ['attStmt', new Map()],
    ['authData', authData],
  ]));
  const clientDataJSON = buildClientDataJSON('webauthn.create', challenge, origin);
  const id = isoBase64URL.fromBuffer(credentialId);
  return {
    id,
    rawId: id,
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
      attestationObject: isoBase64URL.fromBuffer(attestationObject),
    },
    clientExtensionResults: {},
    type: 'public-key',
  };
}

// Mirrors AuthenticationResponseJSON (startAuthentication()'s resolution),
// body-shaped for authenticate-verify. `counter` is the value this
// (simulated) authenticator claims for this specific assertion -- tests use
// it to exercise both the happy path and counter-replay rejection.
export function createAuthenticationResponse({ rpID, origin, challenge, credentialId, privateKey, counter }) {
  const authData = buildAuthenticatorData({ rpID, counter, attestedCredential: null });
  const clientDataJSON = buildClientDataJSON('webauthn.get', challenge, origin);
  const clientDataHash = createHash('sha256').update(clientDataJSON).digest();
  const signature = cryptoSign('sha256', isoUint8Array.concat([authData, clientDataHash]), privateKey);
  const id = isoBase64URL.fromBuffer(credentialId);
  return {
    id,
    rawId: id,
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
      authenticatorData: isoBase64URL.fromBuffer(authData),
      signature: isoBase64URL.fromBuffer(signature),
    },
    clientExtensionResults: {},
    type: 'public-key',
  };
}
