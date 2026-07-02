# Scene Illustrator for SillyTavern

Scene Illustrator is an image-generation extension for SillyTavern 1.18.0 and later, designed around scene comprehension and visual continuity. It builds on the backend configuration provided by SillyTavern's official Image Generation extension—including ComfyUI, AUTOMATIC1111, Google, and OpenAI—and adds scene selection, persistent character appearance, prompt review, multiple image candidates, and inline image insertion.

> This document is also available in [Traditional Chinese](docs/README.zh-TW.md).

## Features

- Analyze an AI response and identify one to three scenes suitable for illustration.
- Generate an image from a selected passage or a fully manual prompt.
- Review and edit both direct and booru-style prompts before generation.
- Maintain visual character state, including hairstyle, clothing, injuries, accessories, and custom fields.
- Generate multiple candidates for each scene and select the preferred result.
- Archive selected images in the character Gallery and insert them into the original response as editable Markdown.
- Reuse the image backends and credentials already configured in SillyTavern.

## Requirements

- SillyTavern 1.18.0 or later
- The official SillyTavern Image Generation extension
- A configured and working image-generation backend

## Installation

1. Update SillyTavern to version 1.18.0 or later.
2. Install this repository through **Extensions → Install Extension** using its Git repository URL. Alternatively, clone or copy it to:

   ```text
   SillyTavern/data/<user>/extensions/scene-illustrator
   ```

3. Reload SillyTavern.
4. Open the official Image Generation panel and configure and test ComfyUI or another supported backend.
5. Open the Scene Illustrator settings and choose an analysis model, prompt style, and number of candidates.

## Usage

The wand button in an AI message's action menu analyzes that response and proposes one to three scenes. To generate from a specific passage, select the text in the message and choose the generation action for the selected content.

For a fully manual workflow, use the Scene Illustrator settings panel or run:

```text
/scene-image your prompt
```

The workspace displays direct and booru-style prompts for review. After confirmation, Scene Illustrator submits them through SillyTavern's official `/imagine` command. Select one candidate for each scene, then choose **Insert Selected Images**. Selected images are archived in the character Gallery and inserted into the original response as tagged Markdown. Unselected temporary candidates are removed automatically.

## Analysis Models

- **Current chat model** uses SillyTavern's native structured generation.
- **Connection Profile** uses a separate Chat Completion or Text Completion profile while leaving credential management to SillyTavern.
- Invalid, incomplete, or malformed analysis output is repaired once automatically. If the repaired result is still invalid, generation stops before any image request is submitted.

## Character State

Scene Illustrator stores visual snapshots—such as hairstyles, clothing, injuries, and accessories—in the chat metadata. The **Character State** section allows users to add characters before analysis and to add, rename, remove, or lock custom fields for each character.

After a reset, the next analysis reconstructs character state from available character cards, personas, tracker metadata, visible tracker text, enabled World Info, and conversation context preceding the target message. Missing or corrupted character state does not prevent scene generation.

## Slash Commands

- `/scene-image [prompt]` opens the manual generation workspace.
- `/scene-analyze` analyzes the most recent AI response.

## Development

Node.js 20 or later is recommended for local validation.

```powershell
npm run check
npm test
```

The automated test suite covers Chinese and English paragraphs, repaired JSON parsing, underspecified prompts, manual characters and custom fields, corrupted-state fallbacks, long conversation and tracker context, locked character fields, slash-command escaping, settings migration, and camera-visibility rules.

## Current Limitations

- Candidates for the same scene are submitted concurrently using one frozen prompt. Separate scenes are processed sequentially to avoid overloading the backend.
- **Cancel Remaining Generation** prevents subsequent scenes from being submitted. An already submitted candidate batch can be stopped through the cancellation control provided by the official Image Generation extension.
- Images are stored directly in response Markdown. If an image is removed manually while its metadata remains, compatibility rendering may persist until the scene is saved again.

## License

This project is distributed under the [MIT License](LICENSE).
