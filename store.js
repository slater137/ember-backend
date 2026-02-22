// server/store.js
// Persists user baselines with a rolling 30-day window.
// Uses a JSON file by default — swap for Postgres/Redis in production.
//
// Schema per user:
// {
//   phone: "+14155550000",
//   registeredAt: "2024-01-01T00:00:00Z",
//   snapshots: [ ...last 30 days of health data ],
//   lastSentAt: "2024-01-01T00:00:00Z" | null,
//   lastAnomalyType: "late_wake" | null,
//   conversation: [
//     { role: "assistant", content: "skipping our run today?", timestamp: "..." },
//     { role: "user",      content: "foot is killing me",      timestamp: "..." },
//     { role: "assistant", content: "listen to your body — rest up", timestamp: "..." }
//   ]
//   // Conversation resets each day — Ember only replies within the same day's thread
// }

import fs from 'fs/promises';
import path from 'path';
import { computeBaseline } from './baseline.js';

const DB_PATH = path.resolve('./data/users.json');
const BASELINE_WINDOW_DAYS = 30;

// ── Internal helpers ──────────────────────────────────────────────────────────

async function readDB() {
  try {
    const raw = await fs.readFile(DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeDB(db) {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
}

function isToday(isoString) {
  if (!isoString) return false;
  const d = new Date(isoString);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() &&
         d.getMonth() === now.getMonth() &&
         d.getDate() === now.getDate();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register a new user (idempotent — safe to call multiple times).
 */
export async function registerUser(phone) {
  const db = await readDB();
  if (!db[phone]) {
    db[phone] = {
      phone,
      registeredAt: new Date().toISOString(),
      snapshots: [],
      lastSentAt: null,
      lastAnomalyType: null,
      conversation: [],
    };
    await writeDB(db);
  }
}

/**
 * Get the computed baseline for a user, or null if insufficient data.
 */
export async function getBaseline(phone) {
  const db = await readDB();
  const user = db[phone];
  if (!user || user.snapshots.length === 0) return null;

  // Enforce cooldown: don't send more than one proactive check-in per day
  if (user.lastSentAt && isToday(user.lastSentAt)) {
    return { _cooldown: true, sampleCount: 0 };
  }

  return computeBaseline(user.snapshots);
}

/**
 * Append today's snapshot to the user's history and trim to 30-day window.
 */
export async function updateBaseline(phone, snapshot) {
  const db = await readDB();
  if (!db[phone]) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - BASELINE_WINDOW_DAYS);

  db[phone].snapshots = [
    ...db[phone].snapshots.filter(s => new Date(s.timestamp) > cutoff),
    snapshot,
  ];

  await writeDB(db);
}

/**
 * Record that Ember sent a proactive check-in message.
 * Starts a fresh conversation thread for the day.
 */
export async function recordSent(phone, anomalyType, messageText) {
  const db = await readDB();
  if (!db[phone]) return;
  const now = new Date().toISOString();
  db[phone].lastSentAt = now;
  db[phone].lastAnomalyType = anomalyType;
  // Start fresh conversation for today
  db[phone].conversation = [{
    role: 'assistant',
    content: messageText,
    timestamp: now,
  }];
  await writeDB(db);
}

/**
 * Get the active conversation thread for a user.
 * Returns null if there's no conversation from today, or if Ember already replied.
 */
export async function getConversation(phone) {
  const db = await readDB();
  const user = db[phone];
  if (!user || !user.conversation?.length) return null;

  // Only reply within today's thread
  const firstMessage = user.conversation[0];
  if (!isToday(firstMessage.timestamp)) return null;

  // Ember only replies once — if the last message is already from Ember, stay quiet
  const lastMessage = user.conversation[user.conversation.length - 1];
  if (lastMessage.role === 'assistant' && user.conversation.length > 1) return null;

  return user.conversation;
}

/**
 * Append a user's inbound reply to their conversation thread.
 */
export async function appendUserMessage(phone, text) {
  const db = await readDB();
  if (!db[phone]) return;
  db[phone].conversation = db[phone].conversation ?? [];
  db[phone].conversation.push({
    role: 'user',
    content: text,
    timestamp: new Date().toISOString(),
  });
  await writeDB(db);
}

/**
 * Append Ember's reply to the conversation thread.
 */
export async function appendAssistantMessage(phone, text) {
  const db = await readDB();
  if (!db[phone]) return;
  db[phone].conversation = db[phone].conversation ?? [];
  db[phone].conversation.push({
    role: 'assistant',
    content: text,
    timestamp: new Date().toISOString(),
  });
  await writeDB(db);
}
