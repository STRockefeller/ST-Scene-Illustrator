import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('selection action survives its own mouseup before click', () => {
    assert.match(source, /event\?\.target\?\.closest\?\.\('\.scene-illustrator-selection'\)/);
    assert.match(source, /Generate an image for the selected passage/);
});

test('candidate generation disables secondary prompt expansion', () => {
    assert.match(source, /sd\.free_extend = false/);
    assert.match(source, /sd\.prompt_prefix = '\{prompt\}'/);
    assert.match(source, /sd\.negative_prompt = ''/);
    assert.match(source, /event_types\.SD_PROMPT_PROCESSING, onSdPromptProcessing/);
    assert.match(source, /eventData\.prompt = eventData\.trigger/);
    assert.match(source, /Object\.assign\(sd, original\)/);
});

test('candidate generation submits one concurrent fixed-prompt batch', () => {
    assert.match(source, /Promise\.allSettled\(jobs\)/);
    assert.match(source, /buildImagineCommand\(scene\.actualPrompt, scene\.actualNegativePrompt\)/);
    assert.doesNotMatch(source, /for \(let index = 0; index < settings\.candidateCount/);
});

test('workbench shows the actual frozen positive and negative prompt', () => {
    assert.match(source, /Fixed prompt sent to the image model/);
    assert.match(source, /si-actual-positive/);
    assert.match(source, /si-actual-negative/);
});


test('selected images are archived, embedded as Markdown, and temporary files are deleted', () => {
    assert.match(source, /fetch\('\/api\/images\/upload'/);
    assert.match(source, /fetch\('\/api\/images\/delete'/);
    assert.match(source, /copyImageToGallery/);
    assert.match(source, /stripAllSceneMarkdown\(message\.mes\)/);
    assert.match(source, /upsertSceneMarkdown\(nextText, scene\)/);
    assert.match(source, /context\.updateMessageBlock\(messageId, message\)/);
});

test('long-chat analysis always reads context before the selected historical message', () => {
    assert.match(source, /targetId - settings\.contextMessages \+ 1/);
    assert.doesNotMatch(source, /lastAnalyzedId \+ 1/);
    assert.match(source, /tracker\/state metadata/);
    assert.match(source, /Rendered target text \(may contain tracker output\)/);
});

test('character state is optional and corrupted snapshots fall back safely', () => {
    assert.match(source, /character reference unavailable; continuing from chat text/);
    assert.match(source, /invalid character state snapshot; using an empty state/);
    assert.match(source, /coerceAnalysisPayload\(parseAnalysisResponse\(raw\)\)/);
});

test('state editor can add characters and custom fields before AI analysis', () => {
    assert.match(source, /tr\('Add character'\)/);
    assert.match(source, /tr\('Add custom field'\)/);
    assert.match(source, /createEmptyCharacterState\(\)/);
    assert.match(source, /data-custom-label/);
    assert.match(source, /data-custom-value/);
});
