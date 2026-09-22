// GPG vault (plan: gpg-agent-vault) PRF step-up ceremony helper.
//
// This CANNOT reuse @simplewebauthn/browser's startAuthentication(): that
// library converts every other binary field (challenge, allowCredentials[].id,
// response buffers) between base64url strings and ArrayBuffers, but does NOT
// touch the `extensions` field at all -- verified against
// @simplewebauthn/browser@14.0.0's actual source while building this
// feature. optionsJSON.extensions.prf.eval.first arrives from the server as
// a base64url STRING; passed straight through to navigator.credentials.get()
// it would be rejected (a WebIDL BufferSource cannot be a plain string), and
// prf.results.first comes back as a raw ArrayBuffer that still needs
// encoding for the fetch() body. Every other field below IS still converted
// by hand for the same reason.
//
// Used for setup / add-credential / unlock / delete (see routes/gpgVault.js)
// -- every ceremony that needs a live PRF evaluation, as opposed to ordinary
// login (routes/auth.js), which never touches PRF at all.
//
// Security audit F6: the server sends per-credential salts
// (prf.evalByCredential) so the authenticator evaluates PRF over each
// credential's own salt. A `second` salt (next-salt rotation) used to be
// requested for unlock; that rotation is disabled (vuln_scan M4, see
// rotationFor in routes/gpgVault.js), so the server no longer sends it --
// this helper still handles a `second` input/result if one ever appears
// again, purely as a passthrough.

import { base64URLStringToBuffer, bufferToBase64URLString } from '@simplewebauthn/browser';

// optionsJSON is exactly what one of the gpg-vault *-options endpoints
// returns (generateAuthenticationOptions() output, with extensions.prf.eval.first
// as a base64url string). Returns a JSON-serializable response body shaped
// for the matching *-verify endpoint, or throws with a human-readable
// message (cancelled ceremony, or a non-PRF-capable authenticator).
function prfValuesToBuffers(values) {
  const out = { first: base64URLStringToBuffer(values.first) };
  if (values.second) out.second = base64URLStringToBuffer(values.second);
  return out;
}

function prfInputsToBuffers(prf) {
  const out = {};
  if (prf?.eval) out.eval = prfValuesToBuffers(prf.eval);
  if (prf?.evalByCredential) {
    out.evalByCredential = Object.fromEntries(
      Object.entries(prf.evalByCredential).map(([id, values]) => [id, prfValuesToBuffers(values)]),
    );
  }
  return out;
}

export async function getPrfAssertion(optionsJSON) {
  const publicKey = {
    ...optionsJSON,
    challenge: base64URLStringToBuffer(optionsJSON.challenge),
    allowCredentials: optionsJSON.allowCredentials?.map((c) => ({
      ...c,
      id: base64URLStringToBuffer(c.id),
    })),
    extensions: {
      ...optionsJSON.extensions,
      prf: prfInputsToBuffers(optionsJSON.extensions?.prf),
    },
  };

  let credential;
  try {
    credential = await navigator.credentials.get({ publicKey });
  } catch (err) {
    throw new Error(err?.message || '認証がキャンセルされました');
  }
  if (!credential) {
    throw new Error('認証がキャンセルされました');
  }

  const prfResults = credential.getClientExtensionResults()?.prf?.results;
  const prfFirst = prfResults?.first;
  if (!prfFirst) {
    throw new Error('このパスキーはPRF (クイックアンロック) に対応していません。別のパスキーで再試行してください。');
  }

  return {
    id: credential.id,
    rawId: bufferToBase64URLString(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64URLString(credential.response.clientDataJSON),
      authenticatorData: bufferToBase64URLString(credential.response.authenticatorData),
      signature: bufferToBase64URLString(credential.response.signature),
      userHandle: credential.response.userHandle ? bufferToBase64URLString(credential.response.userHandle) : undefined,
    },
    clientExtensionResults: {
      prf: {
        results: {
          first: bufferToBase64URLString(prfFirst),
          ...(prfResults?.second ? { second: bufferToBase64URLString(prfResults.second) } : {}),
        },
      },
    },
  };
}
