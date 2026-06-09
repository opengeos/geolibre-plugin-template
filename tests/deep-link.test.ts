import { describe, it, expect, vi } from 'vitest';
import {
  PLUGIN_DATA_PARAM,
  getPluginDataValue,
  maybeHandleDeepLink,
} from '../src/lib/utils/deep-link';

const params = (search: string) => new URLSearchParams(search);

describe('getPluginDataValue', () => {
  it('returns the value when the parameter is present', () => {
    expect(
      getPluginDataValue(params('?plugin-data=https://example.com/dataset.zip')),
    ).toBe('https://example.com/dataset.zip');
  });

  it('percent-decodes the value', () => {
    expect(getPluginDataValue(params('plugin-data=https%3A%2F%2Fx%2Fy.zip'))).toBe(
      'https://x/y.zip',
    );
  });

  it('ignores other parameters', () => {
    expect(getPluginDataValue(params('a=1&plugin-data=https://x/y.zip&b=2'))).toBe(
      'https://x/y.zip',
    );
  });

  it('returns null when the parameter is absent', () => {
    expect(getPluginDataValue(params('?foo=bar'))).toBeNull();
    expect(getPluginDataValue(params(''))).toBeNull();
  });

  it('returns null when the parameter is blank or whitespace', () => {
    expect(getPluginDataValue(params('?plugin-data='))).toBeNull();
    expect(getPluginDataValue(params('?plugin-data=%20%20'))).toBeNull();
  });

  it('exposes the parameter name', () => {
    expect(PLUGIN_DATA_PARAM).toBe('plugin-data');
  });
});

describe('maybeHandleDeepLink', () => {
  it('forwards the value when the parameter is present', async () => {
    const consumer = { loadFromUrl: vi.fn() };
    await maybeHandleDeepLink(consumer, params('?plugin-data=https://x/y.zip'));
    expect(consumer.loadFromUrl).toHaveBeenCalledOnce();
    expect(consumer.loadFromUrl).toHaveBeenCalledWith('https://x/y.zip');
  });

  it('does nothing when the parameter is absent or blank', async () => {
    const consumer = { loadFromUrl: vi.fn() };
    await maybeHandleDeepLink(consumer, params('?other=1'));
    await maybeHandleDeepLink(consumer, params('?plugin-data='));
    expect(consumer.loadFromUrl).not.toHaveBeenCalled();
  });
});
