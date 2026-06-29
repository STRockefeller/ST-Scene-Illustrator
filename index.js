import { eventSource, event_types, generateRawData, saveSettingsDebounced } from '/script.js';
import { extension_settings, getContext } from '/scripts/extensions.js';
import { power_user } from '/scripts/power-user.js';
import { ConnectionManagerRequestService } from '/scripts/extensions/shared.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { DEFAULT_SETTINGS, METADATA_KEY, METADATA_VERSION, MODULE_NAME } from './src/constants.js';
import {
    buildImagineCommand, composeNegativePrompt, composePromptPrefix, createChatState, findParagraphElement, hasSceneMarkdown, isTemporaryImageUrl, mergeCharacterUpdates, stripAllSceneMarkdown, upsertSceneMarkdown,
    normalizeAnalysis, normalizeSettings, parseAnalysisResponse, scenePrompt, splitParagraphs, validateAnalysis,
} from './src/core.js';
import { ANALYSIS_SCHEMA, SYSTEM_PROMPT, buildAnalysisPrompt, buildRepairPrompt } from './src/prompts.js';

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
        helpString: '開啟 Scene Illustrator 手動生成工作台。可直接在命令後提供 prompt。',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'scene-analyze',
        callback: async () => { const id = findLatestAssistantMessageId(); if (id >= 0) await analyzeMessage(id, ''); return ''; },
        helpString: '分析最近一則 AI 回應並開啟場景工作台。',
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
    button.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i><span>為選取段落生成圖片</span>';
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
    button.title = '分析場景並生成圖片';
    actions.prepend(button);
}

