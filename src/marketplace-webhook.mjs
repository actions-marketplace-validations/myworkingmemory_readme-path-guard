import { createHmac, timingSafeEqual } from 'node:crypto';

// Free-plan event receipt only. Paid plans stay disabled until entitlement and
// billing-state handling are implemented, verified and separately approved.
export function receiveMarketplaceEvent({ rawBody, signature, event, secret, freePlanId }) {
  if (!secret) return { status: 503, body: 'Event receiver is not configured.' };
  if (!Buffer.isBuffer(rawBody) || rawBody.length > 1048576) return { status: 413, body: 'Payload too large.' };
  if (!/^sha256=[a-f0-9]{64}$/.test(signature || '')) return { status: 401, body: 'Invalid signature.' };
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return { status: 401, body: 'Invalid signature.' };
  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return { status: 400, body: 'Invalid JSON.' }; }
  if (event === 'ping') return { status: 200, body: 'OK' };
  if (event !== 'marketplace_purchase') return { status: 202, body: 'Ignored.' };
  if (!freePlanId) return { status: 503, body: 'Approved free plan is not configured.' };
  if (!['purchased', 'cancelled', 'changed', 'pending_change', 'pending_change_cancelled'].includes(payload.action)) return { status: 400, body: 'Unsupported purchase event.' };
  const plan = payload.marketplace_purchase?.plan;
  if (!plan || String(plan.id) !== String(freePlanId) || String(plan.price_model).toLowerCase() !== 'free'
    || plan.monthly_price_in_cents !== 0 || plan.yearly_price_in_cents !== 0) return { status: 409, body: 'Only the approved free plan is enabled.' };
  // No purchased entitlement is needed for the sole free plan. Cancellation is
  // acknowledged; removing App access is controlled by GitHub uninstallation.
  return { status: 200, body: 'Free-plan event received.' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.statusCode = 405; res.end('POST required.'); return; }
  const chunks = []; let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1048576) { res.statusCode = 413; res.end('Payload too large.'); return; }
      chunks.push(chunk);
    }
    const result = receiveMarketplaceEvent({ rawBody: Buffer.concat(chunks), signature: req.headers['x-hub-signature-256'], event: req.headers['x-github-event'], secret: process.env.MARKETPLACE_WEBHOOK_SECRET, freePlanId: process.env.MARKETPLACE_FREE_PLAN_ID });
    res.statusCode = result.status; res.setHeader('content-type', 'text/plain; charset=utf-8'); res.end(result.body);
  } catch { res.statusCode = 400; res.end('Invalid request.'); }
}
