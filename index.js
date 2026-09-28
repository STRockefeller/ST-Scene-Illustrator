import { eventSource, event_types, generateRawData, saveSettingsDebounced } from '/script.js';
import { extension_settings, getContext } from '/scripts/extensions.js';
import { power_user } from '/scripts/power-user.js';
import { ConnectionManagerRequestService } from '/scripts/extensions/shared.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { DEFAULT_SETTINGS, METADATA_KEY, METADATA_VERSION, MODULE_NAME } from './src/constants.js';
import {
    buildImagineCommand, coerceAnalysisPayload, composeNegativePrompt, composePromptPrefix, createChatState, createEmptyCharacterState, findParagraphElement, hasSceneMarkdown, isTemporaryImageUrl, mergeCharacterUpdates, stripAllSceneMarkdown, upsertSceneMarkdown,
    normalizeAnalysis, normalizeSettings, parseAnalysisResponse, scenePrompt, splitParagraphs, validateAnalysis,
} from './src/core.js';
import { ANALYSIS_SCHEMA, SYSTEM_PROMPT, buildAnalysisPrompt, buildRepairPrompt } from './src/prompts.js';
import { localizeSettings, tr } from './src/i18n.js';

let settings = normalizeSettings();
let activeJob = null;
let selectionAction = null;

export async function init() {
    extension_settings[MODULE_NAME] = normalizeSettings(extension_settings[MODULE_NAME]);
    settings = extension_settings[MODULE_NAME];
    await mountSettings();
    bindEvents();
    registerCommands();
    renderAllMessages();
}

async function mountSettings() {
    const response = await fetch(new URL('./settings.html', import.meta.url));
    const html = await response.text();
    document.querySelector('#extensions_settings2')?.insertAdjacentHTML('beforeend', html);
    localizeSettings(document.querySelector('#scene_illustrator_settings'));
    populateProfileSelect();
    syncSettingsUi();

    const bind = (id, event, callback) => document.querySelector(id)?.addEventListener(event, callback);
    bind('#si_enabled', 'change', event => updateSetting('enabled', event.target.checked));
    bind('#si_analysis_source', 'change', event => { updateSetting('analysisSource', event.target.value); syncSettingsUi(); });
    bind('#si_profile', 'change', event => updateSetting('connectionProfileId', event.target.value));
    bind('#si_prompt_style', 'change', event => updateSetting('promptStyle', event.target.value));
    bind('#si_candidate_count', 'change', event => updateSetting('candidateCount', Number(event.target.value)));
    bind('#si_max_scenes', 'change', event => updateSetting('maxScenes', Number(event.target.value)));
    bind('#si_context_messages', 'change', event => updateSetting('contextMessages', Number(event.target.value)));
    bind('#si_manual', 'click', openManualWorkbench);
    bind('#si_character_state', 'click', openCharacterStateEditor);
    bind('#si_export', 'click', exportSettings);
    bind('#si_import', 'click', () => document.querySelector('#si_import_file')?.click());
    bind('#si_import_file', 'change', importSettings);
    eventSource.on(event_types.CONNECTION_PROFILE_CREATED, populateProfileSelect);
    eventSource.on(event_types.CONNECTION_PROFILE_UPDATED, populateProfileSelect);
    eventSource.on(event_types.CONNECTION_PROFILE_DELETED, populateProfileSelect);
}

function bindEvents() {
    const render = messageId => { addMessageAction(messageId); renderMessageScenes(messageId); };
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, render);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, render);
    eventSource.on(event_types.MESSAGE_UPDATED, render);
    eventSource.on(event_types.MESSAGE_EDITED, render);
    eventSource.on(event_types.MORE_MESSAGES_LOADED, renderAllMessages);
    eventSource.on(event_types.SD_PROMPT_PROCESSING, onSdPromptProcessing);
    eventSource.on(event_types.CHAT_CHANGED, () => { cancelActiveJob(); closeOverlay(); queueMicrotask(renderAllMessages); });

    document.addEventListener('click', onDocumentClick);
    document.addEventListener('mouseup', onTextSelection);
    document.addEventListener('touchend', onTextSelection);
}

function registerCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'scene-image', aliases: ['scene-img'],
        callback: async (_args, value) => { value?.trim() ? openManualWorkbench(value.trim()) : openManualWorkbench(); return ''; },
        helpString: tr('Open the Scene Illustrator manual workbench. You can provide a prompt after the command.'),
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'scene-analyze',
        callback: async () => { const id = findLatestAssistantMessageId(); if (id >= 0) await analyzeMessage(id, ''); return ''; },
        helpString: tr('Analyze the latest AI response and open the scene workbench.'),
    }));
}

function onSdPromptProcessing(eventData) {
    if (activeJob?.kind !== 'imageBatch') return;
    if (activeJob.frozenPrompts?.has(eventData.trigger)) eventData.prompt = eventData.trigger;
}
function onDocumentClick(event) {
    const analyzeButton = event.target.closest('.scene-illustrator-message');
    if (analyzeButton) {
        const messageId = Number(analyzeButton.closest('.mes')?.getAttribute('mesid'));
        if (Number.isInteger(messageId)) analyzeMessage(messageId, '');
        return;
    }
    const sceneImage = event.target.closest('.scene-illustrator-inline, .scene-illustrator-markdown');
    if (sceneImage) {
        const messageId = Number(sceneImage.closest('.mes')?.getAttribute('mesid'));
        const sceneId = sceneImage.dataset.sceneId;
        openExistingScene(messageId, sceneId);
    }
}

