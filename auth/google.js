const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';

function buildAuthUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
  const params = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) throw new Error('GOOGLE_TOKEN_EXCHANGE_FAILED');
  return res.json();
}

// Google valida la firma RS256 del id_token en este endpoint; evitamos
// reimplementar la verificación JWKS/RSA para una app de este tamaño.
async function verifyIdToken(idToken, clientId) {
  const res = await fetch(`${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(idToken)}`);
  if (!res.ok) throw new Error('GOOGLE_TOKEN_INVALID');
  const payload = await res.json();
  if (payload.aud !== clientId) throw new Error('GOOGLE_TOKEN_AUD_MISMATCH');
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
    throw new Error('GOOGLE_TOKEN_ISS_MISMATCH');
  }
  return payload;
}

module.exports = { buildAuthUrl, exchangeCode, verifyIdToken };
