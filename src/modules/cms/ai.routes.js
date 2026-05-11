/**
 * ai.routes.js — Phase 5.2 AI CMS suggestions.
 *
 * Mounted at /cms-ai. Single endpoint that asks Claude to rewrite a
 * piece of CMS copy in N variants.
 *
 *   POST /cms-ai/admin/suggest
 *     body: { kind, text, locale?, tone?, count? }
 *     kinds: 'headline' | 'subhead' | 'meta_description' | 'cta_label'
 *
 *   200 → { success, data: [{ text, rationale }] }
 *
 * Fail-soft: if ANTHROPIC_API_KEY isn't set, returns three canned
 * fallbacks based on the input so the admin UI can still render
 * suggestions in dev/staging without a Claude key.
 *
 * Auth: super_admin or admin (CMS_WRITE), country-scope respected
 * implicitly because the helper just rewrites supplied text — it
 * doesn't access any country-tagged data.
 *
 * Rate limit: per-user 30/min via existing rateLimitWrite — keeps a
 * misbehaving editor from hammering the Anthropic API.
 */

import { Router } from 'express';
import { z } from 'zod';
import { adminGuard, permGuard } from '../../middleware/role.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { rateLimitWrite } from '../../middleware/rateLimit.middleware.js';
import { auditAdmin } from '../../middleware/audit.middleware.js';
import { recordAudit } from '../audit/audit.service.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { PERMS } from '../../config/rbac.js';

const r = Router();

const KIND_PROMPTS = {
  headline:         { label: 'headline',         maxChars: 80,  hint: 'punchy, action-led, no clichés' },
  subhead:          { label: 'sub-headline',     maxChars: 160, hint: 'a single concrete benefit + how' },
  meta_description: { label: 'meta description', maxChars: 160, hint: 'natural language, includes the primary keyword once, ends with a CTA verb' },
  cta_label:        { label: 'CTA button label', maxChars: 24,  hint: 'imperative verb + outcome; no punctuation' },
};

const suggestSchema = z.object({
  kind:   z.enum(Object.keys(KIND_PROMPTS)),
  text:   z.string().min(1).max(2000),
  locale: z.string().min(2).max(8).default('en'),
  tone:   z.enum(['neutral', 'friendly', 'urgent', 'professional']).default('neutral'),
  count:  z.number().int().min(1).max(5).default(3),
});

/**
 * Build the prompt + parse Claude's response. Returns:
 *   [{ text, rationale }]
 * The model is asked to emit JSON; we parse defensively and fall back
 * to a line-split heuristic if parsing fails.
 */
async function callClaude({ kind, text, locale, tone, count }) {
  const cfg = KIND_PROMPTS[kind];
  const langName = locale === 'ar' ? 'Arabic'
                 : locale === 'hi' ? 'Hindi'
                 : locale === 'de' ? 'German'
                 : 'English';

  const systemPrompt = [
    `You rewrite ${cfg.label} copy for QuickHire, a multi-country tech-talent marketplace.`,
    `Always respect:`,
    `  • max ${cfg.maxChars} characters per variant`,
    `  • ${cfg.hint}`,
    `  • locale: ${langName} (write in ${langName})`,
    `  • tone: ${tone}`,
    `Output STRICT JSON: {"variants":[{"text":"...","rationale":"..."}]}`,
    `No prose outside the JSON. No markdown. Exactly ${count} variants.`,
  ].join('\n');

  const userMessage = `Original ${cfg.label}: "${text}"\n\nProduce ${count} improved variants. Each variant's rationale is one short sentence explaining why it's better.`;

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body,
    // 15s timeout — Claude haiku is fast; anything slower is a fault
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    logger.warn({ status: response.status, errText: errText.slice(0, 200) }, 'claude AI suggest non-2xx');
    throw new Error(`Claude API error: ${response.status}`);
  }

  const data = await response.json();
  const raw  = data.content?.[0]?.text || '';

  // Try strict JSON parse first
  try {
    const m = raw.match(/\{[\s\S]*\}/); // tolerate prose around JSON
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (Array.isArray(parsed.variants) && parsed.variants.length) {
        return parsed.variants
          .filter((v) => v && typeof v.text === 'string')
          .slice(0, count)
          .map((v) => ({ text: v.text.slice(0, cfg.maxChars), rationale: String(v.rationale || '').slice(0, 200) }));
      }
    }
  } catch (e) { /* fall through */ }

  // Fallback: split lines, treat each as a variant
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, count);
  return lines.map((line) => ({ text: line.replace(/^[-*•\d\.\)\s]+/, '').slice(0, cfg.maxChars), rationale: '' }));
}

/**
 * Canned fallback variants when ANTHROPIC_API_KEY is absent. Keeps the
 * admin UI working in dev / when ops haven't provisioned Claude yet.
 */
function fallbackVariants({ kind, text, count }) {
  const verbs = ['Try', 'Discover', 'Get'];
  if (kind === 'cta_label') {
    return ['Book Now', 'Get Started', 'Try Free'].slice(0, count).map((t) => ({ text: t, rationale: 'Default CTA library suggestion (no AI key configured)' }));
  }
  return Array.from({ length: count }).map((_, i) => ({
    text: `${verbs[i % verbs.length]} ${text}`.slice(0, 80),
    rationale: 'Heuristic fallback — set ANTHROPIC_API_KEY for real suggestions',
  }));
}

// POST /cms-ai/admin/suggest
r.post('/admin/suggest',
  adminGuard,
  permGuard(PERMS.CMS_WRITE),
  rateLimitWrite(),
  auditAdmin,
  validate(suggestSchema),
  asyncHandler(async (req, res) => {
    const { kind, text, locale, tone, count } = req.body;

    let variants;
    let model = 'fallback';
    if (env.ANTHROPIC_API_KEY) {
      try {
        variants = await callClaude({ kind, text, locale, tone, count });
        model = 'claude-haiku-4-5';
      } catch (err) {
        logger.warn({ err: err.message, kind }, 'AI suggest failed, returning fallback');
        variants = fallbackVariants({ kind, text, count });
      }
    } else {
      variants = fallbackVariants({ kind, text, count });
    }

    // Audit so we can review what AI is being asked + what it returned.
    // Useful for prompt tuning + abuse detection.
    await recordAudit(req, {
      action: 'cms.ai.suggest',
      resourceType: 'cms_ai',
      resourceId: null,
      after: { kind, locale, tone, count, model, variantsCount: variants.length, inputLen: text.length },
    });

    res.json({ success: true, data: variants, meta: { model, kind, locale, tone } });
  }),
);

export default r;
