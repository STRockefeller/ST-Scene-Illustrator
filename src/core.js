import { DEFAULT_SETTINGS, EMPTY_CHAT_STATE, METADATA_VERSION, PROMPT_STYLES } from './constants.js';

import { tr } from './i18n.js';

export function normalizeSettings(value = {}) {
    return {
        ...DEFAULT_SETTINGS, ...value,
        enabled: value.enabled !== false,
        candidateCount: clampInteger(value.candidateCount, 1, 8, DEFAULT_SETTINGS.candidateCount),
        maxScenes: clampInteger(value.maxScenes, 1, 3, DEFAULT_SETTINGS.maxScenes),
        contextMessages: clampInteger(value.contextMessages, 4, 200, DEFAULT_SETTINGS.contextMessages),
        maxAnalysisTokens: clampInteger(value.maxAnalysisTokens, 512, 16000, DEFAULT_SETTINGS.maxAnalysisTokens),
        promptStyle: PROMPT_STYLES[value.promptStyle] ? value.promptStyle : DEFAULT_SETTINGS.promptStyle,
        analysisSource: value.analysisSource === 'profile' ? 'profile' : 'current',
    };
}

export function createChatState(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const characters = {};
    for (const [name, character] of Object.entries(source.characters ?? {})) {
        const cleanName = String(name ?? '').trim();
        if (cleanName) characters[cleanName] = normalizeCharacterState(character);
    }
    return {
        ...structuredClone(EMPTY_CHAT_STATE),
        ...source,
        version: METADATA_VERSION,
        lastAnalyzedMessageId: Number.isInteger(source.lastAnalyzedMessageId) ? source.lastAnalyzedMessageId : -1,
        characters,
    };
}

export function createEmptyCharacterState() {
    return normalizeCharacterState({});
}

export function normalizeCharacterState(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const locked = source.locked && typeof source.locked === 'object' ? { ...source.locked } : {};
    const customFields = Array.isArray(source.customFields) ? source.customFields.map((field, index) => ({
        id: String(field?.id || `custom-${index}`),
        label: String(field?.label ?? '').trim(),
        value: String(field?.value ?? '').trim(),
        locked: field?.locked !== false,
    })).filter(field => field.label || field.value) : [];
    return {
        appearance: String(source.appearance ?? ''),
        hair: String(source.hair ?? ''),
        clothing: String(source.clothing ?? ''),
        condition: String(source.condition ?? ''),
        accessories: String(source.accessories ?? ''),
        locked,
        customFields,
    };
}

export function coerceAnalysisPayload(value) {
    if (!value || typeof value !== 'object') return value;
    value.characterUpdates = Array.isArray(value.characterUpdates) ? value.characterUpdates : [];
    if (Array.isArray(value.scenes)) {
        for (const scene of value.scenes) {
            scene.visibleCharacters = Array.isArray(scene.visibleCharacters) ? scene.visibleCharacters : [];
            scene.visibleObjects = Array.isArray(scene.visibleObjects) ? scene.visibleObjects : [];
            scene.negativePrompt = String(scene.negativePrompt ?? '');
        }
    }
    return value;
}

export function splitParagraphs(text) {
    const normalized = String(text ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/\r\n?/g, '\n').trim();
    if (!normalized) return [];
    return normalized.split(/\n\s*\n+/).map(part => part.trim()).filter(Boolean);
}

export function parseAnalysisResponse(raw) {
    if (raw && typeof raw === 'object') return raw;
    const text = String(raw ?? '').trim();
    if (!text) throw new Error(tr('The analysis model returned empty content.'));
    const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(unfenced); } catch {
        const start = unfenced.indexOf('{');
        const end = unfenced.lastIndexOf('}');
        if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
        throw new Error(tr('The analysis model did not return valid JSON.'));
    }
}

export function validateAnalysis(data, paragraphCount, maxScenes = 3) {
    const errors = [];
    if (!data || !Array.isArray(data.scenes)) return [tr('The scenes array is missing.')];
    if (data.scenes.length < 1 || data.scenes.length > maxScenes) errors.push(tr('The scene count must be between 1 and {max}.', { max: maxScenes }));
    data.scenes.forEach((scene, index) => {
        const label = tr('Scene {number}', { number: index + 1 });
        if (!Number.isInteger(scene.paragraphIndex) || scene.paragraphIndex < 0 || scene.paragraphIndex >= paragraphCount) errors.push(tr('{scene} has an invalid paragraphIndex.', { scene: label }));
        if (wordCount(scene.directPrompt) < 55) errors.push(tr('{scene} has a direct prompt that is too short.', { scene: label }));
        if (tagCount(scene.booruPrompt) < 30) errors.push(tr('{scene} has a booru prompt that is too short.', { scene: label }));
        if (!String(scene.camera ?? '').trim()) errors.push(tr('{scene} is missing camera direction.', { scene: label }));
        if (!String(scene.anchorText ?? '').trim()) errors.push(tr('{scene} is missing a text anchor.', { scene: label }));
        if (!Array.isArray(scene.visibleCharacters)) errors.push(tr('{scene} is missing visible character data.', { scene: label }));

    });
    return errors;
}

