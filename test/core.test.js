import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildImagineCommand, buildSceneMarkdown, coerceAnalysisPayload, composeNegativePrompt, composePromptPrefix, createChatState, createEmptyCharacterState, hasSceneMarkdown, isTemporaryImageUrl, mergeCharacterUpdates, normalizeSettings, stripAllSceneMarkdown, upsertSceneMarkdown,
    normalizeAnalysis, parseAnalysisResponse, quoteSlashArgument, scenePrompt, splitParagraphs, validateAnalysis,
} from '../src/core.js';
import { SYSTEM_PROMPT, buildAnalysisPrompt } from '../src/prompts.js';

function validScene() {
    return {
        title: '教室後方', paragraphIndex: 1, anchorText: '她回頭', camera: 'rear-facing medium shot', composition: 'subject at center',
        visibleCharacters: [{ name: '林曉', visualDescription: 'young woman with long black hair and blue school uniform', action: 'turning around', position: 'center foreground' }],
        visibleObjects: ['potted plant', 'rear windows'], lighting: 'soft afternoon sunlight',
        directPrompt: 'A dynamic rear-facing medium shot inside a spacious Japanese high school classroom shows one athletic young woman with long black hair tied in a high ponytail and wearing a fitted blue volleyball uniform. She twists sharply at the waist with focused eyes and tense shoulders beside tall rear windows and a green potted plant. Soft afternoon sunlight creates rim light, long shadows, natural depth, crisp fabric detail, and a coherent single-camera perspective.',
        booruPrompt: '1girl, solo, athletic girl, long black hair, high ponytail, focused eyes, blue volleyball uniform, fitted jersey, shorts, twisting waist, looking back, tense shoulders, dynamic pose, classroom, Japanese high school, rear windows, potted plant, wooden floor, afternoon, medium shot, rear view, dynamic angle, rule of thirds, coherent perspective, rim light, long shadows, warm colors, detailed background, masterpiece, best quality, ultra-detailed, cinematic lighting, depth of field',
        negativePrompt: 'text, watermark, impossible perspective',
    };
}

test('splits Traditional Chinese and mixed newline paragraphs', () => {
    assert.deepEqual(splitParagraphs('段落甲\r\n\r\n段落乙<br><br>Paragraph C'), ['段落甲', '段落乙', 'Paragraph C']);
});

test('parses fenced and noisy JSON', () => {
    assert.deepEqual(parseAnalysisResponse('```json\n{"scenes":[],"characterUpdates":[]}\n```').scenes, []);
    assert.equal(parseAnalysisResponse('note {"scenes":[1],"characterUpdates":[]} trailing').scenes[0], 1);
});

test('rejects empty, short, and malformed scene prompts', () => {
    const scene = validScene(); scene.directPrompt = 'girl classroom'; scene.booruPrompt = 'girl, classroom';
    const errors = validateAnalysis({ scenes: [scene], characterUpdates: [] }, 2, 3);
    assert.ok(errors.some(error => error.includes('direct prompt 過短')));
    assert.ok(errors.some(error => error.includes('booru prompt 過短')));
});

test('accepts a complete camera-visible scene', () => {
    assert.deepEqual(validateAnalysis({ scenes: [validScene()], characterUpdates: [] }, 2, 3), []);
});

test('missing anchors recover from the indexed source without requiring model repair', () => {
    for (const anchorText of [undefined, null, '', '  ']) {
        const paragraphs = ['第一段。', '她回頭看向窗外。'];
        const payload = coerceAnalysisPayload({ scenes: [{ ...validScene(), anchorText }] }, paragraphs);
        assert.deepEqual(validateAnalysis(payload, paragraphs.length), []);
        const scene = normalizeAnalysis(payload, paragraphs, 1).scenes[0];
        assert.equal(scene.anchorText, paragraphs[1]);
        assert.equal(scene.anchorRecovered, true);
    }
});

test('anchor recovery preserves supplied quotes and rejects unknown placement', () => {
    const supplied = coerceAnalysisPayload({ scenes: [validScene()] }, ['第一段。', '她回頭看向窗外。']);
    assert.equal(supplied.scenes[0].anchorText, '她回頭');
    assert.equal(supplied.scenes[0].anchorRecovered, undefined);
    for (const paragraphIndex of [-1, 2, '1', undefined]) {
        const payload = coerceAnalysisPayload({ scenes: [{ ...validScene(), paragraphIndex, anchorText: '' }] }, ['第一段。', '第二段。']);
        assert.equal(payload.scenes[0].anchorText, '');
        assert.ok(validateAnalysis(payload, 2).length >= 2);
    }
});

test('locked appearance fields survive incremental updates', () => {
    const current = { Alice: { hair: 'braided hair', clothing: 'red coat', locked: { hair: true } } };
    const result = mergeCharacterUpdates(current, [{ name: 'Alice', hair: 'ponytail', clothing: 'white dress', appearance: '', condition: '', accessories: '' }]);
    assert.equal(result.Alice.hair, 'braided hair');
    assert.equal(result.Alice.clothing, 'white dress');
});

