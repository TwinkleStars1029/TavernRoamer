import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [sourcePath, installedPath, outputDirectory, mode = 'raw-openai'] = process.argv.slice(2);
if (!sourcePath || !installedPath || !outputDirectory) {
  throw new Error('Usage: node scripts/verify-preset-roundtrip.mjs <source> <installed> <output-dir>');
}

const sourceText = await readFile(sourcePath, 'utf8');
const installedText = await readFile(installedPath, 'utf8');
const source = JSON.parse(sourceText);
const installed = JSON.parse(installedText);
const backupData = mode === 'tavern-helper' ? toTavernHelperPreset(installed) : structuredClone(installed);
const snapshot = {
  kind: 'preset',
  exportedAt: new Date().toISOString(),
  name: path.basename(installedPath, '.json'),
  format: mode === 'tavern-helper' ? 'tavern-helper-preset-v1' : 'sillytavern-openai-preset-v1',
  data: structuredClone(backupData),
};
const restored = mode === 'tavern-helper'
  ? fromTavernHelperPreset(structuredClone(snapshot.data))
  : structuredClone(snapshot.data);

const sourceVsInstalled = diffJson(source, installed);
const sourceVsRestored = diffJson(source, restored);
const backupSummary = {
  top_level_keys: Object.keys(backupData).length,
  prompts: backupData.prompts?.length ?? 0,
  prompt_order_entries: backupData.prompt_order?.[0]?.order?.length ?? 0,
  prompts_unused: backupData.prompts_unused?.length ?? 0,
  regex_scripts: backupData.extensions?.regex_scripts?.length ?? 0,
  tavern_helper_scripts: backupData.extensions?.tavern_helper?.scripts?.length ?? 0,
  tavern_helper_variables: Object.keys(backupData.extensions?.tavern_helper?.variables ?? {}).length,
};
const report = {
  source: { path: sourcePath, bytes: Buffer.byteLength(sourceText), sha256: sha256(sourceText) },
  installed: { path: installedPath, bytes: Buffer.byteLength(installedText), sha256: sha256(installedText) },
  snapshot: {
    bytes: Buffer.byteLength(JSON.stringify(snapshot, null, 2)),
    format: snapshot.format,
    ...backupSummary,
  },
  exactInstallMatch: sourceVsInstalled.length === 0,
  semanticRoundTripMatch: sourceVsRestored.length === 0,
  sourceVsInstalled,
  sourceVsRestored,
};

await writeFile(path.join(outputDirectory, 'tavern-roamer-preset-backup.json'), JSON.stringify(snapshot, null, 2));
await writeFile(path.join(outputDirectory, 'restored-openai-preset.json'), JSON.stringify(restored, null, 2));
await writeFile(path.join(outputDirectory, 'comparison-report.json'), JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report, null, 2));

function toTavernHelperPreset(preset) {
  const promptOrder = preset.prompt_order?.find(order => order.character_id === 100001)?.order ?? [];
  const promptsAll = (preset.prompts ?? []).map(prompt => toPresetPrompt(prompt, promptOrder));
  const orderIds = promptOrder.map(order => order.identifier);
  const promptById = new Map(promptsAll.map(prompt => [prompt.id, prompt]));
  const prompts = orderIds.map(id => promptById.get(id)).filter(Boolean);
  const promptsUnused = promptsAll.filter(prompt => !orderIds.includes(prompt.id));
  const extensions = structuredClone(preset.extensions ?? {});
  extensions.regex_scripts = (extensions.regex_scripts ?? []).map(toTavernRegex);
  return {
    settings: {
      max_context: Number(preset.openai_max_context),
      max_completion_tokens: Number(preset.openai_max_tokens),
      reply_count: Number(preset.n),
      should_stream: Boolean(preset.stream_openai),
      temperature: Number(preset.temperature),
      frequency_penalty: Number(preset.frequency_penalty),
      presence_penalty: Number(preset.presence_penalty),
      repetition_penalty: Number(preset.repetition_penalty),
      top_p: Number(preset.top_p),
      min_p: Number(preset.min_p),
      top_k: Number(preset.top_k),
      top_a: Number(preset.top_a),
      seed: Number(preset.seed),
      squash_system_messages: Boolean(preset.squash_system_messages),
      reasoning_effort: String(preset.reasoning_effort),
      request_thoughts: Boolean(preset.show_thoughts),
      request_images: Boolean(preset.request_images),
      enable_function_calling: Boolean(preset.function_calling),
      enable_web_search: Boolean(preset.enable_web_search),
      allow_sending_images: preset.image_inlining ? String(preset.inline_image_quality) : 'disabled',
      allow_sending_videos: Boolean(preset.video_inlining),
      character_name_prefix: ({ '-1': 'none', 0: 'default', 2: 'content', 1: 'completion' })[preset.names_behavior],
      wrap_user_messages_in_quotes: Boolean(preset.wrap_in_quotes),
    },
    prompts,
    prompts_unused: promptsUnused,
    extensions,
  };
}

