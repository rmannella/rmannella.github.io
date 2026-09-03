// VAPID public key for Web Push. Safe to commit and required to be public --
// it is the key browsers use to verify that a push came from this app.
//
// The matching PRIVATE key must never appear here or anywhere else in this
// repo. It lives only in Supabase (Edge Functions -> Secrets, as
// VAPID_PRIVATE_KEY) where the send-reminders function signs with it.
//
// Generate a pair with:  npx web-push generate-vapid-keys
// then paste the public half below. See the README's "Reminders that arrive
// when the app is closed" section for the full setup.
window.PUSH_CONFIG = {
  vapidPublicKey: '',
  // The mailto: or https: contact the push service can reach you at, which
  // the Web Push spec requires senders to declare.
  contact: 'mailto:rachel@mvn.com',
};
