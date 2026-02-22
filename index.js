// server/index.js
// Ember backend — receives health snapshots, detects anomalies, sends SMS.
// Also handles inbound SMS replies from Twilio.

import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';
import twilio from 'twilio';
import { sendSMS } from './twilio.js';
import { registerUser } from './store.js';

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded webhooks

const PORT = process.env.PORT || 3000;
const BASELINE_LIMIT = 30;
const STATE_PATH = path.resolve('./data/runtime-state.json');
const userState = new Map();
let stateLoaded = false;
let stateLoadPromise = null;
let stateWriteChain = Promise.resolve();

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

function getUserState(phone) {
  if (!userState.has(phone)) {
    userState.set(phone, {
      baseline: [],
      lastMessageDate: null,
      threadOpen: false,
    });
  }
  return userState.get(phone);
}

function getExistingUserState(phone) {
  return userState.get(phone) ?? null;
}

function isSameDay(isoString, now = new Date()) {
  if (!isoString) return false;
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return false;
  return date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
}

async function ensureStateLoaded() {
  if (stateLoaded) return;
  if (stateLoadPromise) {
    await stateLoadPromise;
    return;
  }

  stateLoadPromise = (async () => {
    try {
      const raw = await fs.readFile(STATE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [phone, value] of Object.entries(parsed)) {
        userState.set(phone, {
          baseline: Array.isArray(value?.baseline) ? value.baseline : [],
          lastMessageDate: value?.lastMessageDate ?? null,
          threadOpen: Boolean(value?.threadOpen),
        });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[Ember] Failed loading runtime state:', err);
      }
    } finally {
      stateLoaded = true;
    }
  })();

  await stateLoadPromise;
}

async function persistState() {
  const snapshot = Object.fromEntries(userState);
  stateWriteChain = stateWriteChain
    .then(async () => {
      await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
      await fs.writeFile(STATE_PATH, JSON.stringify(snapshot, null, 2));
    })
    .catch((err) => {
      console.error('[Ember] Failed persisting runtime state:', err);
    });
  await stateWriteChain;
}

function twilioValidationUrl(req) {
  if (process.env.TWILIO_INBOUND_URL) {
    return process.env.TWILIO_INBOUND_URL;
  }
  return `${req.protocol}://${req.get('host')}${req.originalUrl}`;
}

function isValidTwilioSignature(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.get('X-Twilio-Signature');
  if (!authToken || !signature) return false;

  try {
    return twilio.validateRequest(
      authToken,
      signature,
      twilioValidationUrl(req),
      req.body
    );
  } catch {
    return false;
  }
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values, mean) {
  const variance = values.reduce((sum, value) => {
    const diff = value - mean;
    return sum + (diff * diff);
  }, 0) / values.length;
  return Math.sqrt(variance);
}

function detectTwoSigma(value, history) {
  if (!Number.isFinite(value) || history.length < 2) return null;
  const mean = average(history);
  const stddev = standardDeviation(history, mean);
  if (!Number.isFinite(stddev)) return null;

  if (stddev === 0) {
    const delta = value - mean;
    if (Math.abs(delta) < 1e-9) return null;
    return {
      mean,
      stddev,
      zScore: delta > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
    };
  }

  const zScore = (value - mean) / stddev;
  if (Math.abs(zScore) < 2) return null;
  return { mean, stddev, zScore };
}

function extractClaudeText(response) {
  return response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();
}

function toSentenceCase(text) {
  const cleaned = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function normalizeRunPhrase(text) {
  const cleaned = (text ?? '').replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 4) return 'Cutting our run short?';
  if (!cleaned.toLowerCase().includes('our run')) return 'Cutting our run short?';
  return toSentenceCase(cleaned);
}

function normalizeAcknowledgment(text) {
  const cleaned = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Thanks for sharing.';
  if (cleaned.includes('?')) return 'Thanks for sharing.';
  const sentenceCount = cleaned
    .split(/[.!?]+/)
    .map(part => part.trim())
    .filter(Boolean).length;
  if (sentenceCount !== 1) return 'Thanks for sharing.';
  return toSentenceCase(cleaned);
}

async function generateRunPhrase(styleTarget, severity) {
  if (!anthropic) return styleTarget;

  const context = {
    routine: 'weekday run',
    direction: 'below baseline',
    constraint: '2-4 words',
    shared_language: 'our run',
    no_advice: true,
    no_interpretation: true,
    severity,
    style_target: styleTarget,
  };

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 30,
    system: 'You produce SMS phrasing only. Output 2-4 words in sentence case. No advice. No interpretation. Use "our run". If severity is sharp_drop, stay close to the style target. Return only the phrase.',
    messages: [{
      role: 'user',
      content: `Structured context:\n${JSON.stringify(context, null, 2)}`,
    }],
  });

  return normalizeRunPhrase(extractClaudeText(response));
}