function toPresetPrompt(prompt, promptOrder) {
  const isNormal = prompt.system_prompt === false && !prompt.marker;
  const isSystem = prompt.system_prompt === true && !prompt.marker;
  const isPlaceholder = prompt.marker === true;
  const result = {
    id: prompt.identifier,
    name: prompt.name ?? 'unnamed',
    enabled: promptOrder.find(order => order.identifier === prompt.identifier)?.enabled ?? prompt.enabled ?? true,
    role: prompt.role ?? 'system',
  };
  if (isNormal || isPlaceholder) {
    result.position = prompt.injection_position === 1
      ? { type: 'in_chat', depth: prompt.injection_depth ?? 4, order: prompt.injection_order ?? 100 }
      : { type: 'relative' };
  }
  if (isNormal || isSystem) result.content = prompt.content ?? '';
  if (prompt.extra) result.extra = structuredClone(prompt.extra);
  return result;
}

function fromTavernHelperPreset(preset) {
  const used = preset.prompts.map(fromPresetPrompt);
  const unused = preset.prompts_unused.map(fromPresetPrompt);
  const extensions = structuredClone(preset.extensions);
  if (extensions.regex_scripts?.[0]?.source) extensions.regex_scripts = extensions.regex_scripts.map(fromTavernRegex);
  return {
    max_context_unlocked: true,
    openai_max_context: preset.settings.max_context,
    openai_max_tokens: preset.settings.max_completion_tokens,
    n: preset.settings.reply_count,
    stream_openai: preset.settings.should_stream,
    temp_openai: preset.settings.temperature,
    freq_pen_openai: preset.settings.frequency_penalty,
    pres_pen_openai: preset.settings.presence_penalty,
    top_p_openai: preset.settings.top_p,
    repetition_penalty_openai: preset.settings.repetition_penalty,
    min_p_openai: preset.settings.min_p,
    top_k_openai: preset.settings.top_k,
    top_a_openai: preset.settings.top_a,
    temperature: preset.settings.temperature,
    frequency_penalty: preset.settings.frequency_penalty,
    presence_penalty: preset.settings.presence_penalty,
    top_p: preset.settings.top_p,
    repetition_penalty: preset.settings.repetition_penalty,
    min_p: preset.settings.min_p,
    top_k: preset.settings.top_k,
    top_a: preset.settings.top_a,
    seed: preset.settings.seed,
    squash_system_messages: preset.settings.squash_system_messages,
    reasoning_effort: preset.settings.reasoning_effort,
    show_thoughts: preset.settings.request_thoughts,
    request_images: preset.settings.request_images,
    function_calling: preset.settings.enable_function_calling,
    enable_web_search: preset.settings.enable_web_search,
    image_inlining: preset.settings.allow_sending_images !== 'disabled',
    inline_image_quality: preset.settings.allow_sending_images === 'disabled' ? 'auto' : preset.settings.allow_sending_images,
    video_inlining: preset.settings.allow_sending_videos,
    names_behavior: ({ none: -1, default: 0, content: 2, completion: 1 })[preset.settings.character_name_prefix],
    wrap_in_quotes: preset.settings.wrap_user_messages_in_quotes,
    prompts: [...used, ...unused],
    prompt_order: [{
      character_id: 100001,
      order: used.map(prompt => ({ identifier: prompt.identifier, enabled: prompt.enabled ?? true })),
    }],
    extensions,
  };
}