function onTextSelection(event) {
    if (event?.target?.closest?.('.scene-illustrator-selection')) return;
    selectionAction?.remove();
    selectionAction = null;
    if (!settings.enabled) return;
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!text || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const messageElement = range.commonAncestorContainer.parentElement?.closest('.mes');
    if (!messageElement?.querySelector('.mes_text')?.contains(range.commonAncestorContainer)) return;
    const messageId = Number(messageElement.getAttribute('mesid'));
    const rect = range.getBoundingClientRect();
    const button = document.createElement('button');
    button.className = 'scene-illustrator-selection';
    button.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i><span>${tr('Generate an image for the selected passage')}</span>`;
    button.style.left = `${Math.max(8, Math.min(window.innerWidth - 150, rect.left))}px`;
    button.style.top = `${Math.max(8, rect.bottom + 6)}px`;
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => { button.remove(); selectionAction = null; analyzeMessage(messageId, text); });
    document.body.append(button);
    selectionAction = button;
}

function addMessageAction(messageId) {
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!settings.enabled) { messageElement?.querySelector('.scene-illustrator-message')?.remove(); return; }
    const message = getContext().chat?.[messageId];
    if (!messageElement || !message || message.is_system || message.is_user) return;
    const actions = messageElement.querySelector('.extraMesButtons');
    if (!actions || actions.querySelector('.scene-illustrator-message')) return;
    const button = document.createElement('div');
    button.className = 'mes_button scene-illustrator-message fa-solid fa-wand-magic-sparkles';
    button.title = tr('Analyze scenes and generate images');
    actions.prepend(button);
}

async function analyzeMessage(messageId, selectionText) {
    if (activeJob) return toastr.warning(tr('A scene job is already in progress.'));
    const context = getContext();
    const message = context.chat?.[messageId];
    const sourceChatId = context.chatId;
    if (!message?.mes) return toastr.error(tr('The target message could not be found.'));
    const paragraphs = splitParagraphs(message.mes);
    if (!paragraphs.length) return toastr.warning(tr('The target message has no text to analyze.'));

    const controller = new AbortController();
    activeJob = { kind: 'analysis', controller, cancelled: false };
    toastr.info(tr('Analyzing scenes and character state…'), 'Scene Illustrator');
    try {
        const chatState = getChatState(context);
        const prompt = buildAnalysisPrompt({
            selectionText, maxScenes: selectionText ? 1 : settings.maxScenes, paragraphs,
            characterState: chatState.characters, characterReference: await collectCharacterReference(context, messageId),
            chatContext: collectChatContext(context, messageId),
        });
        let raw = await requestAnalysis(prompt, controller.signal);
        let parsed;
        let errors;
        try { parsed = coerceAnalysisPayload(parseAnalysisResponse(raw), paragraphs); errors = validateAnalysis(parsed, paragraphs.length, selectionText ? 1 : settings.maxScenes); }
        catch (error) { errors = [error.message]; }
        if (errors.length) {
            raw = await requestAnalysis(buildRepairPrompt(typeof raw === 'string' ? raw : JSON.stringify(raw), errors), controller.signal);
            parsed = coerceAnalysisPayload(parseAnalysisResponse(raw), paragraphs);
            errors = validateAnalysis(parsed, paragraphs.length, selectionText ? 1 : settings.maxScenes);
            if (errors.length) throw new Error(errors.join('\n'));
        }
        if (activeJob?.cancelled || getContext().chatId !== sourceChatId) throw new DOMException('Chat changed', 'AbortError');
        const analysis = normalizeAnalysis(parsed, paragraphs, messageId);
        chatState.characters = mergeCharacterUpdates(chatState.characters, analysis.characterUpdates);
        chatState.lastAnalyzedMessageId = messageId;
        saveChatState(context, chatState);
        openWorkbench(messageId, analysis.scenes);
    } catch (error) {
        if (error.name !== 'AbortError') { console.error(error); toastr.error(error.message, tr('Scene analysis failed')); }
    } finally { activeJob = null; }
}

async function requestAnalysis(userPrompt, signal) {
    if (settings.analysisSource === 'profile') {
        if (!settings.connectionProfileId) throw new Error(tr('Select a Connection Profile first.'));
        const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt }];
        const profilePrompt = ConnectionManagerRequestService.constructPrompt(messages, settings.connectionProfileId);
        const result = await ConnectionManagerRequestService.sendRequest(
            settings.connectionProfileId,
            profilePrompt,
            settings.maxAnalysisTokens,
            { stream: false, signal, extractData: true, includePreset: true, includeInstruct: true },
        );
        return result?.content ?? result;
    }
    return await generateRawData({ prompt: userPrompt, systemPrompt: SYSTEM_PROMPT, responseLength: settings.maxAnalysisTokens, jsonSchema: ANALYSIS_SCHEMA });
}

function collectChatContext(context, targetId) {
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const start = Math.max(0, targetId - settings.contextMessages + 1);
    let trackerBudget = 12000;
    const joined = chat.slice(start, targetId + 1).map((message, offset) => {
        const id = start + offset;
        const role = message.is_user ? 'user' : message.is_system ? 'system' : 'character';
        const tracker = trackerBudget > 0 ? serializeTrackerData(message, Math.min(1500, trackerBudget)) : '';
        trackerBudget -= tracker.length;
        return `[message ${id}; ${role}; ${message.name || ''}] ${message.mes || ''}${tracker ? `\n[tracker/state metadata] ${tracker}` : ''}`;
    }).join('\n\n');
    const maxCharacters = 60000;
    return joined.length > maxCharacters ? `[earlier context truncated]\n${joined.slice(-maxCharacters)}` : joined;
}

async function collectCharacterReference(context, targetId) {
    const references = [];
    try {
        const chat = Array.isArray(context.chat) ? context.chat : [];
        const characters = Array.isArray(context.characters) ? context.characters : [];
        const start = Math.max(0, targetId - settings.contextMessages + 1);
        const nearbyChat = chat.slice(start, targetId + 1);
        const named = [...new Set(nearbyChat.map(message => message?.name).filter(Boolean))];
        const activeCharacters = context.groupId
            ? characters.filter(character => named.includes(character?.name))
            : [characters[context.characterId]].filter(Boolean);
        for (const character of activeCharacters) {
            references.push(JSON.stringify({ name: character.name, description: character.description, scenario: character.scenario, personality: character.personality }));
        }
        if (power_user.persona_description) references.push(`User persona: ${power_user.persona_description}`);
        try {
            const chatForWorldInfo = nearbyChat.map(message => `${message.name || ''}: ${message.mes || ''}`).reverse();
            const world = await context.getWorldInfoPrompt(chatForWorldInfo, context.maxContext, true);
            const lore = [world?.worldInfoBefore, world?.worldInfoAfter].filter(Boolean).join('\n');
            if (lore) references.push(`Activated world info: ${lore.slice(0, 12000)}`);
        } catch (error) { console.warn('Scene Illustrator: world info scan failed; continuing without it.', error); }
        const rendered = document.querySelector(`#chat .mes[mesid="${targetId}"] .mes_text`)?.innerText?.trim();
        const raw = String(chat[targetId]?.mes ?? '').trim();
        if (rendered && rendered !== raw) references.push(`Rendered target text (may contain tracker output): ${rendered.slice(0, 10000)}`);
        references.push(`Active names: ${named.join(', ')}`);
    } catch (error) {
        console.warn('Scene Illustrator: character reference unavailable; continuing from chat text.', error);
        references.push('Character reference unavailable. Infer only supported visual facts from the target and recent chat; do not fail or invent details.');
    }
    return references.join('\n');
}