async function generateAcknowledgment(inboundText) {
  if (!anthropic) return 'Thanks for sharing.';

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 40,
    system: 'Write one short acknowledgment sentence in sentence case that closes the loop. No advice. No follow-up questions. No interpretation. Return only the sentence.',
    messages: [{
      role: 'user',
      content: `User message: ${inboundText}`,
    }],
  });

  return normalizeAcknowledgment(extractClaudeText(response));
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /register
 * Called once during iOS onboarding to save user's phone number.
 */
app.post('/register', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });

  try {
    await registerUser(phone);
    console.log(`[Ember] Registered user: ${phone}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Ember] Registration error:', err);
    res.status(500).json({ error: 'registration failed' });
  }
});

/**
 * POST /sync
 * Receives a health snapshot from the iOS app.
 * Runs anomaly detection — sends SMS if a deviation is found.
 */
app.post('/sync', async (req, res) => {
  const snapshot = req.body;
  const { phone } = snapshot;

  if (!phone) return res.status(400).json({ error: 'phone required' });

  try {
    await ensureStateLoaded();
    const state = getUserState(phone);
    const alreadyMessagedToday = isSameDay(state.lastMessageDate);
    const sleepHistory = state.baseline
      .map(item => item.sleep_duration_hours)
      .filter(value => Number.isFinite(value));
    const runHistory = state.baseline
      .map(item => item.running_minutes)
      .filter(value => Number.isFinite(value));

    let anomaly = null;
    let message = null;

    const sleepAnomaly = detectTwoSigma(snapshot.sleep_duration_hours, sleepHistory);
    if (sleepAnomaly) {
      if (snapshot.sleep_duration_hours < sleepAnomaly.mean) {
        message = 'Short night?';
      } else if (snapshot.sleep_duration_hours > sleepAnomaly.mean) {
        message = 'Long night?';
      }
      if (message) {
        anomaly = {
          type: 'sleep_duration_hours',
          zScore: sleepAnomaly.zScore,
        };
      }
    }

    if (!message) {
      const runAnomaly = detectTwoSigma(snapshot.running_minutes, runHistory);
      if (runAnomaly && snapshot.running_minutes < runAnomaly.mean) {
        const severeDrop = runAnomaly.mean > 0 && snapshot.running_minutes <= runAnomaly.mean * 0.5;
        const styleTarget = severeDrop ? 'Cutting our run short?' : 'Our run today?';
        const severity = severeDrop ? 'sharp_drop' : 'below_baseline';
        message = await generateRunPhrase(styleTarget, severity);
        anomaly = {
          type: 'running_minutes',
          zScore: runAnomaly.zScore,
        };
      }
    }

    if (message && !alreadyMessagedToday) {
      await sendSMS(phone, message);
      state.threadOpen = true;
      state.lastMessageDate = new Date().toISOString();
      console.log(`[Ember] Sent to ${phone}: "${message}"`);
    } else if (message) {
      console.log(`[Ember] Cooldown active for ${phone}; not sending duplicate message`);
    }

    state.baseline.push({
      sleep_duration_hours: snapshot.sleep_duration_hours,
      running_minutes: snapshot.running_minutes,
    });
    if (state.baseline.length > BASELINE_LIMIT) {
      state.baseline.shift();
    }
    await persistState();

    res.json({ ok: true, anomaly: anomaly ?? null });
  } catch (err) {
    console.error('[Ember] Sync error:', err);
    res.status(500).json({ error: 'sync failed' });
  }
});

/**
 * POST /sms/inbound
 * Twilio webhook — fires when a user replies to Ember's SMS.
 *
 * Configure in Twilio Console:
 *   Phone Number → Messaging → "A message comes in" → Webhook → POST
 *   URL: https://your-ember-server.com/sms/inbound
 */
app.post('/sms/inbound', async (req, res) => {
  if (!isValidTwilioSignature(req)) {
    console.warn('[Ember] Rejected inbound SMS: invalid Twilio signature');
    return res.status(403).send('forbidden');
  }

  const from = req.body.From;   // User's phone number, E.164
  const body = (req.body.Body ?? '').trim();

  console.log(`[Ember] Inbound from ${from}: "${body}"`);

  // Always respond with empty TwiML — Twilio requires it
  // We send our reply via the REST API, not TwiML, so we control timing
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  if (!from || !body) return;

  await ensureStateLoaded();
  const state = getExistingUserState(from);
  if (!state) return;
  if (!state.threadOpen) return;

  try {
    const reply = await generateAcknowledgment(body);
    await sendSMS(from, reply);
    console.log(`[Ember] Replied to ${from}: "${reply}"`);
  } catch (err) {
    console.error('[Ember] Inbound SMS error:', err);
  } finally {
    state.threadOpen = false;
    await persistState();
  }
});

// Health check
app.get('/health', (_, res) => res.json({ status: 'ember is burning' }));

app.listen(PORT, () => {
  console.log(`🔥 Ember server running on port ${PORT}`);
});