test('slash command safely quotes pipes, quotes, slashes, and newlines', () => {
    const quoted = quoteSlashArgument('woman | "portrait"\\test\nnext');
    assert.equal(quoted, '"woman | \\"portrait\\"\\\\test next"');
    const command = buildImagineCommand('a | b', 'bad "text"');
    assert.match(command, /^\/imagine quiet=true gallery=false negative=/);
    assert.ok(command.includes('"a | b"'));
});

test('settings and chat metadata migrate to bounded defaults', () => {
    const settings = normalizeSettings({ candidateCount: 99, maxScenes: 0, promptStyle: 'unknown' });
    assert.equal(settings.candidateCount, 8); assert.equal(settings.maxScenes, 1); assert.equal(settings.promptStyle, 'direct');
    assert.deepEqual(createChatState({ characters: null }).characters, {});
});

test('analysis prompt explicitly enforces camera visibility and proper-noun expansion', () => {
    const prompt = buildAnalysisPrompt({ selectionText: '', maxScenes: 3, paragraphs: ['黑板在前方。', '她回頭看向後方的盆栽。'], characterState: {}, characterReference: '', chatContext: '' });
    assert.match(prompt, /TARGET MESSAGE PARAGRAPHS/);
    assert.match(SYSTEM_PROMPT, /one camera position/);
    assert.match(SYSTEM_PROMPT, /Replace private proper nouns/);
    assert.match(SYSTEM_PROMPT, /opposite views/);
});

test('selects direct and booru prompt styles', () => {
    assert.equal(scenePrompt({ directPrompt: 'direct', booruPrompt: 'tags' }, 'direct'), 'direct');
    assert.equal(scenePrompt({ directPrompt: 'direct', booruPrompt: 'tags' }, 'booru'), 'tags');
});

test('composes the exact official positive and negative prompts shown in UI', () => {
    assert.equal(composePromptPrefix('masterpiece, {prompt}, best quality', '1girl, spiking volleyball'), 'masterpiece, 1girl, spiking volleyball, best quality');
    assert.equal(composePromptPrefix('masterpiece', '1girl, spiking volleyball'), 'masterpiece, 1girl, spiking volleyball');
    assert.equal(composeNegativePrompt('bad hands', 'low quality, text'), 'bad hands, low quality, text');
});

test('a candidate batch reuses one byte-identical command', () => {
    const command = buildImagineCommand('fixed detailed prompt', 'fixed negative');
    const batch = Array.from({ length: 4 }, () => command);
    assert.equal(new Set(batch).size, 1);
});


test('recognizes only root user images as temporary candidates', () => {
    assert.equal(isTemporaryImageUrl('user/images/June_28_2026.png'), true);
    assert.equal(isTemporaryImageUrl('/user/images/June_28_2026.png?x=1'), true);
    assert.equal(isTemporaryImageUrl('user/images/Alice/scene.png'), false);
});

test('writes, replaces, and strips editable scene Markdown blocks', () => {
    const scene = { id: 'abc-123', title: 'Volleyball spike', selectedUrl: 'user/images/Alice/scene.png', paragraphIndex: 0 };
    const markdown = buildSceneMarkdown(scene);
    assert.match(markdown, /!\[Volleyball spike\]\(<user\/images\/Alice\/scene\.png>\)/);
    const inserted = upsertSceneMarkdown('Paragraph A\n\nParagraph B', scene);
    assert.equal(hasSceneMarkdown(inserted, scene.id), true);
    assert.ok(inserted.indexOf('scene-illustrator:abc-123') < inserted.indexOf('Paragraph B'));
    const replaced = upsertSceneMarkdown(inserted, { ...scene, selectedUrl: 'user/images/Alice/new.png' });
    assert.equal((replaced.match(/scene-illustrator:abc-123/g) ?? []).length, 2);
    assert.match(replaced, /new\.png/);
    assert.equal(stripAllSceneMarkdown(replaced), 'Paragraph A\n\nParagraph B');
});

test('manual characters and arbitrary custom fields survive state migration', () => {
    const state = createChatState({ characters: { Alice: {
        hair: 'high ponytail',
        customFields: [{ id: 'role', label: 'Team position', value: 'outside hitter', locked: true }],
    } } });
    assert.equal(state.characters.Alice.hair, 'high ponytail');
    assert.deepEqual(state.characters.Alice.customFields[0], { id: 'role', label: 'Team position', value: 'outside hitter', locked: true });
    assert.deepEqual(createEmptyCharacterState().customFields, []);
});

test('AI updates preserve user custom fields', () => {
    const current = createChatState({ characters: { Alice: {
        appearance: 'athletic girl',
        customFields: [{ id: 'uniform', label: 'Jersey number', value: '7', locked: true }],
    } } }).characters;
    const result = mergeCharacterUpdates(current, [{ name: 'Alice', appearance: 'tall athletic girl', hair: '', clothing: '', condition: '', accessories: '' }]);
    assert.equal(result.Alice.appearance, 'tall athletic girl');
    assert.equal(result.Alice.customFields[0].value, '7');
});

test('missing character updates and visible-character state do not block a valid scene', () => {
    const payload = coerceAnalysisPayload({ scenes: [{ ...validScene(), visibleCharacters: undefined }], characterUpdates: undefined });
    assert.deepEqual(payload.characterUpdates, []);
    assert.deepEqual(payload.scenes[0].visibleCharacters, []);
    assert.deepEqual(validateAnalysis(payload, 2, 3), []);
});