function serializeTrackerData(message, maxLength) {
    const source = {};
    const extra = message?.extra;
    if (extra && typeof extra === 'object') {
        for (const [key, value] of Object.entries(extra)) {
            if ([METADATA_KEY, 'media', 'image', 'inline_image', 'file'].includes(key)) continue;
            source[key] = value;
        }
    }
    if (message?.variables && typeof message.variables === 'object') source.variables = message.variables;
    if (!Object.keys(source).length) return '';
    const seen = new WeakSet();
    try {
        return JSON.stringify(source, (key, value) => {
            if (/base64|data_uri|thumbnail|avatar/i.test(key)) return undefined;
            if (typeof value === 'string') {
                if (/^data:(?:image|audio|video)\//i.test(value)) return '[binary omitted]';
                return value.length > 1000 ? `${value.slice(0, 1000)}…` : value;
            }
            if (value && typeof value === 'object') {
                if (seen.has(value)) return '[circular]';
                seen.add(value);
            }
            return value;
        }).slice(0, maxLength);
    } catch (error) {
        console.warn('Scene Illustrator: tracker metadata could not be serialized.', error);
        return '';
    }
}
function openWorkbench(messageId, scenes) {
    closeOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'scene-illustrator-overlay';
    overlay.innerHTML = `<section class="scene-illustrator-workbench"><div class="si-workbench-head"><h3>${tr('Scene image workbench')}</h3><button class="menu_button si-close">${tr('Close')}</button></div><div class="si-progress"></div><div class="si-scenes"></div><div class="si-workbench-actions"><button class="menu_button si-cancel-job">${tr('Cancel remaining generation')}</button><button class="menu_button si-generate"><i class="fa-solid fa-images"></i> ${tr('Generate candidates')}</button><button class="menu_button si-save"><i class="fa-solid fa-check"></i> ${tr('Insert selected images')}</button></div></section>`;
    const list = overlay.querySelector('.si-scenes');
    scenes.forEach((scene, index) => list.append(createSceneCard(scene, index)));
    overlay.querySelector('.si-close').addEventListener('click', closeOverlay);
    overlay.querySelector('.si-cancel-job').addEventListener('click', cancelActiveJob);
    overlay.querySelector('.si-generate').addEventListener('click', () => generateCandidates(overlay, scenes));
    overlay.querySelector('.si-save').addEventListener('click', () => persistSelectedScenes(messageId, scenes, overlay));
    document.body.append(overlay);
    overlay._sceneData = scenes;
}

function createSceneCard(scene, index) {
    const card = document.createElement('article');
    card.className = 'si-scene-card';
    card.dataset.sceneId = scene.id;
    card.innerHTML = `<div class="si-scene-head"><strong></strong><label><input type="checkbox" class="si-enabled" checked> ${tr('Generate this scene')}</label></div><div class="si-scene-meta"><label>${tr('Insert after paragraph')}</label><input class="text_pole si-paragraph" type="number" min="0"><label>${tr('Prompt style')}</label><select class="text_pole si-style"><option value="direct">${tr('Direct description')}</option><option value="booru">Booru tags</option></select></div><label>${tr('Direct description prompt')}<textarea class="text_pole si-direct"></textarea></label><label>Booru tags<textarea class="text_pole si-booru"></textarea></label><label>Negative prompt<textarea class="text_pole si-negative"></textarea></label><details class="si-actual-prompt" open><summary>${tr('Fixed prompt sent to the image model')}</summary><div><b>Positive</b><pre class="si-actual-positive"></pre><b>Negative</b><pre class="si-actual-negative"></pre></div></details><div class="si-candidates"></div>`;
    card.querySelector('strong').textContent = `${index + 1}. ${scene.title}`;
    if (scene.anchorRecovered) {
        const notice = document.createElement('p');
        notice.textContent = tr('The model omitted the text anchor, so it was restored from the source paragraph. Check “Insert after paragraph” before inserting images (0 is the first paragraph).');
        card.querySelector('.si-scene-meta').after(notice);
    }
    card.querySelector('.si-paragraph').value = scene.paragraphIndex;
    card.querySelector('.si-style').value = scene.style || settings.promptStyle;
    card.querySelector('.si-direct').value = scene.directPrompt;
    card.querySelector('.si-booru').value = scene.booruPrompt;
    card.querySelector('.si-negative').value = scene.negativePrompt;
    const refresh = () => {
        syncSceneFromCard(card, scene);
        if (scene.candidates?.length) { scene.candidates = []; scene.selectedUrl = ''; renderCandidates(card, scene); }
        updateActualPromptPreview(card, scene);
    };
    card.querySelectorAll('.si-style, .si-direct, .si-booru, .si-negative').forEach(element => element.addEventListener('input', refresh));
    updateActualPromptPreview(card, scene);
    renderCandidates(card, scene);
    return card;
}

function syncSceneFromCard(card, scene) {
    scene.enabled = card.querySelector('.si-enabled').checked;
    scene.paragraphIndex = Math.max(0, Number(card.querySelector('.si-paragraph').value) || 0);
    scene.style = card.querySelector('.si-style').value;
    scene.directPrompt = card.querySelector('.si-direct').value.trim();
    scene.booruPrompt = card.querySelector('.si-booru').value.trim();
    scene.negativePrompt = card.querySelector('.si-negative').value.trim();
}

function freezeActualPrompt(scene) {
    const sd = extension_settings.sd ?? {};
    const context = getContext();
    scene.actualPrompt = context.substituteParams(composePromptPrefix(sd.prompt_prefix, scenePrompt(scene, scene.style)));
    scene.actualNegativePrompt = context.substituteParams(composeNegativePrompt(scene.negativePrompt, sd.negative_prompt));
}

function updateActualPromptPreview(card, scene) {
    freezeActualPrompt(scene);
    card.querySelector('.si-actual-positive').textContent = scene.actualPrompt || tr('(empty)');
    card.querySelector('.si-actual-negative').textContent = scene.actualNegativePrompt || tr('(empty)');
}

async function generateCandidates(overlay, scenes) {
    if (activeJob) return toastr.warning(tr('A job is already in progress.'));
    syncScenesFromWorkbench(overlay, scenes);
    const progress = overlay.querySelector('.si-progress');
    activeJob = { kind: 'imageBatch', cancelled: false, controller: new AbortController(), frozenPrompts: new Set() };
    const enabled = scenes.filter(scene => scene.enabled);
    if (!enabled.length) { activeJob = null; return toastr.warning(tr('Select at least one scene.')); }
    const total = enabled.length * settings.candidateCount;
    let done = 0;
    const sd = extension_settings.sd;
    if (!sd) { activeJob = null; return toastr.error(tr('Official Image Generation settings could not be found.')); }
    const original = {
        free_extend: sd.free_extend,
        minimal_prompt_processing: sd.minimal_prompt_processing,
        prompt_prefix: sd.prompt_prefix,
        negative_prompt: sd.negative_prompt,
    };
    enabled.forEach(scene => {
        const card = overlay.querySelector(`[data-scene-id="${CSS.escape(scene.id)}"]`);
        freezeActualPrompt(scene);
        updateActualPromptPreview(card, scene);
        activeJob.frozenPrompts.add(scene.actualPrompt);
    });
    try {
        // Freeze official processing so the reviewed prompt is the exact prompt used by every candidate.
        sd.free_extend = false;
        sd.minimal_prompt_processing = true;
        sd.prompt_prefix = '{prompt}';
        sd.negative_prompt = '';

        for (const scene of enabled) {
            if (activeJob.cancelled) throw new DOMException('Cancelled', 'AbortError');
            scene.candidates = [];
            scene.selectedUrl = '';
            const card = overlay.querySelector(`[data-scene-id="${CSS.escape(scene.id)}"]`);
            renderCandidates(card, scene);
            progress.textContent = tr('Batch generating {title}: {count} candidates use the same fixed prompt (total progress {done}/{total})', { title: scene.title, count: settings.candidateCount, done, total });
            const jobs = Array.from({ length: settings.candidateCount }, () => generateOneCandidate(scene));
            const results = await Promise.allSettled(jobs);
            if (activeJob.cancelled) throw new DOMException('Cancelled', 'AbortError');
            const failures = [];
            for (const result of results) {
                if (result.status === 'fulfilled') scene.candidates.push(result.value);
                else failures.push(result.reason);
            }
            done += scene.candidates.length;
            renderCandidates(card, scene);
            if (!scene.candidates.length) throw failures[0] ?? new Error(tr('Batch generation returned no images.'));
            if (failures.length) toastr.warning(tr('{title}: {count} candidates failed; the remaining candidates were kept.', { title: scene.title, count: failures.length }));
        }
        progress.textContent = tr('Complete. Generated {count} candidates. Candidates for the same scene used the same fixed prompt shown above.', { count: done });
    } catch (error) {
        progress.textContent = error.name === 'AbortError' ? tr('Remaining generation canceled.') : tr('Generation stopped: {error}', { error: error.message });
        if (error.name !== 'AbortError') { console.error(error); toastr.error(error.message, tr('Image generation failed')); }
    } finally {
        Object.assign(sd, original);
        activeJob = null;
    }
}

async function generateOneCandidate(scene) {
    if (activeJob?.cancelled) throw new DOMException('Cancelled', 'AbortError');
    const command = buildImagineCommand(scene.actualPrompt, scene.actualNegativePrompt);
    const result = await getContext().executeSlashCommandsWithOptions(command, { handleParserErrors: false, handleExecutionErrors: false, source: 'scene-illustrator' });
    const url = String(result?.pipe ?? '').trim();
    if (!url) throw new Error(tr('Official Image Generation returned no image URL. Make sure it is enabled and its backend is configured.'));
    return url;
}
function renderCandidates(card, scene) {
    const container = card?.querySelector('.si-candidates');
    if (!container) return;
    container.replaceChildren();
    scene.candidates.forEach((url, index) => {
        const button = document.createElement('button');
        button.className = `si-candidate${scene.selectedUrl === url ? ' selected' : ''}`;
        button.title = tr('Select candidate {number}', { number: index + 1 });
        const image = document.createElement('img');
        image.src = url; image.alt = tr('{title} candidate {number}', { title: scene.title, number: index + 1 }); image.loading = 'lazy';
        button.append(image);
        button.addEventListener('click', () => { scene.selectedUrl = url; renderCandidates(card, scene); });
        container.append(button);
    });
}

function syncScenesFromWorkbench(overlay, scenes) {
    for (const scene of scenes) {
        const card = overlay.querySelector(`[data-scene-id="${CSS.escape(scene.id)}"]`);
        if (!card) continue;
        syncSceneFromCard(card, scene);
        updateActualPromptPreview(card, scene);
    }
}

async function persistSelectedScenes(messageId, scenes, overlay) {
    syncScenesFromWorkbench(overlay, scenes);
    const selected = scenes.filter(scene => scene.enabled && scene.selectedUrl);
    if (!selected.length) return toastr.warning(tr('Select an image for at least one scene first.'));
    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message) return toastr.error(tr('The target message no longer exists.'));
    message.extra ??= {};
    const previous = message.extra[METADATA_KEY]?.scenes ?? [];
    const selectedIds = new Set(selected.map(scene => scene.id));
    const finalScenes = [...previous.filter(scene => !selectedIds.has(scene.id)), ...selected];
    const galleryFolder = getGalleryFolder(context, message);
    if (!galleryFolder) return toastr.error(tr("The current character's Gallery folder could not be found."));

    const progress = overlay.querySelector('.si-progress');
    const temporaryUrls = new Set([...scenes, ...finalScenes].flatMap(scene => [...(scene.candidates ?? []), scene.selectedUrl].filter(Boolean)));
    progress.textContent = tr('Archiving selected images to the character Gallery…');
    try {
        for (const scene of finalScenes) {
            if (isTemporaryImageUrl(scene.selectedUrl)) {
                scene.selectedUrl = await copyImageToGallery(scene.selectedUrl, galleryFolder, scene.id);
            }
            scene.candidates = scene.selectedUrl ? [scene.selectedUrl] : [];
        }

        let nextText = stripAllSceneMarkdown(message.mes);
        for (const scene of [...finalScenes].sort((a, b) => b.paragraphIndex - a.paragraphIndex)) {
            if (scene.selectedUrl) nextText = upsertSceneMarkdown(nextText, scene);
        }
        message.mes = nextText;
        message.extra[METADATA_KEY] = { version: METADATA_VERSION, scenes: finalScenes };
        await context.saveChat();
        context.updateMessageBlock(messageId, message);
        renderMessageScenes(messageId);

        const cleanupResults = await Promise.allSettled([...temporaryUrls].filter(isTemporaryImageUrl).map(deleteImageFile));
        const cleanupFailures = cleanupResults.filter(result => result.status === 'rejected').length;
        if (cleanupFailures) toastr.warning(tr('{count} temporary candidate files could not be deleted.', { count: cleanupFailures }));
        closeOverlay();
        toastr.success(tr('Inserted {count} images and archived them to the “{folder}” Gallery.', { count: selected.length, folder: galleryFolder }));
    } catch (error) {
        console.error(error);
        progress.textContent = tr('Archiving failed: {error}', { error: error.message });
        toastr.error(error.message, tr('Image archiving failed'));
    }
}

