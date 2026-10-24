import { test as base, expect, type BrowserContext } from '@playwright/test';
import { AccessStore } from '../../apps/agent/src/access/store.js';

export function createTestInvite() {
  const path = process.env.E2E_INVITE_DB_PATH;
  if (!path) throw new Error('E2E_INVITE_DB_PATH must point to the isolated test database');
  const store = new AccessStore(path);
  try { return store.createInvite('browser test fixture'); }
  finally { store.close(); }
}
export async function verifyContext(context: BrowserContext, baseURL: string, code: string) {
  const response = await context.request.post(new URL('/api/invite/redeem', baseURL).href, {
    headers: { Origin: new URL(baseURL).origin }, data: { code },
  });
  expect(response.status()).toBe(200);
}
export const test = base.extend<{ invitation: { id: string; code: string } }>({
  invitation: [async ({ context, baseURL }, use) => {
    const invitation = createTestInvite();
    await verifyContext(context, baseURL!, invitation.code);
    await use(invitation);
  }, { auto: true }],
});
export { expect };
