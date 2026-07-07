import { describe, it, expect, vi } from 'vitest';
import { runValidatedFind } from './data-agent';

const allowList = ['products', 'orders', 'promotions'];

describe('runValidatedFind', () => {
  it('executes a valid query with the enforced limit', async () => {
    const find = vi.fn(async () => [{ _id: '1' }]);
    const r = await runValidatedFind({ collection: 'products', filter: { on_sale: true } }, { find, allowList, limit: 25 });
    expect(r.ok).toBe(true);
    expect(r.rows).toEqual([{ _id: '1' }]);
    expect(find).toHaveBeenCalledWith('products', { on_sale: true }, 25);
  });

  it('rejects and does NOT execute a blacklisted-operator query', async () => {
    const find = vi.fn(async () => []);
    const r = await runValidatedFind({ collection: 'products', filter: { $where: 'x' } }, { find, allowList, limit: 25 });
    expect(r.ok).toBe(false);
    expect(find).not.toHaveBeenCalled();
  });

  it('rejects a disallowed collection', async () => {
    const find = vi.fn(async () => []);
    const r = await runValidatedFind({ collection: 'carts', filter: {} }, { find, allowList, limit: 25 });
    expect(r.ok).toBe(false);
    expect(find).not.toHaveBeenCalled();
  });
});
