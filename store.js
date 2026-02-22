import fs from 'fs';
import path from 'path';

const DATA_PATH = path.resolve('./data.json');

const DEFAULT_USER_STATE = {
  baseline: [],
  lastMessageDate: null,
  threadOpen: false,
};

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      users: typeof parsed?.users === 'object' && parsed.users !== null ? parsed.users : {},
      states: typeof parsed?.states === 'object' && parsed.states !== null ? parsed.states : {},
    };
  } catch {
    return { users: {}, states: {} };
  }
}

let db = loadData();

function normalizeState(state) {
  return {
    baseline: Array.isArray(state?.baseline) ? state.baseline : [],
    lastMessageDate: state?.lastMessageDate ?? null,
    threadOpen: Boolean(state?.threadOpen),
  };
}

function saveData() {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2));
}

export function registerUser(phone) {
  if (!phone) return;
  if (!db.users[phone]) {
    db.users[phone] = {
      phone,
      registeredAt: new Date().toISOString(),
    };
    saveData();
  }
}

export function getUserState(phone) {
  if (!phone) return { ...DEFAULT_USER_STATE, baseline: [] };
  return normalizeState(db.states[phone]);
}

export function updateUserState(phone, state) {
  if (!phone) return;
  db.states[phone] = normalizeState(state);
  saveData();
}