function fromPresetPrompt(prompt) {
  const systemIds = ['main', 'nsfw', 'jailbreak', 'enhanceDefinitions'];
  const placeholderIds = ['worldInfoBefore', 'personaDescription', 'charDescription', 'charPersonality', 'scenario', 'worldInfoAfter', 'dialogueExamples', 'chatHistory'];
  const isSystem = systemIds.includes(prompt.id);
  const isPlaceholder = placeholderIds.includes(prompt.id);
  const isNormal = !isSystem && !isPlaceholder;
  const result = { identifier: prompt.id, name: prompt.name, enabled: prompt.enabled, role: prompt.role };
  if ((isNormal || isPlaceholder) && !['dialogueExamples', 'chatHistory'].includes(prompt.id)) {
    result.injection_position = (prompt.position?.type ?? 'relative') === 'relative' ? 0 : 1;
    result.injection_depth = prompt.position?.depth ?? 4;
    result.injection_order = prompt.position?.order ?? 100;
  }
  if (isNormal || isSystem) result.content = prompt.content;
  result.system_prompt = isSystem || isPlaceholder;
  result.marker = isPlaceholder;
  if (prompt.extra) result.extra = structuredClone(prompt.extra);
  result.forbid_overrides = false;
  return result;
}

function toTavernRegex(regex) {
  const placement = regex.placement ?? [];
  return {
    id: regex.id,
    script_name: regex.scriptName,
    enabled: !regex.disabled,
    find_regex: regex.findRegex,
    trim_strings: regex.trimStrings || [],
    replace_string: regex.replaceString,
    source: { user_input: placement.includes(1), ai_output: placement.includes(2), slash_command: placement.includes(3), world_info: placement.includes(5), reasoning: placement.includes(6) },
    destination: { display: regex.markdownOnly, prompt: regex.promptOnly },
    run_on_edit: regex.runOnEdit,
    min_depth: typeof regex.minDepth === 'number' ? regex.minDepth : null,
    max_depth: typeof regex.maxDepth === 'number' ? regex.maxDepth : null,
  };
}

function fromTavernRegex(regex) {
  return {
    id: regex.id,
    scriptName: regex.script_name,
    disabled: !regex.enabled,
    runOnEdit: regex.run_on_edit,
    findRegex: regex.find_regex,
    trimStrings: regex.trim_strings || [],
    replaceString: regex.replace_string,
    placement: [regex.source.user_input && 1, regex.source.ai_output && 2, regex.source.slash_command && 3, regex.source.world_info && 5, regex.source.reasoning && 6].filter(Boolean),
    substituteRegex: 0,
    minDepth: regex.min_depth,
    maxDepth: regex.max_depth,
    markdownOnly: regex.destination.display,
    promptOnly: regex.destination.prompt,
  };
}

function diffJson(left, right, currentPath = '$', output = []) {
  if (Object.is(left, right)) return output;
  if (Array.isArray(left) && Array.isArray(right)) {
    const size = Math.max(left.length, right.length);
    for (let index = 0; index < size; index += 1) diffJson(left[index], right[index], `${currentPath}[${index}]`, output);
    return output;
  }
  if (isObject(left) && isObject(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) diffJson(left[key], right[key], `${currentPath}.${key}`, output);
    return output;
  }
  output.push({ path: currentPath, source: summarize(left), restored: summarize(right) });
  return output;
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sha256(text) { return createHash('sha256').update(text).digest('hex'); }
function summarize(value) {
  if (value === undefined) return { type: 'missing' };
  if (typeof value === 'string' && value.length > 160) return { type: 'string', length: value.length, sample: value.slice(0, 157) + '...' };
  return value;
}
