const webpush = require('web-push');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@desencajado.pe';

const configured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (configured) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

function isConfigured() {
  return configured;
}

function publicKey() {
  return VAPID_PUBLIC_KEY;
}

// Envía la notificación y reporta si la suscripción quedó inválida (404/410)
// para que el llamador la borre de la base de datos.
async function sendToSubscription(subscription, payload) {
  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload)
    );
    return { ok: true };
  } catch (err) {
    const gone = err.statusCode === 404 || err.statusCode === 410;
    return { ok: false, gone };
  }
}

module.exports = { isConfigured, publicKey, sendToSubscription };
