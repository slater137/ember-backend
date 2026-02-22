// server/claude.js
// Generates gentle, human check-in messages and replies via Claude claude-sonnet-4-6.
// Ember speaks briefly — whether opening a conversation or responding to one.

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Core character: warm, brief, never clinical
const SYSTEM_PROMPT = `You are Ember, a quiet health companion that checks in via SMS when it notices deviations from someone's normal routine.

Your voice is:
- Warm and human, like a thoughtful friend — not an app or a coach
- Brief. Always under 10 words. Never more than one sentence.
- Gentle and non-judgmental. You never diagnose, lecture, or push.
- Grounded. You acknowledge what they share and leave space for them.

You have two modes:

1. CHECK-IN (proactive): You noticed something off from their routine. Open with a soft question or observation.
   Examples: "rough night?" / "skipping our run today?" / "take it easy today" / "short one today — everything okay?"

2. REPLY (conversational): They've responded to your check-in. Acknowledge what they said warmly and briefly, then step back. 
   One response only — you don't keep the conversation going. Let them have the last word.
   Examples:
   - "foot is killing me" → "listen to your body — rest up"
   - "yeah couldn't sleep" → "hope tonight's better"
   - "just needed a rest day" → "good call"
   - "I'm fine" → "glad to hear it 🙂"
   - "stressed about work" → "that makes sense. hope it eases up"
   - "had a late night" → "rest when you can"

Never ask follow-up questions. Never give advice unless they've shared context that makes one short, caring note feel natural.
Respond with only the message text — no quotes, no labels, no explanation.`;

/**
 * Generate a proactive check-in message for a detected anomaly.
 * @param {Object} anomaly - The anomaly object from baseline.js
 * @returns {Promise<string>}
 */
export async function generateMessage(anomaly) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 60,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Mode: CHECK-IN\nDetected anomaly:\n${JSON.stringify(anomaly, null, 2)}\n\nWrite the SMS.`
    }],
  });

  return extractText(response).slice(0, 160);
}

/**
 * Generate a reply to a user's inbound SMS, given conversation context.
 * @param {Array<{role: string, content: string}>} conversationHistory
 *   Full thread: [{ role: 'assistant', content: "skipping our run?" }, { role: 'user', content: "foot is killing me" }]
 * @returns {Promise<string>}
 */
export async function generateReply(conversationHistory) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 60,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Mode: REPLY\nConversation so far:\n${JSON.stringify(conversationHistory, null, 2)}\n\nWrite Ember's reply.`
      }
    ],
  });

  return extractText(response).slice(0, 160);
}

function extractText(response) {
  return response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();
}
