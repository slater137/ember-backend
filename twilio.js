// server/twilio.js
// Sends SMS via Twilio. One message per detected anomaly, never more.

import twilio from 'twilio';

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER; // Your Twilio number, e.g. +15005550006

/**
 * Send a single SMS to the user.
 * @param {string} to - Recipient phone number (E.164 format, e.g. +14155552671)
 * @param {string} body - Message text
 */
export async function sendSMS(to, body) {
  await client.messages.create({
    from: FROM_NUMBER,
    to,
    body,
  });
}
