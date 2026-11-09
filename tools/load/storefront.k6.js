// Load test for the busiest public paths during a live session: store page, product by code, checkout.
// Run against STAGING only (it creates real unpaid orders that expire with their stock hold):
//   k6 run -e BASE=https://api.staging.livesell.africa -e SLUG=<store> -e CODE=BAG001 -e VARIANT=<variant uuid> tools/load/storefront.k6.js
// Raise CHECKOUT_LIMIT on staging first (checkout is rate limited per IP).
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    browse: { executor: 'ramping-vus', stages: [{ duration: '1m', target: 100 }, { duration: '3m', target: 300 }, { duration: '1m', target: 0 }], exec: 'browse' },
    buy: { executor: 'constant-arrival-rate', rate: 5, timeUnit: '1s', duration: '4m', preAllocatedVUs: 20, exec: 'buy', startTime: '1m' },
  },
  thresholds: {
    'http_req_failed{scenario:browse}': ['rate<0.01'],
    'http_req_duration{scenario:browse}': ['p(95)<500'],
    'http_req_duration{scenario:buy}': ['p(95)<1500'],
  },
};

const BASE = __ENV.BASE;
const SLUG = __ENV.SLUG;

export function browse() {
  check(http.get(`${BASE}/api/v1/store/${SLUG}`), { 'store 200': (r) => r.status === 200 });
  check(http.get(`${BASE}/api/v1/store/${SLUG}/code/${__ENV.CODE}`), { 'code 200': (r) => r.status === 200 });
  sleep(1);
}

export function buy() {
  const phone = `+23481${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const r = http.post(`${BASE}/api/v1/store/${SLUG}/checkout`, JSON.stringify({
    customer: { fullName: 'Load Test', phone }, items: [{ variantId: __ENV.VARIANT, quantity: 1 }],
    shippingAddress: { line1: '1 Test Road', city: 'Ikeja', state: 'Lagos' },
  }), { headers: { 'Content-Type': 'application/json' } });
  // 409 = sold out: correct behaviour once stock runs out (never oversold).
  check(r, { 'checkout 201 or sold out': (x) => x.status === 201 || x.status === 409 });
}