function getGalleryFolder(context, message) {
    const character = context.groupId
        ? context.characters.find(item => item?.name === message.name)
        : context.characters?.[context.characterId];
    return context.extensionSettings.gallery?.folders?.[character?.avatar] ?? character?.name ?? message.name ?? '';
}

async function copyImageToGallery(url, folder, sceneId) {
    const imageResponse = await fetch(url);
    if (!imageResponse.ok) throw new Error(tr('Could not read candidate image: {status}', { status: imageResponse.status }));
    const blob = await imageResponse.blob();
    const format = getImageFormat(blob.type, url);
    const image = arrayBufferToBase64(await blob.arrayBuffer());
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: getContext().getRequestHeaders(),
        body: JSON.stringify({
            image,
            format,
            ch_name: folder,
            filename: `scene_${Date.now()}_${String(sceneId).slice(0, 8)}`,
        }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || tr('Could not save the image to the Gallery.'));
    return (await response.json()).path;
}

async function deleteImageFile(url) {
    const response = await fetch('/api/images/delete', {
        method: 'POST',
        headers: getContext().getRequestHeaders(),
        body: JSON.stringify({ path: String(url).replace(/^\//, '') }),
    });
    if (!response.ok && response.status !== 404) throw new Error(tr('Could not delete candidate image: {status}', { status: response.status }));
}

function getImageFormat(mimeType, url) {
    const fromMime = String(mimeType ?? '').split('/')[1]?.toLowerCase();
    const fromUrl = String(url ?? '').match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/)?.[1]?.toLowerCase();
    const format = fromMime || fromUrl || 'png';
    return format === 'jpeg' ? 'jpg' : format;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunks = [];
    for (let index = 0; index < bytes.length; index += 0x8000) {
        chunks.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000)));
    }
    return btoa(chunks.join(''));
}
function renderMessageScenes(messageId) {
    const context = getContext();
    const message = context.chat?.[messageId];
    const textContainer = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
    if (!message || !textContainer) return;
    textContainer.querySelectorAll('.scene-illustrator-inline').forEach(element => element.remove());
    const paragraphs = splitParagraphs(stripAllSceneMarkdown(message.mes));
    for (const scene of message.extra?.[METADATA_KEY]?.scenes ?? []) {
        if (!scene.selectedUrl) continue;
        if (hasSceneMarkdown(message.mes, scene.id)) {
            const image = [...textContainer.querySelectorAll('img')].find(element => {
                const source = decodeURI(element.getAttribute('src') || '');
                return source === scene.selectedUrl || source.endsWith(`/${scene.selectedUrl.replace(/^\//, '')}`);
            });
            if (image) { image.classList.add('scene-illustrator-markdown'); image.dataset.sceneId = scene.id; }
            continue;
        }
        const placement = findParagraphElement(textContainer, scene, paragraphs);
        const figure = document.createElement('figure');
        figure.className = 'scene-illustrator-inline'; figure.dataset.sceneId = scene.id;
        const image = document.createElement('img'); image.src = scene.selectedUrl; image.alt = scene.title || tr('Scene image'); image.loading = 'lazy';
        figure.append(image);
        if (placement.fallback) { const warning = document.createElement('span'); warning.className = 'si-fallback'; warning.textContent = tr('The original paragraph changed, so the image was placed at the end of the message. Click the image to reposition it.'); figure.append(warning); }
        placement.element.after(figure);
    }
}

