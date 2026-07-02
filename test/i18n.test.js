import test from 'node:test';
import assert from 'node:assert/strict';
import { getUiLocale, tr } from '../src/i18n.js';

test('uses Traditional Chinese only for the SillyTavern zh-TW locale', () => {
    const original = globalThis.localStorage;
    try {
        globalThis.localStorage = { getItem: () => 'zh-TW' };
        assert.equal(getUiLocale(), 'zh-TW');
        assert.equal(tr('Close'), '關閉');
        assert.equal(tr('Scene {number}', { number: 2 }), '場景 2');

        for (const locale of ['zh-CN', 'zh-HK', 'ja-JP', 'en-US']) {
            globalThis.localStorage = { getItem: () => locale };
            assert.equal(getUiLocale(), 'en');
            assert.equal(tr('Close'), 'Close');
        }
    } finally {
        if (original === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = original;
    }
});
