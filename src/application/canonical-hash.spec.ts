import { canonicalJson, hashPayload } from './canonical-hash';

describe('canonical-hash', () => {
  it('ignora a ordem das chaves em qualquer nível', () => {
    const a = { b: 1, a: { y: 2, x: [1, { d: 4, c: 3 }] } };
    const b = { a: { x: [1, { c: 3, d: 4 }], y: 2 }, b: 1 };

    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(hashPayload(a)).toBe(hashPayload(b));
  });

  it('preserva a ordem dos arrays', () => {
    expect(hashPayload({ a: [1, 2] })).not.toBe(hashPayload({ a: [2, 1] }));
  });

  it('distingue valores diferentes', () => {
    expect(hashPayload({ amount: '10.00' })).not.toBe(
      hashPayload({ amount: '10.01' }),
    );
    expect(hashPayload({ a: null })).not.toBe(hashPayload({ a: 'null' }));
  });

  it('descarta chaves indefinidas mas mantém null', () => {
    expect(hashPayload({ a: 1, b: undefined })).toBe(hashPayload({ a: 1 }));
    expect(hashPayload({ a: 1, b: null })).not.toBe(hashPayload({ a: 1 }));
  });

  it('gera sha256 hexadecimal determinístico', () => {
    const hash = hashPayload({ a: 1 });

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPayload({ a: 1 })).toBe(hash);
  });
});
