import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { receiveMarketplaceEvent } from '../src/marketplace-webhook.mjs';
const secret = 'synthetic-test-secret';
function event(payload, type = 'marketplace_purchase') {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return { rawBody, event: type, secret, freePlanId: '7', signature: `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}` };
}
test('verified free events and retries are accepted without entitlement side effects', () => {
  for (const action of ['purchased', 'cancelled', 'changed', 'pending_change', 'pending_change_cancelled']) {
    const input = event({ action, marketplace_purchase: { plan: { id: 7, price_model: 'FREE', monthly_price_in_cents: 0, yearly_price_in_cents: 0 } } });
    assert.equal(receiveMarketplaceEvent(input).status, 200);
    assert.equal(receiveMarketplaceEvent(input).status, 200);
  }
});
test('invalid signatures, oversized payloads and unconfigured receivers fail closed', () => {
  assert.equal(receiveMarketplaceEvent({ ...event({}, 'ping'), signature: 'sha256=' + '0'.repeat(64) }).status, 401);
  assert.equal(receiveMarketplaceEvent({ ...event({}), rawBody: Buffer.alloc(1048577) }).status, 413);
  assert.equal(receiveMarketplaceEvent({ ...event({}), secret: '' }).status, 503);
});
test('paid events are rejected until billing and approval exist', () => {
  assert.equal(receiveMarketplaceEvent(event({ action: 'purchased', marketplace_purchase: { plan: { price_model: 'FLAT_RATE' } } })).status, 409);
});
test('lowercase free is accepted only for the approved zero-price plan', () => {
  const payload = { action: 'purchased', marketplace_purchase: { plan: { id: 7, price_model: 'free', monthly_price_in_cents: 0, yearly_price_in_cents: 0 } } };
  assert.equal(receiveMarketplaceEvent(event(payload)).status, 200);
  assert.equal(receiveMarketplaceEvent({ ...event(payload), freePlanId: '8' }).status, 409);
  payload.marketplace_purchase.plan.monthly_price_in_cents = 1;
  assert.equal(receiveMarketplaceEvent(event(payload)).status, 409);
});
test('ping accepted; unrelated events do not access payload data', () => {
  assert.equal(receiveMarketplaceEvent(event({}, 'ping')).status, 200);
  assert.equal(receiveMarketplaceEvent(event({}, 'push')).status, 202);
});