function renderAllMessages() {
    document.querySelectorAll('#chat .mes[mesid]').forEach(element => {
        const id = Number(element.getAttribute('mesid'));
        addMessageAction(id); renderMessageScenes(id);
    });
}

function openManualWorkbench(initialPrompt = '') {
    const messageId = findLatestAssistantMessageId();
    if (messageId < 0) return toastr.warning(tr('The current chat has no message where an image can be inserted.'));
    const context = getContext();
    const paragraphs = splitParagraphs(context.chat[messageId].mes);
    const scene = normalizeAnalysis({ scenes: [{ title: tr('Manual scene'), paragraphIndex: Math.max(0, paragraphs.length - 1), anchorText: paragraphs.at(-1)?.slice(0, 40) || '', camera: 'user defined', composition: '', visibleCharacters: [], visibleObjects: [], lighting: '', directPrompt: initialPrompt, booruPrompt: initialPrompt, negativePrompt: '' }], characterUpdates: [] }, paragraphs, messageId).scenes;
    openWorkbench(messageId, scene);
}

function openExistingScene(messageId, sceneId) {
    const scene = getContext().chat?.[messageId]?.extra?.[METADATA_KEY]?.scenes?.find(item => item.id === sceneId);
    if (scene) openWorkbench(messageId, [structuredClone(scene)]);
}

