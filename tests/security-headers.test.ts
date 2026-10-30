import { describe, it, expect } from 'vitest';
import { buildSecurityHeaders, buildContentSecurityPolicy } from '@/lib/core/security-headers';
import nextConfig from '../next.config';

const get = (h: { key: string; value: string }[], k: string) => h.find((x) => x.key === k)?.value;

describe('security headers', () => {
  it('production includes all required headers including HSTS', () => {
    const h = buildSecurityHeaders(true);
    expect(get(h, 'Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(get(h, 'X-Frame-Options')).toBe('DENY');
    expect(get(h, 'X-Content-Type-Options')).toBe('nosniff');
    expect(get(h, 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(get(h, 'Permissions-Policy')).toContain('camera=()');
    expect(get(h, 'Strict-Transport-Security')).toMatch(/max-age=\d+/);
  });
  it('non-production omits HSTS and allows dev eval only there', () => {
    const dev = buildSecurityHeaders(false);
    expect(get(dev, 'Strict-Transport-Security')).toBeUndefined();
    expect(buildContentSecurityPolicy(false)).toContain("'unsafe-eval'");
    expect(buildContentSecurityPolicy(true)).not.toContain("'unsafe-eval'");
    expect(buildContentSecurityPolicy(true)).toContain("object-src 'none'");
  });
  it('next.config applies headers to every route', async () => {
    const rules = await nextConfig.headers!();
    expect(rules[0].source).toBe('/:path*');
    expect(rules[0].headers.map((x) => x.key)).toContain('Content-Security-Policy');
  });
});
