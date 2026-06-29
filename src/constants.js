export const MODULE_NAME = 'scene_illustrator';
export const METADATA_KEY = 'scene_illustrator_v1';
export const METADATA_VERSION = 1;
export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    analysisSource: 'current',
    connectionProfileId: '',
    promptStyle: 'direct',
    candidateCount: 4,
    maxScenes: 3,
    contextMessages: 40,
    maxAnalysisTokens: 4000,
});
export const PROMPT_STYLES = Object.freeze({ direct: 'directPrompt', booru: 'booruPrompt' });
export const EMPTY_CHAT_STATE = Object.freeze({ version: METADATA_VERSION, lastAnalyzedMessageId: -1, characters: {} });