async function analyzeMessage(messageId, selectionText) {
    if (activeJob) return toastr.warning('已有場景工作正在進行。');
    const context = getContext();
    const message = context.chat?.[messageId];
    const sourceChatId = context.chatId;
    if (!message?.mes) return toastr.error('找不到目標訊息。');
    const paragraphs = splitParagraphs(message.mes);
    if (!paragraphs.length) return toastr.warning('目標訊息沒有可分析文字。');

    const controller = new AbortController();
    activeJob = { kind: 'analysis', controller, cancelled: false };
    toastr.info('正在分析場景與角色狀態…', 'Scene Illustrator');
    try {
        const chatState = getChatState(context);
        const prompt = buildAnalysisPrompt({
            selectionText, maxScenes: selectionText ? 1 : settings.maxScenes, paragraphs,
            characterState: chatState.characters, characterReference: await collectCharacterReference(context),
            chatContext: collectChatContext(context, messageId, chatState.lastAnalyzedMessageId),
        });
        let raw = await requestAnalysis(prompt, controller.signal);
        let parsed;
        let errors;
        try { parsed = parseAnalysisResponse(raw); errors = validateAnalysis(parsed, paragraphs.length, selectionText ? 1 : settings.maxScenes); }
        catch (error) { errors = [error.message]; }
        if (errors.length) {
            raw = await requestAnalysis(buildRepairPrompt(typeof raw === 'string' ? raw : JSON.stringify(raw), errors), controller.signal);
            parsed = parseAnalysisResponse(raw);
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
        if (error.name !== 'AbortError') { console.error(error); toastr.error(error.message, '場景分析失敗'); }
    } finally { activeJob = null; }
}

async function requestAnalysis(userPrompt, signal) {
    if (settings.analysisSource === 'profile') {
        if (!settings.connectionProfileId) throw new Error('請先選擇 Connection Profile。');
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

function collectChatContext(context, targetId, lastAnalyzedId) {
    const start = Math.max(0, Math.min(targetId, Math.max(lastAnalyzedId + 1, targetId - settings.contextMessages + 1)));
    return context.chat.slice(start, targetId + 1).map((message, offset) => {
        const id = start + offset;
        const role = message.is_user ? 'user' : message.is_system ? 'system' : 'character';
        return `[message ${id}; ${role}; ${message.name || ''}] ${message.mes || ''}`;
    }).join('\n\n');
}

async function collectCharacterReference(context) {
    const references = [];
    const named = [...new Set(context.chat.slice(-settings.contextMessages).map(message => message.name).filter(Boolean))];
    const activeCharacters = context.groupId
        ? context.characters.filter(character => named.includes(character?.name))
        : [context.characters?.[context.characterId]].filter(Boolean);
    for (const character of activeCharacters) {
        references.push(JSON.stringify({ name: character.name, description: character.description, scenario: character.scenario, personality: character.personality }));
    }
    if (power_user.persona_description) references.push(`User persona: ${power_user.persona_description}`);
    try {
        const chatForWorldInfo = context.chat.map(message => `${message.name || ''}: ${message.mes || ''}`).reverse();
        const world = await context.getWorldInfoPrompt(chatForWorldInfo, context.maxContext, true);
        const lore = [world?.worldInfoBefore, world?.worldInfoAfter].filter(Boolean).join('\n');
        if (lore) references.push(`Activated world info: ${lore}`);
    } catch (error) { console.warn('Scene Illustrator: world info scan failed', error); }
    references.push(`Active names: ${named.join(', ')}`);
    return references.join('\n');
}

function openWorkbench(messageId, scenes) {
    closeOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'scene-illustrator-overlay';
    overlay.innerHTML = `<section class="scene-illustrator-workbench"><div class="si-workbench-head"><h3>場景圖像工作台</h3><button class="menu_button si-close">關閉</button></div><div class="si-progress"></div><div class="si-scenes"></div><div class="si-workbench-actions"><button class="menu_button si-cancel-job">取消後續生成</button><button class="menu_button si-generate"><i class="fa-solid fa-images"></i> 生成候選圖</button><button class="menu_button si-save"><i class="fa-solid fa-check"></i> 插入已選圖片</button></div></section>`;
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
    card.innerHTML = `<div class="si-scene-head"><strong></strong><label><input type="checkbox" class="si-enabled" checked> 生成此場景</label></div><div class="si-scene-meta"><label>插入段落</label><input class="text_pole si-paragraph" type="number" min="0"><label>提示詞風格</label><select class="text_pole si-style"><option value="direct">直接描述</option><option value="booru">Booru tags</option></select></div><label>直接描述 prompt<textarea class="text_pole si-direct"></textarea></label><label>Booru tags<textarea class="text_pole si-booru"></textarea></label><label>Negative prompt<textarea class="text_pole si-negative"></textarea></label><details class="si-actual-prompt" open><summary>實際送入圖像模型的固定 Prompt</summary><div><b>Positive</b><pre class="si-actual-positive"></pre><b>Negative</b><pre class="si-actual-negative"></pre></div></details><div class="si-candidates"></div>`;
    card.querySelector('strong').textContent = `${index + 1}. ${scene.title}`;
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
    card.querySelector('.si-actual-positive').textContent = scene.actualPrompt || '（空白）';
    card.querySelector('.si-actual-negative').textContent = scene.actualNegativePrompt || '（空白）';
}

async function generateCandidates(overlay, scenes) {
    if (activeJob) return toastr.warning('已有工作正在進行。');
    syncScenesFromWorkbench(overlay, scenes);
    const progress = overlay.querySelector('.si-progress');
    activeJob = { kind: 'imageBatch', cancelled: false, controller: new AbortController(), frozenPrompts: new Set() };
    const enabled = scenes.filter(scene => scene.enabled);
    if (!enabled.length) { activeJob = null; return toastr.warning('請至少勾選一個場景。'); }
    const total = enabled.length * settings.candidateCount;
    let done = 0;
    const sd = extension_settings.sd;
    if (!sd) { activeJob = null; return toastr.error('找不到官方 Image Generation 設定。'); }
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
            progress.textContent = `正在批次生成 ${scene.title}：${settings.candidateCount} 張候選使用同一份固定 Prompt（總進度 ${done}/${total}）`;
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
            if (!scene.candidates.length) throw failures[0] ?? new Error('批次生成沒有回傳圖片。');
            if (failures.length) toastr.warning(`${scene.title} 有 ${failures.length} 張生成失敗，其餘候選已保留。`);
        }
        progress.textContent = `完成，共生成 ${done} 張候選圖；同一場景的候選均使用畫面上顯示的同一份固定 Prompt。`;
    } catch (error) {
        progress.textContent = error.name === 'AbortError' ? '已取消後續生成。' : `生成中止：${error.message}`;
        if (error.name !== 'AbortError') { console.error(error); toastr.error(error.message, '圖片生成失敗'); }
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
    if (!url) throw new Error('官方 Image Generation 未回傳圖片 URL。請確認已啟用並完成後端設定。');
    return url;
}
function renderCandidates(card, scene) {
    const container = card?.querySelector('.si-candidates');
    if (!container) return;
    container.replaceChildren();
    scene.candidates.forEach((url, index) => {
        const button = document.createElement('button');
        button.className = `si-candidate${scene.selectedUrl === url ? ' selected' : ''}`;
        button.title = `選擇候選圖 ${index + 1}`;
        const image = document.createElement('img');
        image.src = url; image.alt = `${scene.title} 候選圖 ${index + 1}`; image.loading = 'lazy';
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
    if (!selected.length) return toastr.warning('請先為至少一個場景選擇圖片。');
    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message) return toastr.error('目標訊息已不存在。');
    message.extra ??= {};
    const previous = message.extra[METADATA_KEY]?.scenes ?? [];
    const selectedIds = new Set(selected.map(scene => scene.id));
    const finalScenes = [...previous.filter(scene => !selectedIds.has(scene.id)), ...selected];
    const galleryFolder = getGalleryFolder(context, message);
    if (!galleryFolder) return toastr.error('找不到目前角色的 Gallery 資料夾。');

    const progress = overlay.querySelector('.si-progress');
    const temporaryUrls = new Set([...scenes, ...finalScenes].flatMap(scene => [...(scene.candidates ?? []), scene.selectedUrl].filter(Boolean)));
    progress.textContent = '正在將選定圖片歸檔至角色 Gallery…';
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
        if (cleanupFailures) toastr.warning(`${cleanupFailures} 個候選暫存檔無法刪除。`);
        closeOverlay();
        toastr.success(`已插入 ${selected.length} 張圖片並歸檔至「${galleryFolder}」Gallery。`);
    } catch (error) {
        console.error(error);
        progress.textContent = `歸檔失敗：${error.message}`;
        toastr.error(error.message, '圖片歸檔失敗');
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
    if (!imageResponse.ok) throw new Error(`無法讀取候選圖片：${imageResponse.status}`);
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
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || '無法將圖片存入 Gallery。');
    return (await response.json()).path;
}

async function deleteImageFile(url) {
    const response = await fetch('/api/images/delete', {
        method: 'POST',
        headers: getContext().getRequestHeaders(),
        body: JSON.stringify({ path: String(url).replace(/^\//, '') }),
    });
    if (!response.ok && response.status !== 404) throw new Error(`刪除候選圖片失敗：${response.status}`);
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
        const image = document.createElement('img'); image.src = scene.selectedUrl; image.alt = scene.title || '場景圖片'; image.loading = 'lazy';
        figure.append(image);
        if (placement.fallback) { const warning = document.createElement('span'); warning.className = 'si-fallback'; warning.textContent = '原段落已變更，圖片暫時放在訊息末尾。點擊圖片可重新定位。'; figure.append(warning); }
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
    if (messageId < 0) return toastr.warning('目前聊天沒有可插入圖片的訊息。');
    const context = getContext();
    const paragraphs = splitParagraphs(context.chat[messageId].mes);
    const scene = normalizeAnalysis({ scenes: [{ title: '手動場景', paragraphIndex: Math.max(0, paragraphs.length - 1), anchorText: paragraphs.at(-1)?.slice(0, 40) || '', camera: 'user defined', composition: '', visibleCharacters: [], visibleObjects: [], lighting: '', directPrompt: initialPrompt, booruPrompt: initialPrompt, negativePrompt: '' }], characterUpdates: [] }, paragraphs, messageId).scenes;
    openWorkbench(messageId, scene);
}

function openExistingScene(messageId, sceneId) {
    const scene = getContext().chat?.[messageId]?.extra?.[METADATA_KEY]?.scenes?.find(item => item.id === sceneId);
    if (scene) openWorkbench(messageId, [structuredClone(scene)]);
}

function openCharacterStateEditor() {
    const context = getContext(); const state = getChatState(context); closeOverlay();
    const overlay = document.createElement('div'); overlay.className = 'scene-illustrator-overlay';
    overlay.innerHTML = `<section class="scene-illustrator-workbench"><div class="si-workbench-head"><h3>角色外觀狀態</h3><button class="menu_button si-close">關閉</button></div><p>勾選鎖定後，後續分析不會覆寫該欄位。</p><div class="si-character-list"></div><div class="si-workbench-actions"><button class="menu_button si-reset">重設／下次重建</button><button class="menu_button si-save-state">儲存</button></div></section>`;
    const list = overlay.querySelector('.si-character-list');
    for (const [name, character] of Object.entries(state.characters)) list.append(createCharacterEditor(name, character));
    if (!list.children.length) list.textContent = '尚無角色快照；完成一次場景分析後會自動建立。';
    overlay.querySelector('.si-close').addEventListener('click', closeOverlay);
    overlay.querySelector('.si-reset').addEventListener('click', () => { state.characters = {}; state.lastAnalyzedMessageId = -1; saveChatState(context, state); closeOverlay(); toastr.info('已重設；下次分析會從可用上下文重建。'); });
    overlay.querySelector('.si-save-state').addEventListener('click', () => { readCharacterEditors(overlay, state); saveChatState(context, state); closeOverlay(); toastr.success('角色狀態已儲存。'); });
    document.body.append(overlay);
}

function createCharacterEditor(name, character) {
    const row = document.createElement('div'); row.className = 'si-character-row'; row.dataset.character = name;
    const title = document.createElement('strong'); title.textContent = name; row.append(title);
    for (const key of ['appearance', 'hair', 'clothing', 'condition', 'accessories']) {
        const field = document.createElement('label'); field.className = 'si-character-field';
        field.innerHTML = `<span>${{ appearance: '外觀', hair: '髮型', clothing: '衣著', condition: '狀態／傷勢', accessories: '配件' }[key]}</span><input class="text_pole" data-field="${key}"><span><input type="checkbox" data-lock="${key}"> 鎖定</span>`;
        field.querySelector('[data-field]').value = character[key] ?? '';
        field.querySelector('[data-lock]').checked = Boolean(character.locked?.[key]); row.append(field);
    }
    return row;
}

function readCharacterEditors(overlay, state) {
    overlay.querySelectorAll('.si-character-row').forEach(row => {
        const character = state.characters[row.dataset.character]; character.locked ??= {};
        row.querySelectorAll('[data-field]').forEach(input => { character[input.dataset.field] = input.value.trim(); });
        row.querySelectorAll('[data-lock]').forEach(input => { character.locked[input.dataset.lock] = input.checked; });
    });
}

function getChatState(context) { return createChatState(context.chatMetadata?.[METADATA_KEY]); }
function saveChatState(context, state) { context.chatMetadata[METADATA_KEY] = state; context.saveMetadataDebounced(); }
function findLatestAssistantMessageId() { const chat = getContext().chat ?? []; for (let i = chat.length - 1; i >= 0; i--) if (!chat[i].is_user && !chat[i].is_system) return i; return chat.length - 1; }
function cancelActiveJob() { if (!activeJob) return; activeJob.cancelled = true; activeJob.controller?.abort(); }
function closeOverlay() { document.querySelectorAll('.scene-illustrator-overlay').forEach(element => element.remove()); }

function populateProfileSelect() {
    const select = document.querySelector('#si_profile'); if (!select) return;
    const old = settings.connectionProfileId; select.replaceChildren(new Option('請選擇', ''));
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
    try { const value = normalizeSettings(JSON.parse(await file.text())); Object.assign(extension_settings[MODULE_NAME], DEFAULT_SETTINGS, value); settings = extension_settings[MODULE_NAME]; saveSettingsDebounced(); populateProfileSelect(); syncSettingsUi(); toastr.success('設定已匯入。'); }
    catch (error) { toastr.error(error.message, '設定匯入失敗'); }
    event.target.value = '';
}
















