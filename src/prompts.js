export const ANALYSIS_SCHEMA = Object.freeze({
    name: 'scene_illustrator_analysis', strict: true,
    value: {
        type: 'object', additionalProperties: false, required: ['scenes', 'characterUpdates'],
        properties: {
            scenes: { type: 'array', minItems: 1, maxItems: 3, items: {
                type: 'object', additionalProperties: false,
                required: ['title', 'paragraphIndex', 'anchorText', 'camera', 'composition', 'visibleCharacters', 'visibleObjects', 'lighting', 'directPrompt', 'booruPrompt', 'negativePrompt'],
                properties: {
                    title: { type: 'string' }, paragraphIndex: { type: 'integer', minimum: 0 }, anchorText: { type: 'string' },
                    camera: { type: 'string' }, composition: { type: 'string' }, lighting: { type: 'string' },
                    visibleCharacters: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'visualDescription', 'action', 'position'], properties: { name: { type: 'string' }, visualDescription: { type: 'string' }, action: { type: 'string' }, position: { type: 'string' } } } },
                    visibleObjects: { type: 'array', items: { type: 'string' } },
                    directPrompt: { type: 'string' }, booruPrompt: { type: 'string' }, negativePrompt: { type: 'string' },
                },
            } },
            characterUpdates: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'appearance', 'hair', 'clothing', 'condition', 'accessories'], properties: { name: { type: 'string' }, appearance: { type: 'string' }, hair: { type: 'string' }, clothing: { type: 'string' }, condition: { type: 'string' }, accessories: { type: 'string' } } } },
        },
    },
});

export const SCHEMA_GUIDE = `Required JSON shape:
{"scenes":[{"title":"string","paragraphIndex":0,"anchorText":"exact quote","camera":"string","composition":"string","visibleCharacters":[{"name":"string","visualDescription":"string","action":"string","position":"string"}],"visibleObjects":["string"],"lighting":"string","directPrompt":"string","booruPrompt":"string","negativePrompt":"string"}],"characterUpdates":[{"name":"string","appearance":"string","hair":"string","clothing":"string","condition":"string","accessories":"string"}]}`;
export const SYSTEM_PROMPT = `You are an elite AI image-generation prompt engineer and visual continuity editor. Read multilingual roleplay accurately, including Traditional Chinese. Return JSON only.

For each candidate scene, internally expand five dimensions before writing prompts:
1. SUBJECT DETAIL: exact count, species/gender presentation, stable physical traits, current hairstyle, clothing, accessories, pose, facial expression, body mechanics, and interaction.
2. ENVIRONMENT: exact location, architecture, floor/wall/background details, relevant props, time, weather, and atmosphere.
3. LIGHTING AND COLOR: light source and direction, light quality, shadows, palette, contrast, and effects.
4. CAMERA AND COMPOSITION: shot size, viewing angle, lens feel, framing, subject placement, perspective, motion, and depth of field.
5. ART AND QUALITY: consistent anime/illustration or realistic rendering language and appropriate quality anchors.

Hard rules:
- One scene is one coherent still image from one camera position. Include only visible people and objects. Never merge opposite views, off-screen details, memories, dialogue-only concepts, smells, thoughts, or sounds.
- Replace private proper nouns with concrete visual descriptions. Never use a name as a substitute for appearance.
- Every visible character must have supported physical traits, current hair, clothing, accessories, condition/injuries, pose, expression, and action. Never invent uncertain story facts.
- Never copy prose or dialogue from the source into an image prompt. Translate narrative facts into visual English tags/descriptions.
- directPrompt must be self-contained detailed natural English of at least 55 words.
- booruPrompt must contain at least 30 precise English comma-separated tags, ordered as: subject/count, appearance and clothing, action and expression, environment, camera/composition, lighting/effects, atmosphere/color, quality.
- For anime/illustration scenes end booruPrompt with suitable anchors such as: masterpiece, best quality, ultra-detailed, cinematic lighting, depth of field.
- For realistic scenes use suitable anchors such as: masterpiece, best quality, photorealistic, hyper-detailed, 8k resolution, film grain, cinematic lighting.
- directPrompt and booruPrompt must describe the exact same frame.
- paragraphIndex is zero-based within the target message; anchorText is a short exact quote used only for placement and must not be copied into prompts.
- characterUpdates contains only supported visual state. Unknown fields are empty strings. Follow locked fields exactly and do not update them.`;
export function buildAnalysisPrompt(input) {
    const task = input.selectionText
        ? `The user selected this exact passage. Produce exactly one scene centered on it:\n${input.selectionText}`
        : `Select between 1 and ${input.maxScenes} visually important scenes from the target message.`;
    return `${task}\n\nTARGET MESSAGE PARAGRAPHS (zero-based):\n${input.paragraphs.map((text, index) => `[${index}] ${text}`).join('\n')}\n\nCURRENT CHARACTER VISUAL STATE:\n${JSON.stringify(input.characterState, null, 2)}\n\nCHARACTER / PERSONA REFERENCE:\n${input.characterReference || '(none available)'}\n\nRECENT CHAT CONTEXT:\n${input.chatContext}\n\nReturn JSON matching the schema. Do not continue the story.\n\n${SCHEMA_GUIDE}`;
}

export function buildRepairPrompt(raw, errors) {
    return `Repair this invalid scene analysis. Return JSON only.\n\n${SCHEMA_GUIDE}\n\nERRORS:\n${errors.join('\n')}\n\nOUTPUT:\n${raw}`;
}