function openCharacterStateEditor() {
    const context = getContext();
    const state = getChatState(context);
    closeOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'scene-illustrator-overlay';
    overlay.innerHTML = `<section class="scene-illustrator-workbench"><div class="si-workbench-head"><h3>${tr('Character appearance state')}</h3><button class="menu_button si-close">${tr('Close')}</button></div><p>${tr('Add characters and custom state fields manually. Locked fields will not be overwritten by later AI analysis; custom fields are treated as user-provided by default.')}</p><div class="si-state-toolbar"><button class="menu_button si-add-character"><i class="fa-solid fa-user-plus"></i> ${tr('Add character')}</button></div><div class="si-character-list"></div><div class="si-workbench-actions"><button class="menu_button si-reset">${tr('Reset all / rebuild next time')}</button><button class="menu_button si-save-state">${tr('Save')}</button></div></section>`;
    const list = overlay.querySelector('.si-character-list');
    for (const [name, character] of Object.entries(state.characters)) list.append(createCharacterEditor(name, character));
    updateCharacterListEmptyState(list);
    overlay.querySelector('.si-close').addEventListener('click', closeOverlay);
    overlay.querySelector('.si-add-character').addEventListener('click', () => {
        const existing = [...list.querySelectorAll('[data-character-name]')].map(input => input.value.trim());
        let index = 1;
        let name = tr('New character');
        while (existing.includes(name)) name = `${tr('New character')} ${++index}`;
        list.querySelector('.si-empty-state')?.remove();
        const row = createCharacterEditor(name, createEmptyCharacterState());
        list.append(row);
        row.querySelector('[data-character-name]')?.focus();
    });
    overlay.querySelector('.si-reset').addEventListener('click', () => {
        state.characters = {};
        state.lastAnalyzedMessageId = -1;
        saveChatState(context, state);
        closeOverlay();
        toastr.info(tr('Reset complete. Add characters manually or let the next analysis rebuild them from available context.'));
    });
    overlay.querySelector('.si-save-state').addEventListener('click', () => {
        try {
            readCharacterEditors(overlay, state);
            saveChatState(context, state);
            closeOverlay();
            toastr.success(tr('Character state saved.'));
        } catch (error) {
            toastr.error(error.message, tr('Could not save character state'));
        }
    });
    document.body.append(overlay);
}