export function normalizeAnalysis(data, paragraphs, messageId) {
    const scenes = data.scenes.map((scene, index) => ({
        id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${index}`,
        title: String(scene.title || tr('Scene {number}', { number: index + 1 })).trim(), messageId,
        paragraphIndex: clampInteger(scene.paragraphIndex, 0, Math.max(0, paragraphs.length - 1), 0),
        anchorText: String(scene.anchorText || '').trim(), camera: String(scene.camera || '').trim(),
        composition: String(scene.composition || '').trim(),
        visibleCharacters: Array.isArray(scene.visibleCharacters) ? scene.visibleCharacters : [],
        visibleObjects: Array.isArray(scene.visibleObjects) ? scene.visibleObjects : [], lighting: String(scene.lighting || '').trim(),
        directPrompt: String(scene.directPrompt || '').trim(), booruPrompt: String(scene.booruPrompt || '').trim(),
        negativePrompt: String(scene.negativePrompt || '').trim(), candidates: [], selectedUrl: '', status: 'ready',
    }));
    return { scenes, characterUpdates: data.characterUpdates ?? [] };
}

export function mergeCharacterUpdates(current, updates) {
    const next = structuredClone(current ?? {});
    for (const update of updates ?? []) {
        const name = String(update.name ?? '').trim();
        if (!name) continue;
        const existing = normalizeCharacterState(next[name]);
        for (const key of ['appearance', 'hair', 'clothing', 'condition', 'accessories']) {
            if (!existing.locked?.[key] && String(update[key] ?? '').trim()) existing[key] = String(update[key]).trim();
        }
        existing.locked ??= {};
        next[name] = existing;
    }
    return next;
}

export function scenePrompt(scene, style) {
    return String(scene?.[PROMPT_STYLES[style] ?? PROMPT_STYLES.direct] ?? '').trim();
}

export function quoteSlashArgument(value) {
    return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}

export function buildImagineCommand(prompt, negativePrompt = '') {
    const negative = String(negativePrompt ?? '').trim();
    return `/imagine quiet=true gallery=false${negative ? ` negative=${quoteSlashArgument(negative)}` : ''} ${quoteSlashArgument(prompt)}`;
}


export function composePromptPrefix(prefix, prompt) {
    const clean = value => String(value ?? '').trim().replace(/^,|,$/g, '').trim();
    const base = clean(prefix);
    const body = clean(prompt);
    if (!body) return base;
    if (!base || base === '{prompt}') return body;
    return base.includes('{prompt}') ? clean(base.replace('{prompt}', body)) : `${base}, ${body}`;
}

export function composeNegativePrompt(sceneNegative, globalNegative) {
    return [sceneNegative, globalNegative]
        .map(value => String(value ?? '').trim().replace(/^,|,$/g, '').trim())
        .filter(Boolean)
        .join(', ');
}
export function isTemporaryImageUrl(url) {
    const path = String(url ?? '').split(/[?#]/, 1)[0].replace(/^\//, '');
    return /^user\/images\/[^/]+$/i.test(path);
}

export function buildSceneMarkdown(scene) {
    const id = String(scene.id ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
    const title = String(scene.title || 'Scene image').replace(/[\]\\]/g, '');
    const url = String(scene.selectedUrl ?? '').trim();
    return `<!-- scene-illustrator:${id} -->\n![${title}](<${url}>)\n<!-- /scene-illustrator:${id} -->`;
}

export function hasSceneMarkdown(text, sceneId) {
    return String(text ?? '').includes(`<!-- scene-illustrator:${sceneId} -->`);
}

export function stripAllSceneMarkdown(text) {
    return String(text ?? '')
        .replace(/\n*<!-- scene-illustrator:[a-zA-Z0-9_-]+ -->[\s\S]*?<!-- \/scene-illustrator:[a-zA-Z0-9_-]+ -->\n*/g, '\n\n')
        .trim();
}
export function upsertSceneMarkdown(text, scene) {
    const id = String(scene.id ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const blockPattern = new RegExp(`\\n*<!-- scene-illustrator:${escaped} -->[\\s\\S]*?<!-- \\/scene-illustrator:${escaped} -->\\n*`, 'g');
    const cleanText = String(text ?? '').replace(blockPattern, '\n\n').trim();
    const paragraphs = cleanText ? cleanText.split(/\n\s*\n+/) : [];
    const index = Math.min(Math.max(0, Number(scene.paragraphIndex) || 0), Math.max(0, paragraphs.length - 1));
    paragraphs.splice(index + 1, 0, buildSceneMarkdown(scene));
    return paragraphs.join('\n\n');
}
export function findParagraphElement(container, scene, sourceParagraphs) {
    const blocks = [...container.children].filter(element => !element.classList.contains('scene-illustrator-inline'));
    const expected = sourceParagraphs[scene.paragraphIndex] ?? '';
    const anchor = scene.anchorText.trim();
    const byIndex = blocks[scene.paragraphIndex];
    if (byIndex && (!anchor || byIndex.textContent.includes(anchor) || expected.includes(anchor))) return { element: byIndex, fallback: false };
    const byAnchor = anchor ? blocks.find(element => element.textContent.includes(anchor)) : null;
    return { element: byAnchor ?? container.lastElementChild ?? container, fallback: !byAnchor };
}

function clampInteger(value, min, max, fallback) {
    const numeric = Number(value);
    return Number.isInteger(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
}
function wordCount(value) { return String(value ?? '').trim().split(/\s+/).filter(Boolean).length; }
function tagCount(value) { return String(value ?? '').split(',').map(value => value.trim()).filter(Boolean).length; }
