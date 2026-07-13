import { describe, expect, it } from 'vitest';

import { pwaOptions } from '../../vite.config';

describe('production PWA policy', () => {
  it('defines an installable Chinese standalone manifest', () => {
    expect(pwaOptions.manifest).toMatchObject({
      lang: 'zh-CN',
      start_url: '/',
      scope: '/',
      display: 'standalone',
    });
    const manifest = pwaOptions.manifest && pwaOptions.manifest;
    expect(manifest && manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192' }),
      expect.objectContaining({ sizes: '512x512' }),
      expect.objectContaining({ purpose: 'maskable' }),
    ]));
  });

  it('prompts for updates and explicitly keeps every API request network-only', () => {
    expect(pwaOptions.registerType).toBe('prompt');
    const runtimeCaching = pwaOptions.workbox?.runtimeCaching ?? [];
    const apiRule = runtimeCaching.find((rule) =>
      rule.urlPattern instanceof RegExp && rule.urlPattern.test('/api/auth/me'),
    );
    expect(apiRule?.handler).toBe('NetworkOnly');
  });
});