function createCharacterEditor(name, character) {
    const normalized = createChatState({ characters: { [name]: character } }).characters[String(name).trim()] ?? createEmptyCharacterState();
    const row = document.createElement('section');
    row.className = 'si-character-row';
    row.innerHTML = `<div class="si-character-title"><input class="text_pole" data-character-name placeholder="${tr('Character name')}"><button class="menu_button si-delete-character" title="${tr('Delete character')}"><i class="fa-solid fa-trash"></i></button></div><div class="si-fixed-fields"></div><div class="si-custom-fields"></div><button class="menu_button si-add-custom-field"><i class="fa-solid fa-plus"></i> ${tr('Add custom field')}</button>`;
    row.querySelector('[data-character-name]').value = name;
    const fixedContainer = row.querySelector('.si-fixed-fields');
    const labels = { appearance: tr('Appearance'), hair: tr('Hair'), clothing: tr('Clothing'), condition: tr('Condition / injuries'), accessories: tr('Accessories') };
    for (const key of Object.keys(labels)) {
        const field = document.createElement('label');
        field.className = 'si-character-field';
        field.innerHTML = `<span>${labels[key]}</span><input class="text_pole" data-field="${key}"><span><input type="checkbox" data-lock="${key}"> ${tr('Lock')}</span>`;
        field.querySelector('[data-field]').value = normalized[key] ?? '';
        field.querySelector('[data-lock]').checked = Boolean(normalized.locked?.[key]);
        fixedContainer.append(field);
    }
    const customContainer = row.querySelector('.si-custom-fields');
    for (const field of normalized.customFields ?? []) customContainer.append(createCustomFieldEditor(field));
    row.querySelector('.si-add-custom-field').addEventListener('click', () => {
        const custom = createCustomFieldEditor({ id: crypto.randomUUID(), label: '', value: '', locked: true });
        customContainer.append(custom);
        custom.querySelector('[data-custom-label]')?.focus();
    });
    row.querySelector('.si-delete-character').addEventListener('click', () => {
        const list = row.parentElement;
        row.remove();
        updateCharacterListEmptyState(list);
    });
    return row;
}

function createCustomFieldEditor(field) {
    const row = document.createElement('div');
    row.className = 'si-custom-field';
    row.dataset.fieldId = String(field.id || crypto.randomUUID());
    row.innerHTML = `<input class="text_pole" data-custom-label placeholder="${tr('Field name, e.g. volleyball position')}"><input class="text_pole" data-custom-value placeholder="${tr('State value')}"><label><input type="checkbox" data-custom-lock> ${tr('Lock')}</label><button class="menu_button si-delete-custom" title="${tr('Delete field')}"><i class="fa-solid fa-xmark"></i></button>`;
    row.querySelector('[data-custom-label]').value = field.label ?? '';
    row.querySelector('[data-custom-value]').value = field.value ?? '';
    row.querySelector('[data-custom-lock]').checked = field.locked !== false;
    row.querySelector('.si-delete-custom').addEventListener('click', () => row.remove());
    return row;
}

function readCharacterEditors(overlay, state) {
    const characters = {};
    for (const row of overlay.querySelectorAll('.si-character-row')) {
        const name = row.querySelector('[data-character-name]').value.trim();
        if (!name) throw new Error(tr('Character name cannot be blank.'));
        if (characters[name]) throw new Error(tr('Character name “{name}” is duplicated.', { name }));
        const character = createEmptyCharacterState();
        row.querySelectorAll('[data-field]').forEach(input => { character[input.dataset.field] = input.value.trim(); });
        row.querySelectorAll('[data-lock]').forEach(input => { character.locked[input.dataset.lock] = input.checked; });
        character.customFields = [...row.querySelectorAll('.si-custom-field')].map(custom => ({
            id: custom.dataset.fieldId || crypto.randomUUID(),
            label: custom.querySelector('[data-custom-label]').value.trim(),
            value: custom.querySelector('[data-custom-value]').value.trim(),
            locked: custom.querySelector('[data-custom-lock]').checked,
        })).filter(field => field.label || field.value);
        characters[name] = character;
    }
    state.characters = characters;
}

function updateCharacterListEmptyState(list) {
    list.querySelector('.si-empty-state')?.remove();
    if (!list.querySelector('.si-character-row')) {
        const empty = document.createElement('p');
        empty.className = 'si-empty-state';
        empty.textContent = tr('No character state yet. Click “Add character” to create one now; you do not need to wait for AI analysis.');
        list.append(empty);
    }
}
function getChatState(context) {
    try {
        return createChatState(context?.chatMetadata?.[METADATA_KEY]);
    } catch (error) {
        console.warn('Scene Illustrator: invalid character state snapshot; using an empty state.', error);
        return createChatState();
    }
}
function saveChatState(context, state) {
    if (!context.chatMetadata || typeof context.chatMetadata !== 'object') {
        console.warn('Scene Illustrator: chat metadata is unavailable; state will be used for this session only.');
        return;
    }
    context.chatMetadata[METADATA_KEY] = createChatState(state);
    context.saveMetadataDebounced?.();
}
function findLatestAssistantMessageId() { const chat = getContext().chat ?? []; for (let i = chat.length - 1; i >= 0; i--) if (!chat[i].is_user && !chat[i].is_system) return i; return chat.length - 1; }
function cancelActiveJob() { if (!activeJob) return; activeJob.cancelled = true; activeJob.controller?.abort(); }
function closeOverlay() { document.querySelectorAll('.scene-illustrator-overlay').forEach(element => element.remove()); }

function populateProfileSelect() {
    const select = document.querySelector('#si_profile'); if (!select) return;
    const old = settings.connectionProfileId; select.replaceChildren(new Option(tr('Select a profile'), ''));
    try { ConnectionManagerRequestService.getSupportedProfiles().forEach(profile => select.add(new Option(profile.name || profile.id, profile.id))); } catch (error) { console.warn('Scene Illustrator: profiles unavailable', error); }
    select.value = old;
}

function syncSettingsUi() {
    const set = (selector, value, property = 'value') => { const element = document.querySelector(selector); if (element) element[property] = value; };
    set('#si_enabled', settings.enabled, 'checked'); set('#si_analysis_source', settings.analysisSource); set('#si_profile', settings.connectionProfileId);
    set('#si_prompt_style', settings.promptStyle); set('#si_candidate_count', settings.candidateCount); set('#si_max_scenes', settings.maxScenes); set('#si_context_messages', settings.contextMessages);
    document.querySelector('#si_profile_row')?.toggleAttribute('hidden', settings.analysisSource !== 'profile');
}

function updateSetting(key, value) {
    extension_settings[MODULE_NAME][key] = value; settings = normalizeSettings(extension_settings[MODULE_NAME]); Object.assign(extension_settings[MODULE_NAME], settings); saveSettingsDebounced(); renderAllMessages();
}

function exportSettings() {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'scene-illustrator-settings.json'; link.click(); URL.revokeObjectURL(url);
}

async function importSettings(event) {
    const file = event.target.files?.[0]; if (!file) return;
    try { const value = normalizeSettings(JSON.parse(await file.text())); Object.assign(extension_settings[MODULE_NAME], DEFAULT_SETTINGS, value); settings = extension_settings[MODULE_NAME]; saveSettingsDebounced(); populateProfileSelect(); syncSettingsUi(); toastr.success(tr('Settings imported.')); }
    catch (error) { toastr.error(error.message, tr('Settings import failed')); }
    event.target.value = '';
}
