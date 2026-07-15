/**
 * 飞鸽传书 (Pigeon Mail)
 * SillyTavern / TavernHelper 单文件脚本
 *
 * 设计约束：
 * - 完整好友与聊天数据按 SillyTavern chatId 隔离保存。
 * - 世界书中的 PigeonMail-v1-* 仅是可删除、可重建的提示词投影。
 * - 不读取其他好友的私聊作为当前 NPC 的私聊历史。
 * - 不修改 TavernDB-ACU-* 或其他插件管理的条目。
 */

(() => {
  'use strict';

  const VERSION = '0.1.0';
  const APP_KEY = '__PIGEON_MAIL_V1__';
  const STORAGE_PREFIX = 'pigeon-mail-v1';
  const CHAT_METADATA_FIELD = 'pigeonMailV1';
  const CHAT_METADATA_OWNER_FIELD = 'pigeonMailV1__chatId';
  const ENTRY_PREFIX = 'PigeonMail-v1-';
  const INTERNAL_MARKER = 'PIGEON_MAIL_INTERNAL_GENERATION';
  const ROOT_ID = 'pigeon-mail-v1-root';
  const STYLE_ID = 'pigeon-mail-v1-style';

  const DEFAULT_SETTINGS = {
    worldbookName: '',
    apiMode: 'current',
    proxyPreset: '',
    apiUrl: '',
    apiKey: '',
    apiSource: 'openai',
    model: '',
    temperature: 0.85,
    maxTokens: 1200,
    maxProjectionTokens: 12000,
    projectionDepth: 4,
    projectionOrder: 9100,
    proactiveEnabled: true,
    proactiveEveryTurns: 2,
    proactiveMaxCandidates: 4,
    proactiveGlobalCooldownTurns: 1,
    proactiveFriendCooldownTurns: 3,
    proactiveDelayMinSeconds: 12,
    proactiveDelayMaxSeconds: 45,
    buttonPosition: null,
  };

  const runtime = {
    rootWindow: null,
    document: null,
    settings: null,
    chatId: '',
    chatData: null,
    sessionToken: 0,
    activeFriendId: '',
    view: 'threads',
    searchResults: [],
    searchQuery: '',
    modelList: [],
    modelLoading: false,
    busy: false,
    plannerBusy: false,
    projectionQueue: Promise.resolve(),
    timers: new Set(),
    unsubscribers: [],
    destroyed: false,
    lastAssistantCount: 0,
    lastProactiveEvaluationCount: 0,
  };

  function now() {
    return Date.now();
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function uid(prefix = 'id') {
    const cryptoObj = runtime.rootWindow?.crypto || globalThis.crypto;
    if (cryptoObj?.randomUUID) return `${prefix}_${cryptoObj.randomUUID()}`;
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function asText(value) {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  function escapeHtml(value) {
    return asText(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function truncate(value, length = 120) {
    const text = asText(value).trim();
    return text.length > length ? `${text.slice(0, length)}…` : text;
  }

  function estimateTokens(text) {
    const value = asText(text);
    const cjk = (value.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    const rest = Math.max(0, value.length - cjk);
    return Math.ceil(cjk * 1.05 + rest / 4);
  }

  function hashText(text) {
    let hash = 2166136261;
    const value = asText(text);
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function notify(message, type = 'info') {
    const toast = runtime.rootWindow?.toastr || globalThis.toastr;
    if (toast && typeof toast[type] === 'function') {
      toast[type](message, '飞鸽传书');
      return;
    }
    console[type === 'error' ? 'error' : 'log'](`[飞鸽传书] ${message}`);
  }

  function log(...args) {
    console.log('[飞鸽传书]', ...args);
  }

  function warn(...args) {
    console.warn('[飞鸽传书]', ...args);
  }

  function storage() {
    return runtime.rootWindow?.localStorage || globalThis.localStorage;
  }

  function readJson(key, fallback) {
    try {
      const raw = storage()?.getItem(key);
      return raw ? JSON.parse(raw) : clone(fallback);
    } catch (error) {
      warn('读取存储失败', key, error);
      return clone(fallback);
    }
  }

  function writeJson(key, value) {
    storage()?.setItem(key, JSON.stringify(value));
  }

  function settingsKey() {
    return `${STORAGE_PREFIX}:settings`;
  }

  function chatStorageKey(chatId = runtime.chatId) {
    return `${STORAGE_PREFIX}:chat:${chatId || '__no_chat__'}`;
  }

  function createEmptyChatData() {
    return {
      schemaVersion: 1,
      friends: {},
      threads: {},
      intents: [],
      turnCounter: 0,
      lastEvaluatedAssistantCount: 0,
      createdAt: now(),
      updatedAt: now(),
    };
  }

  function normalizeChatData(value) {
    const loaded = value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : createEmptyChatData();
    return {
      ...createEmptyChatData(),
      ...loaded,
      friends: loaded?.friends && typeof loaded.friends === 'object' ? loaded.friends : {},
      threads: loaded?.threads && typeof loaded.threads === 'object' ? loaded.threads : {},
      intents: Array.isArray(loaded?.intents) ? loaded.intents : [],
    };
  }

  function loadSettings() {
    runtime.settings = {
      ...clone(DEFAULT_SETTINGS),
      ...readJson(settingsKey(), DEFAULT_SETTINGS),
    };
  }

  function saveSettings() {
    writeJson(settingsKey(), runtime.settings);
  }

  function getChatMetadata() {
    const context = getContext();
    const metadata = context?.chatMetadata || context?.chat_metadata;
    return metadata && typeof metadata === 'object' ? metadata : null;
  }

  function readChatMetadataData() {
    const metadata = getChatMetadata();
    if (!metadata || !runtime.chatId) return null;
    const owner = asText(metadata[CHAT_METADATA_OWNER_FIELD]).trim();
    // CHAT_CHANGED 触发时，SillyTavern 的 chatMetadata 可能仍短暂指向旧聊天。
    if (owner && owner !== runtime.chatId) return null;
    let value = metadata[CHAT_METADATA_FIELD];
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return null; }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function writeChatMetadataData(value) {
    if (!runtime.chatId) return;
    const context = getContext();
    const metadata = getChatMetadata();
    const snapshot = clone(value);
    if (metadata) {
      metadata[CHAT_METADATA_FIELD] = snapshot;
      metadata[CHAT_METADATA_OWNER_FIELD] = runtime.chatId;
    }
    const updater = context?.updateChatMetadata;
    if (typeof updater !== 'function') return;
    try {
      const result = updater.call(context, {
        [CHAT_METADATA_FIELD]: snapshot,
        [CHAT_METADATA_OWNER_FIELD]: runtime.chatId,
      }, false);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => warn('写入聊天元数据失败；本地备份仍然有效。', error));
      }
    } catch (error) {
      warn('写入聊天元数据失败；本地备份仍然有效。', error);
    }
  }

  function loadChatData() {
    // 聊天元数据可随聊天导出迁移，localStorage 只作竞争条件与旧版本的回退。
    const loaded = readChatMetadataData()
      || readJson(chatStorageKey(), createEmptyChatData());
    runtime.chatData = normalizeChatData(loaded);
    writeJson(chatStorageKey(), runtime.chatData);
  }

  function saveChatData() {
    if (!runtime.chatData) return;
    runtime.chatData.updatedAt = now();
    writeJson(chatStorageKey(), runtime.chatData);
    writeChatMetadataData(runtime.chatData);
  }

  function getHost() {
    const rootWindow = window.parent && window.parent !== window ? window.parent : window;
    const helper = window.TavernHelper || rootWindow.TavernHelper;
    const silly = window.SillyTavern || rootWindow.SillyTavern;
    return { rootWindow, helper, silly };
  }

  function getContext() {
    const { silly } = getHost();
    try {
      return silly?.getContext?.() || silly || null;
    } catch {
      return silly || null;
    }
  }

  function getCurrentChatId() {
    const { silly } = getHost();
    const context = getContext();
    try {
      return asText(
        silly?.getCurrentChatId?.()
        || context?.chatId
        || context?.chatId
        || context?.chatMetadata?.chat_id
        || context?.chat_metadata?.chat_id
        || '',
      ).trim();
    } catch {
      return '';
    }
  }

  function getMainChatMessages() {
    const context = getContext();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    return chat.map((message, index) => ({
      id: index,
      role: message?.is_user ? 'user' : 'assistant',
      name: asText(message?.name || (message?.is_user ? context?.name1 : context?.name2)),
      content: asText(message?.mes ?? message?.content ?? ''),
    })).filter((message) => message.content.trim());
  }

  function getAssistantCount() {
    return getMainChatMessages().filter((message) => message.role === 'assistant').length;
  }

  function getUserName() {
    const context = getContext();
    return asText(context?.name1 || context?.userName || '{{user}}').trim() || '{{user}}';
  }

  function getHelperFunction(...names) {
    const { helper } = getHost();
    for (const name of names) {
      if (typeof helper?.[name] === 'function') return helper[name].bind(helper);
      if (typeof window?.[name] === 'function') return window[name].bind(window);
      if (typeof runtime.rootWindow?.[name] === 'function') return runtime.rootWindow[name].bind(runtime.rootWindow);
    }
    return null;
  }

  async function listWorldbooks() {
    const fn = getHelperFunction('getWorldbookNames', 'getLorebooks');
    if (fn) {
      const result = await fn();
      return Array.isArray(result) ? result.map(asText).filter(Boolean) : [];
    }
    const context = getContext();
    if (typeof context?.getWorldBooks === 'function') {
      const result = await context.getWorldBooks();
      return Array.isArray(result) ? result : [];
    }
    throw new Error('找不到世界书列表接口，请升级或检查酒馆助手。');
  }

  async function getWorldbook(name) {
    if (!name) return [];
    const fn = getHelperFunction('getWorldbook', 'getLorebookEntries');
    if (!fn) throw new Error('找不到世界书读取接口。');
    const result = await fn(name);
    return Array.isArray(result) ? result : [];
  }

  async function updateWorldbook(name, updater) {
    const modern = getHelperFunction('updateWorldbookWith');
    if (modern) return modern(name, updater, { render: 'debounced' });

    const getEntries = getHelperFunction('getLorebookEntries');
    const setEntries = getHelperFunction('setLorebookEntries');
    const createEntries = getHelperFunction('createLorebookEntries');
    const deleteEntries = getHelperFunction('deleteLorebookEntries');
    if (!getEntries || !setEntries || !createEntries || !deleteEntries) {
      throw new Error('当前酒馆助手缺少世界书更新接口。');
    }

    const toLegacyEntry = (entry) => {
      if (!entry?.strategy || !entry?.position || typeof entry.position !== 'object') return entry;
      const strategyType = entry.strategy.type;
      const positionType = entry.position.type;
      const legacyPosition = positionType === 'at_depth' ? 4
        : positionType === 'before_character_definition' ? 0
          : positionType === 'after_character_definition' ? 1
            : positionType === 'before_example_messages' ? 2
              : positionType === 'after_example_messages' ? 3
                : 4;
      const legacyRole = entry.position.role === 'user' ? 1 : entry.position.role === 'assistant' ? 2 : 0;
      return {
        ...entry,
        comment: entry.name,
        key: entry.strategy.keys || [],
        keys: entry.strategy.keys || [],
        keysecondary: entry.strategy.keys_secondary?.keys || [],
        selectiveLogic: entry.strategy.keys_secondary?.logic || 'and_any',
        constant: strategyType === 'constant',
        selective: strategyType !== 'constant',
        vectorized: strategyType === 'vectorized',
        type: strategyType === 'constant' ? 'constant' : 'keyword',
        position: legacyPosition,
        depth: entry.position.depth || 4,
        role: legacyRole,
        order: entry.position.order || runtime.settings.projectionOrder,
        preventRecursion: entry.recursion?.prevent_outgoing === true,
        excludeRecursion: entry.recursion?.prevent_incoming === true,
        delayUntilRecursion: entry.recursion?.delay_until ?? 0,
        probability: entry.probability ?? 100,
        useProbability: true,
        disable: entry.enabled === false,
      };
    };

    const before = await getEntries(name);
    const after = await updater(clone(before));
    const beforeMap = new Map(before.map((entry) => [entry.uid, entry]));
    const afterMap = new Map(after.filter((entry) => entry.uid !== undefined).map((entry) => [entry.uid, entry]));
    const removed = before.filter((entry) => !afterMap.has(entry.uid)).map((entry) => entry.uid);
    const updated = after.filter((entry) => entry.uid !== undefined && beforeMap.has(entry.uid));
    const created = after.filter((entry) => entry.uid === undefined || entry.uid === null);
    if (removed.length) await deleteEntries(name, removed);
    if (updated.length) await setEntries(name, updated.map(toLegacyEntry));
    if (created.length) await createEntries(name, created.map(toLegacyEntry));
    return after;
  }

  function entryName(entry) {
    return asText(entry?.name || entry?.comment || '').trim();
  }

  function entryKeys(entry) {
    const modern = entry?.strategy?.keys;
    const legacy = entry?.keys || entry?.key;
    const keys = Array.isArray(modern) ? modern : Array.isArray(legacy) ? legacy : legacy ? [legacy] : [];
    return keys.map((key) => asText(key)).filter(Boolean);
  }

  function entrySecondaryKeys(entry) {
    const modern = entry?.strategy?.keys_secondary?.keys;
    const legacy = entry?.keysecondary;
    const keys = Array.isArray(modern) ? modern : Array.isArray(legacy) ? legacy : legacy ? [legacy] : [];
    return keys.map((key) => asText(key)).filter(Boolean);
  }

  function entryContent(entry) {
    return asText(entry?.content || '');
  }

  function isPigeonEntry(entry) {
    return entryName(entry).startsWith(ENTRY_PREFIX)
      || entry?.extra?.pigeonMail?.plugin === 'pigeon-mail';
  }

  function isDatabaseEntry(entry) {
    return entryName(entry).startsWith('TavernDB-ACU-');
  }

  function friendList() {
    return Object.values(runtime.chatData?.friends || {}).sort((a, b) => {
      const at = Number(a.lastMessageAt || a.addedAt || 0);
      const bt = Number(b.lastMessageAt || b.addedAt || 0);
      return bt - at;
    });
  }

  function getFriend(friendId) {
    return runtime.chatData?.friends?.[friendId] || null;
  }

  function getThread(friendId) {
    if (!runtime.chatData.threads[friendId]) {
      runtime.chatData.threads[friendId] = { friendId, messages: [] };
    }
    return runtime.chatData.threads[friendId];
  }

  function normalizeProfileEntry(entry) {
    return {
      uid: entry?.uid,
      name: entryName(entry),
      keys: entryKeys(entry),
      secondaryKeys: entrySecondaryKeys(entry),
      content: entryContent(entry),
      fingerprint: hashText(`${entryName(entry)}\n${entryKeys(entry).join('|')}\n${entryContent(entry)}`),
    };
  }

  function buildProjectionContent(friend) {
    const thread = getThread(friend.id);
    const userName = getUserName();
    const lines = [
      `<玩家与${friend.name}的即时私人通信记录>`,
      '',
      `说明：以下内容是${userName}与${friend.name}通过“飞鸽传书”产生的独立即时通信。`,
      '这些通信真实发生于当前聊天存档中，不是当前面对面场景的对话。',
      '其中确认的事实、双方约定、关系变化和已经交换的信息，应被视为相应角色的记忆。',
      '',
    ];
    for (const message of thread.messages) {
      if (message.status === 'failed') continue;
      const speaker = message.role === 'user' ? userName : friend.name;
      lines.push(`${speaker}：${message.content}`);
      lines.push('');
    }
    lines.push(`</玩家与${friend.name}的即时私人通信记录>`);
    return lines.join('\n').trim();
  }

  function buildProjectionEntry(friend) {
    const keys = [...new Set([friend.name, ...(friend.aliases || [])].map((item) => asText(item).trim()).filter(Boolean))];
    const name = `${ENTRY_PREFIX}Chat-${friend.id}`;
    const content = buildProjectionContent(friend);
    return {
      name,
      enabled: true,
      strategy: {
        type: 'selective',
        keys,
        keys_secondary: {
          logic: 'not_any',
          keys: [INTERNAL_MARKER],
        },
        scan_depth: 'same_as_global',
      },
      position: {
        type: 'at_depth',
        role: 'system',
        depth: Number(runtime.settings.projectionDepth) || 4,
        order: Number(runtime.settings.projectionOrder) || 9100,
      },
      content,
      probability: 100,
      recursion: {
        prevent_incoming: false,
        prevent_outgoing: true,
        delay_until: null,
      },
      effect: { sticky: null, cooldown: null, delay: null },
      extra: {
        pigeonMail: {
          plugin: 'pigeon-mail',
          schemaVersion: 1,
          chatId: runtime.chatId,
          friendId: friend.id,
          projectionTokens: estimateTokens(content),
        },
      },
    };
  }

  function queueProjection(task) {
    runtime.projectionQueue = runtime.projectionQueue
      .catch(() => undefined)
      .then(task)
      .catch((error) => {
        warn('世界书投影失败', error);
        notify(`世界书投影失败：${error.message || error}`, 'error');
      });
    return runtime.projectionQueue;
  }

  async function rebuildAllProjections() {
    const bookName = runtime.settings.worldbookName;
    if (!bookName) return;
    const sessionToken = runtime.sessionToken;
    await queueProjection(async () => {
      if (runtime.destroyed || sessionToken !== runtime.sessionToken) return;
      const projections = friendList()
        .filter((friend) => getThread(friend.id).messages.some((message) => message.status !== 'failed'))
        .map(buildProjectionEntry);
      await updateWorldbook(bookName, (entries) => [
        ...entries.filter((entry) => !isPigeonEntry(entry)),
        ...projections,
      ]);
    });
  }

  async function updateFriendProjection(friendId) {
    const bookName = runtime.settings.worldbookName;
    const friend = getFriend(friendId);
    if (!bookName || !friend) return;
    const projection = buildProjectionEntry(friend);
    if (projection.extra.pigeonMail.projectionTokens > Number(runtime.settings.maxProjectionTokens || 12000)) {
      friend.projectionWarning = `聊天投影约 ${projection.extra.pigeonMail.projectionTokens} tokens，超过设置上限。`;
      saveChatData();
    } else {
      friend.projectionWarning = '';
    }
    await queueProjection(async () => {
      await updateWorldbook(bookName, (entries) => {
        const filtered = entries.filter((entry) => {
          if (!isPigeonEntry(entry)) return true;
          return entry?.extra?.pigeonMail?.friendId !== friendId && entryName(entry) !== projection.name;
        });
        return [...filtered, projection];
      });
    });
  }

  async function clearPigeonProjections(bookName = runtime.settings.worldbookName) {
    if (!bookName) return;
    await queueProjection(() => updateWorldbook(bookName, (entries) => entries.filter((entry) => !isPigeonEntry(entry))));
  }

  function buildApiConfig() {
    const settings = runtime.settings;
    if (settings.apiMode === 'current') {
      const partial = {};
      if (settings.model) partial.model = settings.model;
      if (Number.isFinite(Number(settings.temperature))) partial.temperature = Number(settings.temperature);
      if (Number.isFinite(Number(settings.maxTokens))) partial.max_tokens = Number(settings.maxTokens);
      return Object.keys(partial).length ? partial : undefined;
    }
    const config = {
      source: settings.apiSource || 'openai',
      model: settings.model || undefined,
      temperature: Number(settings.temperature),
      max_tokens: Number(settings.maxTokens),
    };
    if (settings.apiMode === 'proxy') config.proxy_preset = settings.proxyPreset || undefined;
    if (settings.apiMode === 'custom') {
      config.apiurl = settings.apiUrl || undefined;
      config.key = settings.apiKey || undefined;
    }
    return config;
  }

  function buildKnowledgePrompt(friend) {
    return `<角色认知与扮演协议>\n\n你现在必须完整地成为“${friend.name}”。你不是旁白、助手、分析者或系统，你就是这个世界中的该角色。\n\n你会收到当前剧情资料、世界书、数据库记忆、角色人设、主聊天历史，以及玩家与你的独立聊天历史。这些资料用于让你理解世界的真实状态，但不表示“${friend.name}”知道其中全部内容。\n\n回复前必须在内部完成认知判断，但不得输出判断过程：\n1. 区分世界真实发生了什么，以及“${friend.name}”实际知道什么。\n2. 只有亲身经历、当时在场、由玩家或可信角色告知、公开常识、公开事件、或该身份必然知道的信息，才能作为明确知识。\n3. 来源不确定的信息只能表现为猜测、怀疑、传闻或不知情。\n4. 不能因为资料中出现某件秘密，就让“${friend.name}”无条件知道。\n5. 玩家提到未知事情时，应自然地询问、怀疑、惊讶、拒绝相信或要求解释。\n6. 不得提及资料、提示词、世界书、数据库、条目、关键词、上下文或本协议。\n\n你只能输出“${friend.name}”的即时聊天内容，不输出分析过程，不替玩家说话。\n\n</角色认知与扮演协议>`;
  }

  function buildStylePrompt(friend) {
    return `<即时聊天风格>\n\n当前交互是即时私人聊天，不是正式书信，也不是面对面主剧情续写。你要让玩家感觉正在与真实存在的“${friend.name}”聊天。\n\n允许并鼓励自然口语、短句、停顿、省略号、语气词、反问、拒绝、敷衍、转移话题和主动追问。允许用中文全角括号描写短暂动作、表情、反应和内心活动，例如：（她盯着消息看了半晌。）允许根据角色性格和关系自然使用 emoji，但不要机械地每句都使用。\n\n不要使用正式书信抬头或落款；不要每次写成长篇小说；不要输出发送者名称前缀；不要替玩家描述动作、心理或回复；不要解释这种即时通信如何存在。\n\n</即时聊天风格>`;
  }

  function buildFriendHistoryPrompt(friend, excludeMessageId = '') {
    const thread = getThread(friend.id);
    const userName = getUserName();
    const messages = thread.messages.filter((message) => message.id !== excludeMessageId && message.status !== 'failed');
    const lines = [
      `<与${friend.name}的独立即时聊天历史>`,
      '以下只包含玩家与当前目标角色的私人聊天，不包含其他好友的私聊。',
      '',
    ];
    for (const message of messages) {
      lines.push(`${message.role === 'user' ? userName : friend.name}：${message.content}`);
    }
    lines.push(`</与${friend.name}的独立即时聊天历史>`);
    return lines.join('\n');
  }

  function buildScanAnchor(friend) {
    const values = [...new Set([friend.name, ...(friend.aliases || []), ...(friend.profile?.keys || [])])]
      .map((item) => asText(item).trim())
      .filter(Boolean)
      .slice(0, 20);
    return `${INTERNAL_MARKER}\n当前目标角色：${friend.name}\n角色关联关键词：${values.join('、')}`;
  }

  function makeInjection(content, depth, shouldScan = false) {
    return {
      role: 'system',
      content,
      position: 'in_chat',
      depth,
      should_scan: shouldScan,
    };
  }

  async function callGenerate(config) {
    const generate = getHelperFunction('generate');
    if (!generate) throw new Error('找不到 TavernHelper.generate，请检查酒馆助手版本。');
    const result = await generate(config);
    if (typeof result === 'string') return result.trim();
    if (typeof result?.content === 'string') return result.content.trim();
    return asText(result).trim();
  }

  async function callGenerateRaw(messages, options = {}) {
    const generateRaw = getHelperFunction('generateRaw');
    if (!generateRaw) {
      return callGenerate({
        user_input: messages.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join('\n\n'),
        should_silence: true,
        custom_api: buildApiConfig(),
        overrides: {
          char_description: '你是一个只输出严格 JSON 的内部调度器。',
          char_personality: '',
          dialogue_examples: '',
          chat_history: { prompts: [] },
        },
      });
    }
    const result = await generateRaw({
      ordered_prompts: messages,
      should_silence: true,
      should_stream: false,
      custom_api: buildApiConfig(),
      ...options,
    });
    if (typeof result === 'string') return result.trim();
    return asText(result?.content ?? result).trim();
  }

  function parseJsonObject(text) {
    const raw = asText(text).trim();
    const fenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    try { return JSON.parse(fenced); } catch { /* continue */ }
    const start = fenced.indexOf('{');
    const end = fenced.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(fenced.slice(start, end + 1)); } catch { /* continue */ }
    }
    throw new Error('AI 没有返回可解析的 JSON。');
  }

  async function generateFriendReply(friend, userMessage) {
    const messageId = userMessage?.id || '';
    const injects = [
      makeInjection(buildKnowledgePrompt(friend), 4, false),
      makeInjection(buildScanAnchor(friend), 3, true),
      makeInjection(buildFriendHistoryPrompt(friend, messageId), 2, false),
      makeInjection(buildStylePrompt(friend), 1, false),
    ];
    const config = {
      preset_name: 'in_use',
      generation_id: uid(`pigeon_${friend.id}`),
      user_input: userMessage.content,
      should_stream: false,
      should_silence: true,
      custom_api: buildApiConfig(),
      overrides: {
        char_description: friend.profile?.content || friend.name,
        char_personality: friend.profile?.content || friend.name,
        dialogue_examples: '',
      },
      injects,
    };
    return callGenerate(config);
  }

  async function generateProactiveMessage(friend, intent) {
    const prompt = `<主动联系任务>\n\n“${friend.name}”此刻产生了主动联系玩家的动机。\n\n联系动机：${intent.intent}\n触发原因：${intent.triggerContext || intent.reason || '当前剧情与双方关系使这次联系变得合理。'}\n\n请先依据角色认知协议判断此动机是否仍符合人物性格、角色是否合理知道相关信息、当前时机是否适合联系。如果合理，直接以角色身份发送第一条即时消息。不要解释系统要求，不要假装正在回复玩家刚说过的话，不要替玩家回应。\n\n</主动联系任务>`;
    const injects = [
      makeInjection(buildKnowledgePrompt(friend), 5, false),
      makeInjection(buildScanAnchor(friend), 4, true),
      makeInjection(buildFriendHistoryPrompt(friend), 3, false),
      makeInjection(prompt, 2, false),
      makeInjection(buildStylePrompt(friend), 1, false),
    ];
    return callGenerate({
      preset_name: 'in_use',
      generation_id: uid(`pigeon_proactive_${friend.id}`),
      user_input: '现在由你主动开启这次私人聊天。',
      should_stream: false,
      should_silence: true,
      custom_api: buildApiConfig(),
      overrides: {
        char_description: friend.profile?.content || friend.name,
        char_personality: friend.profile?.content || friend.name,
        dialogue_examples: '',
      },
      injects,
    });
  }

  async function sendFriendMessage(friendId, content) {
    const friend = getFriend(friendId);
    const text = asText(content).trim();
    if (!friend || !text || runtime.busy) return;
    const sessionToken = runtime.sessionToken;
    const thread = getThread(friendId);
    const userMessage = {
      id: uid('msg'),
      role: 'user',
      content: text,
      createdAt: now(),
      status: 'sending',
    };
    thread.messages.push(userMessage);
    friend.lastMessageAt = userMessage.createdAt;
    runtime.busy = true;
    saveChatData();
    render();
    try {
      const reply = await generateFriendReply(friend, userMessage);
      if (sessionToken !== runtime.sessionToken) return;
      if (!reply) throw new Error('模型返回了空回复。');
      userMessage.status = 'sent';
      thread.messages.push({
        id: uid('msg'),
        role: 'assistant',
        content: reply,
        createdAt: now(),
        status: 'received',
        proactive: false,
      });
      friend.lastMessageAt = now();
      friend.unreadCount = 0;
      saveChatData();
      await updateFriendProjection(friendId);
    } catch (error) {
      userMessage.status = 'failed';
      userMessage.error = asText(error?.message || error);
      saveChatData();
      notify(`发送失败：${userMessage.error}`, 'error');
    } finally {
      if (sessionToken === runtime.sessionToken) {
        runtime.busy = false;
        render();
      }
    }
  }

  function getLatestMainContext(maxMessages = 6) {
    return getMainChatMessages().slice(-maxMessages).map((message) => ({
      role: message.role,
      content: truncate(message.content, 1800),
    }));
  }

  function friendMentioned(friend, text) {
    const haystack = asText(text);
    return [friend.name, ...(friend.aliases || []), ...(friend.profile?.keys || [])]
      .map((item) => asText(item).trim())
      .filter((item) => item.length >= 2)
      .some((item) => haystack.includes(item));
  }

  function selectProactiveCandidates(assistantCount) {
    const settings = runtime.settings;
    const latestContext = getLatestMainContext(4);
    const latestText = latestContext.map((message) => message.content).join('\n');
    const socialTick = assistantCount - Number(runtime.chatData.lastEvaluatedAssistantCount || 0)
      >= Number(settings.proactiveEveryTurns || 2);
    const candidates = [];
    for (const friend of friendList()) {
      if (friend.muted || Number(friend.unreadCount || 0) > 0) continue;
      if (runtime.chatData.intents.some((intent) => intent.friendId === friend.id && ['queued', 'generating'].includes(intent.status))) continue;
      const sinceFriendProactive = assistantCount - Number(friend.lastProactiveTurn ?? -9999);
      if (sinceFriendProactive < Number(settings.proactiveFriendCooldownTurns || 3)) continue;
      let score = 0;
      const mentioned = friendMentioned(friend, latestText);
      if (mentioned) score += 60;
      if (socialTick && getThread(friend.id).messages.length > 0) score += 18;
      if (friend.lastMessageAt && now() - friend.lastMessageAt > 30 * 60 * 1000) score += 8;
      if (score >= 18) {
        candidates.push({ friend, score, mentioned });
      }
    }
    return candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, Number(settings.proactiveMaxCandidates || 4));
  }

  async function evaluateProactiveMessages(reason = 'story_turn') {
    if (!runtime.settings.proactiveEnabled || runtime.plannerBusy || runtime.busy || runtime.destroyed) return;
    const assistantCount = getAssistantCount();
    if (reason === 'story_turn' && assistantCount <= Number(runtime.chatData.lastEvaluatedAssistantCount || 0)) return;
    const globalCooldown = Number(runtime.settings.proactiveGlobalCooldownTurns || 1);
    if (assistantCount - Number(runtime.chatData.lastProactiveTurn ?? -9999) < globalCooldown) return;
    const candidates = selectProactiveCandidates(assistantCount);
    runtime.chatData.lastEvaluatedAssistantCount = assistantCount;
    saveChatData();
    if (!candidates.length) return;

    runtime.plannerBusy = true;
    const sessionToken = runtime.sessionToken;
    try {
      const candidatePayload = candidates.map(({ friend, score, mentioned }) => ({
        friendId: friend.id,
        name: friend.name,
        aliases: friend.aliases || [],
        heuristicScore: score,
        mentionedInLatestStory: mentioned,
        profile: truncate(friend.profile?.content, 900),
        lastPrivateMessages: getThread(friend.id).messages.slice(-4).map((message) => ({
          role: message.role,
          content: truncate(message.content, 500),
        })),
        lastProactiveTurn: friend.lastProactiveTurn ?? null,
      }));
      const system = `你是“飞鸽传书”的主动联系调度器，不扮演任何角色。根据最新主剧情和候选好友资料，判断是否有且最多一名角色此刻有充分理由主动联系玩家。宁缺毋滥，普通情况下返回空 decisions。不得把一个好友的私人聊天当成另一个好友知道的事实。只返回严格 JSON：{"decisions":[{"friendId":"...","shouldSend":true,"intent":"角色主动联系的具体动机","triggerContext":"触发依据","urgency":"low|normal|high","delaySeconds":整数,"expiresAfterTurns":整数}]}。若无人应联系，返回 {"decisions":[]}。`;
      const user = JSON.stringify({
        reason,
        assistantTurn: assistantCount,
        latestMainStory: getLatestMainContext(6),
        candidates: candidatePayload,
      });
      const raw = await callGenerateRaw([
        { role: 'system', content: system },
        { role: 'user', content: user },
      ]);
      if (sessionToken !== runtime.sessionToken) return;
      const parsed = parseJsonObject(raw);
      const decisions = Array.isArray(parsed?.decisions) ? parsed.decisions : [];
      const validIds = new Set(candidates.map((candidate) => candidate.friend.id));
      const decision = decisions.find((item) => item?.shouldSend === true && validIds.has(asText(item.friendId)));
      if (!decision) return;
      const minDelay = Number(runtime.settings.proactiveDelayMinSeconds || 12);
      const maxDelay = Number(runtime.settings.proactiveDelayMaxSeconds || 45);
      const delaySeconds = clamp(Number(decision.delaySeconds || minDelay), minDelay, maxDelay);
      runtime.chatData.intents.push({
        id: uid('intent'),
        friendId: decision.friendId,
        triggerType: reason,
        intent: asText(decision.intent).trim(),
        triggerContext: asText(decision.triggerContext).trim(),
        urgency: asText(decision.urgency || 'normal'),
        createdAt: now(),
        createdAtTurn: assistantCount,
        earliestDeliveryAt: now() + delaySeconds * 1000,
        expiresAtTurn: assistantCount + clamp(Number(decision.expiresAfterTurns || 2), 1, 6),
        sourceChatId: runtime.chatId,
        sourceContextHash: hashText(JSON.stringify(getLatestMainContext(4))),
        status: 'queued',
      });
      saveChatData();
      render();
    } catch (error) {
      warn('主动消息调度失败', error);
    } finally {
      runtime.plannerBusy = false;
    }
  }

  async function processIntentQueue() {
    if (runtime.destroyed || runtime.busy || runtime.plannerBusy || !runtime.chatData) return;
    const assistantCount = getAssistantCount();
    const intent = runtime.chatData.intents.find((item) => item.status === 'queued' && Number(item.earliestDeliveryAt) <= now());
    if (!intent) return;
    if (intent.sourceChatId !== runtime.chatId || assistantCount > Number(intent.expiresAtTurn || assistantCount)) {
      intent.status = 'cancelled';
      saveChatData();
      return;
    }
    const friend = getFriend(intent.friendId);
    if (!friend || friend.muted || Number(friend.unreadCount || 0) > 0) {
      intent.status = 'cancelled';
      saveChatData();
      return;
    }
    const sessionToken = runtime.sessionToken;
    intent.status = 'generating';
    runtime.busy = true;
    saveChatData();
    render();
    try {
      const message = await generateProactiveMessage(friend, intent);
      if (sessionToken !== runtime.sessionToken) return;
      if (!message) throw new Error('主动消息生成结果为空。');
      getThread(friend.id).messages.push({
        id: uid('msg'),
        role: 'assistant',
        content: message,
        createdAt: now(),
        status: 'received',
        proactive: true,
        intentId: intent.id,
      });
      intent.status = 'delivered';
      intent.deliveredAt = now();
      friend.lastMessageAt = now();
      friend.lastProactiveTurn = assistantCount;
      friend.unreadCount = runtime.activeFriendId === friend.id ? 0 : Number(friend.unreadCount || 0) + 1;
      runtime.chatData.lastProactiveTurn = assistantCount;
      saveChatData();
      await updateFriendProjection(friend.id);
      if (runtime.activeFriendId !== friend.id) notify(`${friend.name} 发来了一条消息。`, 'info');
    } catch (error) {
      intent.status = 'failed';
      intent.error = asText(error?.message || error);
      warn('主动消息生成失败', error);
      saveChatData();
    } finally {
      if (sessionToken === runtime.sessionToken) {
        runtime.busy = false;
        render();
      }
    }
  }

  function schedule(callback, delay) {
    const timer = runtime.rootWindow.setTimeout(() => {
      runtime.timers.delete(timer);
      callback();
    }, delay);
    runtime.timers.add(timer);
    return timer;
  }

  function setRepeating(callback, delay) {
    const timer = runtime.rootWindow.setInterval(callback, delay);
    runtime.timers.add(timer);
    return timer;
  }

  async function handleChatChanged(chatId) {
    const nextId = asText(chatId || getCurrentChatId()).trim();
    if (!nextId || nextId === runtime.chatId) return;
    const oldBook = runtime.settings.worldbookName;
    runtime.sessionToken += 1;
    runtime.busy = false;
    runtime.plannerBusy = false;
    runtime.activeFriendId = '';
    runtime.view = 'threads';
    try { await clearPigeonProjections(oldBook); } catch (error) { warn(error); }
    runtime.chatId = nextId;
    loadChatData();
    runtime.lastAssistantCount = getAssistantCount();
    render();
    await rebuildAllProjections();
    // 再读一次，处理 CHAT_CHANGED 事件早于 chatMetadata 切换完成的情况。
    const expectedSession = runtime.sessionToken;
    schedule(async () => {
      if (expectedSession !== runtime.sessionToken) return;
      const metadataData = readChatMetadataData();
      if (!metadataData) return;
      const metadataUpdatedAt = Number(metadataData.updatedAt || 0);
      const currentUpdatedAt = Number(runtime.chatData?.updatedAt || 0);
      if (metadataUpdatedAt < currentUpdatedAt) return;
      runtime.chatData = normalizeChatData(metadataData);
      writeJson(chatStorageKey(), runtime.chatData);
      render();
      await rebuildAllProjections();
    }, 800);
  }

  function subscribeEvents() {
    const eventOnFn = getHelperFunction('eventOn');
    const events = window.tavern_events || runtime.rootWindow.tavern_events;
    if (!eventOnFn || !events) {
      warn('事件接口不可用，将使用低频本地检查。');
      setRepeating(() => {
        const current = getCurrentChatId();
        if (current && current !== runtime.chatId) handleChatChanged(current);
        const count = getAssistantCount();
        if (count > runtime.lastAssistantCount) {
          runtime.lastAssistantCount = count;
          schedule(() => evaluateProactiveMessages('story_turn'), 1800);
        }
      }, 3000);
      return;
    }
    if (events.CHAT_CHANGED) {
      const off = eventOnFn(events.CHAT_CHANGED, (chatId) => handleChatChanged(chatId));
      if (typeof off === 'function') runtime.unsubscribers.push(off);
    }
    if (events.MESSAGE_RECEIVED) {
      const off = eventOnFn(events.MESSAGE_RECEIVED, () => {
        runtime.lastAssistantCount = getAssistantCount();
        schedule(() => evaluateProactiveMessages('story_turn'), 2200);
      });
      if (typeof off === 'function') runtime.unsubscribers.push(off);
    }
  }

  function injectStyles() {
    const doc = runtime.document;
    doc.getElementById(STYLE_ID)?.remove();
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
#${ROOT_ID}{--pm-paper:#f4ead2;--pm-paper2:#e8d4ad;--pm-ink:#39291c;--pm-red:#8f2e28;--pm-gold:#b3884e;--pm-shadow:rgba(29,20,13,.36);font-family:"Microsoft YaHei","Noto Sans SC",sans-serif;color:var(--pm-ink)}
#${ROOT_ID} *{box-sizing:border-box}
.pm-fab{position:fixed;right:22px;bottom:96px;width:58px;height:58px;border:1px solid rgba(107,70,35,.45);border-radius:18px;background:linear-gradient(145deg,#f8edcf,#d9b77f);box-shadow:0 8px 28px var(--pm-shadow);z-index:2147483000;display:flex;align-items:center;justify-content:center;cursor:grab;user-select:none;font-size:29px;transition:transform .15s,box-shadow .15s}
.pm-fab:hover{transform:translateY(-2px);box-shadow:0 11px 34px var(--pm-shadow)}.pm-fab:active{cursor:grabbing}.pm-badge{position:absolute;right:-6px;top:-7px;min-width:22px;height:22px;padding:0 6px;border-radius:12px;background:var(--pm-red);color:white;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid #f3e4c4}
.pm-panel{position:fixed;right:24px;bottom:166px;width:min(430px,calc(100vw - 24px));height:min(650px,calc(100vh - 90px));z-index:2147482999;border:1px solid rgba(98,62,30,.55);border-radius:18px;overflow:hidden;background:linear-gradient(180deg,var(--pm-paper),#ead6b1);box-shadow:0 18px 60px var(--pm-shadow);display:flex;flex-direction:column}
.pm-hidden{display:none!important}.pm-header{height:58px;flex:0 0 auto;padding:0 14px;background:linear-gradient(135deg,#6e241f,#9d4035);color:#fff5df;display:flex;align-items:center;justify-content:space-between}.pm-title{font-weight:800;letter-spacing:.12em}.pm-header-actions{display:flex;gap:6px}.pm-icon-btn{border:0;background:rgba(255,255,255,.12);color:inherit;width:34px;height:34px;border-radius:10px;cursor:pointer;font-size:17px}.pm-body{flex:1;min-height:0;overflow:auto;background-image:radial-gradient(rgba(93,61,31,.08) .7px,transparent .7px);background-size:7px 7px}.pm-tabs{height:54px;flex:0 0 auto;border-top:1px solid rgba(91,59,29,.2);display:grid;grid-template-columns:repeat(3,1fr);background:#e5cda4}.pm-tab{border:0;background:transparent;color:#5b412b;cursor:pointer;font-size:14px}.pm-tab.active{color:var(--pm-red);font-weight:800;background:rgba(255,255,255,.28)}
.pm-list{padding:10px}.pm-row{display:flex;gap:11px;align-items:center;padding:11px;border-bottom:1px solid rgba(81,52,27,.14);cursor:pointer;border-radius:12px}.pm-row:hover{background:rgba(255,255,255,.27)}.pm-avatar{width:44px;height:44px;border-radius:14px;background:linear-gradient(145deg,#b3483c,#722720);color:#fff5df;display:flex;align-items:center;justify-content:center;font-weight:800;flex:0 0 auto;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)}.pm-row-main{min-width:0;flex:1}.pm-row-top{display:flex;justify-content:space-between;gap:10px}.pm-name{font-weight:800}.pm-time{font-size:11px;opacity:.62;white-space:nowrap}.pm-preview{font-size:12px;opacity:.72;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px}.pm-empty{padding:42px 24px;text-align:center;opacity:.65;line-height:1.8}
.pm-friends-toolbar,.pm-settings{padding:13px}.pm-search-line{display:grid;grid-template-columns:1fr auto;gap:8px}.pm-input,.pm-select,.pm-textarea{width:100%;border:1px solid rgba(84,53,27,.3);border-radius:10px;background:rgba(255,255,255,.46);color:var(--pm-ink);padding:9px 10px;outline:none}.pm-input:focus,.pm-select:focus,.pm-textarea:focus{border-color:var(--pm-gold);box-shadow:0 0 0 2px rgba(179,136,78,.18)}.pm-btn{border:1px solid rgba(111,66,31,.35);background:linear-gradient(#a64b3e,#7d2d27);color:#fff6df;border-radius:10px;padding:8px 13px;cursor:pointer;font-weight:700}.pm-btn.secondary{background:rgba(255,255,255,.4);color:var(--pm-ink)}.pm-btn:disabled{opacity:.5;cursor:not-allowed}.pm-results{margin-top:10px}.pm-result{padding:11px;border:1px solid rgba(84,53,27,.18);border-radius:12px;background:rgba(255,255,255,.24);margin-bottom:8px}.pm-result-title{font-weight:800}.pm-result-meta{font-size:11px;opacity:.65;margin:4px 0}.pm-result-preview{font-size:12px;line-height:1.55;max-height:78px;overflow:auto;white-space:pre-wrap}.pm-result-actions{text-align:right;margin-top:8px}
.pm-field{margin-bottom:13px}.pm-label{display:block;font-size:12px;font-weight:800;margin-bottom:5px}.pm-help{font-size:11px;opacity:.65;line-height:1.5;margin-top:4px}.pm-grid2{display:grid;grid-template-columns:1fr 1fr;gap:9px}.pm-check{display:flex;align-items:center;gap:8px}.pm-section{border:1px solid rgba(84,53,27,.17);border-radius:13px;padding:11px;margin-bottom:12px;background:rgba(255,255,255,.18)}.pm-section-title{font-weight:800;margin-bottom:10px;color:#71312a}
.pm-chat{height:100%;display:flex;flex-direction:column}.pm-chat-head{height:48px;flex:0 0 auto;display:flex;align-items:center;gap:9px;padding:0 10px;border-bottom:1px solid rgba(84,53,27,.2);background:rgba(255,255,255,.2)}.pm-chat-title{font-weight:800;flex:1}.pm-messages{flex:1;min-height:0;overflow:auto;padding:13px}.pm-message{display:flex;margin:9px 0}.pm-message.user{justify-content:flex-end}.pm-bubble{max-width:82%;padding:9px 11px;border-radius:14px;white-space:pre-wrap;word-break:break-word;line-height:1.58;font-size:14px;box-shadow:0 2px 8px rgba(54,35,18,.11)}.pm-message.assistant .pm-bubble{background:rgba(255,255,255,.57);border-bottom-left-radius:4px}.pm-message.user .pm-bubble{background:#d6b375;border-bottom-right-radius:4px}.pm-message.failed .pm-bubble{border:1px solid #a33;background:#f2c7bd}.pm-message-meta{font-size:10px;opacity:.55;margin-top:4px}.pm-composer{flex:0 0 auto;padding:9px;border-top:1px solid rgba(84,53,27,.2);display:grid;grid-template-columns:1fr auto;gap:8px;background:#e4cba1}.pm-composer textarea{resize:none;min-height:42px;max-height:110px}.pm-typing{padding:6px 13px;font-size:12px;opacity:.65}.pm-warning{padding:8px 10px;background:#f1c794;border:1px solid #c58a46;border-radius:9px;font-size:12px;margin:8px 13px}.pm-dot{width:8px;height:8px;border-radius:50%;background:#3b9a56;display:inline-block;margin-right:5px}.pm-muted{opacity:.55}.pm-intent{font-size:11px;padding:5px 9px;background:rgba(143,46,40,.1);border-radius:8px;margin-top:5px}
@media(max-width:600px){.pm-panel{left:6px;right:6px;bottom:72px;width:auto;height:calc(100vh - 82px);border-radius:15px}.pm-fab{right:13px;bottom:12px}.pm-grid2{grid-template-columns:1fr}.pm-bubble{max-width:90%}}
`;
    doc.head.appendChild(style);
  }

  function formatTime(timestamp) {
    if (!timestamp) return '';
    try {
      return new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function avatarText(name) {
    const value = asText(name).trim();
    return escapeHtml(value.slice(-2) || '友');
  }

  function totalUnread() {
    return friendList().reduce((sum, friend) => sum + Number(friend.unreadCount || 0), 0);
  }

  function renderThreads() {
    const friends = friendList().filter((friend) => getThread(friend.id).messages.length > 0);
    if (!friends.length) return '<div class="pm-empty">尚无通信记录。<br>请先在“好友”中绑定世界书角色。</div>';
    return `<div class="pm-list">${friends.map((friend) => {
      const thread = getThread(friend.id);
      const last = thread.messages.at(-1);
      return `<div class="pm-row" data-action="open-friend" data-id="${escapeHtml(friend.id)}">
        <div class="pm-avatar">${avatarText(friend.name)}</div>
        <div class="pm-row-main"><div class="pm-row-top"><span class="pm-name">${escapeHtml(friend.name)}</span><span class="pm-time">${formatTime(last?.createdAt)}</span></div><div class="pm-preview">${escapeHtml(truncate(last?.content || '尚未开始聊天', 46))}</div>${runtime.chatData.intents.some((i) => i.friendId === friend.id && i.status === 'queued') ? '<div class="pm-intent">有一封主动消息正在酝酿中…</div>' : ''}</div>
        ${friend.unreadCount ? `<span class="pm-badge" style="position:static;border:0">${friend.unreadCount}</span>` : ''}
      </div>`;
    }).join('')}</div>`;
  }

  function renderFriends() {
    const friends = friendList();
    const results = runtime.searchResults;
    return `<div class="pm-friends-toolbar">
      <div class="pm-section">
        <div class="pm-section-title">从绑定世界书添加好友</div>
        <div class="pm-search-line"><input id="pm-search-input" class="pm-input" value="${escapeHtml(runtime.searchQuery)}" placeholder="输入角色名，如：姜泥"><button class="pm-btn" data-action="search-worldbook">搜索</button></div>
        <div class="pm-help">搜索条目名称、主/次关键词与正文，由玩家手动选择人设条目。</div>
        <div class="pm-results">${results.map((item, index) => `<div class="pm-result">
          <div class="pm-result-title">${escapeHtml(item.profile.name || `条目 UID ${item.profile.uid}`)}</div>
          <div class="pm-result-meta">UID: ${escapeHtml(item.profile.uid)} · ${item.sourceType === 'database' ? '数据库记忆条目（可选，但通常不应作为基础人设）' : '原生世界书条目'} · 关键词：${escapeHtml(item.profile.keys.join('、') || '无')}</div>
          <div class="pm-result-preview">${escapeHtml(truncate(item.profile.content, 430))}</div>
          <div class="pm-result-actions"><button class="pm-btn" data-action="add-friend" data-index="${index}">设为“${escapeHtml(runtime.searchQuery || item.suggestedName)}”的人设</button></div>
        </div>`).join('')}</div>
      </div>
      <div class="pm-section"><div class="pm-section-title">好友列表</div>
        ${friends.length ? friends.map((friend) => `<div class="pm-row" data-action="open-friend" data-id="${escapeHtml(friend.id)}"><div class="pm-avatar">${avatarText(friend.name)}</div><div class="pm-row-main"><div class="pm-name">${escapeHtml(friend.name)}</div><div class="pm-preview">${escapeHtml(friend.profile?.name || '已绑定人设')}</div>${friend.projectionWarning ? `<div class="pm-warning" style="margin:6px 0 0">${escapeHtml(friend.projectionWarning)}</div>` : ''}</div><button class="pm-icon-btn" title="${friend.muted ? '取消静音' : '静音'}" data-action="toggle-mute" data-id="${escapeHtml(friend.id)}">${friend.muted ? '🔕' : '🔔'}</button><button class="pm-icon-btn" title="删除好友" data-action="delete-friend" data-id="${escapeHtml(friend.id)}">×</button></div>`).join('') : '<div class="pm-empty">尚未添加好友。</div>'}
      </div>
    </div>`;
  }

  function renderSettings() {
    const s = runtime.settings;
    return `<div class="pm-settings">
      <div class="pm-section"><div class="pm-section-title">世界书</div>
        <div class="pm-field"><label class="pm-label">绑定世界书</label><div class="pm-search-line"><select id="pm-worldbook" class="pm-select"><option value="${escapeHtml(s.worldbookName)}">${escapeHtml(s.worldbookName || '请刷新并选择')}</option></select><button class="pm-btn secondary" data-action="refresh-worldbooks">刷新</button></div></div>
        <button class="pm-btn secondary" data-action="rebuild-projections">重建当前聊天投影</button>
      </div>
      <div class="pm-section"><div class="pm-section-title">AI 接口</div>
        <div class="pm-field"><label class="pm-label">接口模式</label><select id="pm-api-mode" class="pm-select"><option value="current" ${s.apiMode === 'current' ? 'selected' : ''}>跟随当前酒馆接口</option><option value="proxy" ${s.apiMode === 'proxy' ? 'selected' : ''}>酒馆代理预设</option><option value="custom" ${s.apiMode === 'custom' ? 'selected' : ''}>独立 API</option></select></div>
        <div class="pm-field"><label class="pm-label">代理预设名称</label><input id="pm-proxy" class="pm-input" value="${escapeHtml(s.proxyPreset)}"></div>
        <div class="pm-grid2"><div class="pm-field"><label class="pm-label">API 地址</label><input id="pm-api-url" class="pm-input" value="${escapeHtml(s.apiUrl)}"></div><div class="pm-field"><label class="pm-label">API 来源</label><select id="pm-api-source" class="pm-select">${['openai','claude','openrouter','makersuite','vertexai','azure_openai','deepseek','xai','custom'].map((value) => `<option value="${value}" ${s.apiSource === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div></div>
        <div class="pm-field"><label class="pm-label">API 密钥</label><input id="pm-api-key" type="password" class="pm-input" value="${escapeHtml(s.apiKey)}"></div>
        <div class="pm-grid2"><div class="pm-field"><label class="pm-label">模型</label><input id="pm-model" class="pm-input" list="pm-model-list" value="${escapeHtml(s.model)}" placeholder="留空跟随当前模型"><datalist id="pm-model-list">${runtime.modelList.map((model) => `<option value="${escapeHtml(model)}"></option>`).join('')}</datalist><button class="pm-btn secondary" style="margin-top:6px" data-action="refresh-models" ${runtime.modelLoading ? 'disabled' : ''}>${runtime.modelLoading ? '获取中…' : '获取独立 API 模型'}</button></div><div class="pm-field"><label class="pm-label">最大回复 Token</label><input id="pm-max-tokens" type="number" class="pm-input" value="${escapeHtml(s.maxTokens)}"></div></div>
        <div class="pm-field"><label class="pm-label">温度</label><input id="pm-temperature" type="number" min="0" max="2" step="0.05" class="pm-input" value="${escapeHtml(s.temperature)}"></div>
      </div>
      <div class="pm-section"><div class="pm-section-title">主动消息</div>
        <label class="pm-check"><input id="pm-proactive-enabled" type="checkbox" ${s.proactiveEnabled ? 'checked' : ''}>启用剧情与关系驱动的主动联系</label>
        <div class="pm-grid2" style="margin-top:10px"><div class="pm-field"><label class="pm-label">关系检查间隔（正文回合）</label><input id="pm-proactive-turns" type="number" min="1" max="20" class="pm-input" value="${escapeHtml(s.proactiveEveryTurns)}"></div><div class="pm-field"><label class="pm-label">单好友冷却（正文回合）</label><input id="pm-friend-cooldown" type="number" min="1" max="50" class="pm-input" value="${escapeHtml(s.proactiveFriendCooldownTurns)}"></div></div>
        <button class="pm-btn secondary" data-action="test-proactive">立即执行一次主动联系判断</button>
        <div class="pm-help">本地规则先筛选；没有候选好友时不会调用 AI。调度器每次最多选择一名好友。</div>
      </div>
      <div class="pm-section"><div class="pm-section-title">记忆投影</div><div class="pm-field"><label class="pm-label">完整聊天投影警告阈值（Token）</label><input id="pm-projection-limit" type="number" min="1000" step="1000" class="pm-input" value="${escapeHtml(s.maxProjectionTokens)}"></div><div class="pm-help">完整记录不会自动删除；超过阈值只发出警告。</div></div>
      <button class="pm-btn" data-action="save-settings">保存设置</button>
      <div class="pm-help" style="margin-top:10px">飞鸽传书 v${VERSION} · 当前聊天：${escapeHtml(runtime.chatId || '未识别')}</div>
    </div>`;
  }

  function renderChat(friend) {
    const thread = getThread(friend.id);
    return `<div class="pm-chat">
      <div class="pm-chat-head"><button class="pm-icon-btn" data-action="back">‹</button><div class="pm-avatar" style="width:34px;height:34px;border-radius:10px">${avatarText(friend.name)}</div><div class="pm-chat-title">${escapeHtml(friend.name)} ${friend.muted ? '<span class="pm-muted">· 已静音</span>' : ''}</div></div>
      ${friend.projectionWarning ? `<div class="pm-warning">${escapeHtml(friend.projectionWarning)}</div>` : ''}
      <div class="pm-messages" id="pm-messages">${thread.messages.length ? thread.messages.map((message) => `<div class="pm-message ${message.role} ${message.status === 'failed' ? 'failed' : ''}"><div class="pm-bubble">${escapeHtml(message.content)}<div class="pm-message-meta">${message.proactive ? '主动消息 · ' : ''}${formatTime(message.createdAt)}${message.status === 'sending' ? ' · 发送中' : ''}${message.status === 'failed' ? ` · 失败：${escapeHtml(message.error)}` : ''}</div></div></div>`).join('') : '<div class="pm-empty">现在可以开始与这个角色聊天。</div>'}</div>
      ${runtime.busy ? `<div class="pm-typing"><span class="pm-dot"></span>${escapeHtml(friend.name)} 正在输入…</div>` : ''}
      <div class="pm-composer"><textarea id="pm-compose" class="pm-textarea" placeholder="发送即时消息…" ${runtime.busy ? 'disabled' : ''}></textarea><button class="pm-btn" data-action="send-message" ${runtime.busy ? 'disabled' : ''}>发送</button></div>
    </div>`;
  }

  function renderBody() {
    if (runtime.activeFriendId) {
      const friend = getFriend(runtime.activeFriendId);
      if (friend) return renderChat(friend);
      runtime.activeFriendId = '';
    }
    if (runtime.view === 'friends') return renderFriends();
    if (runtime.view === 'settings') return renderSettings();
    return renderThreads();
  }

  function render() {
    if (runtime.destroyed || !runtime.document) return;
    let root = runtime.document.getElementById(ROOT_ID);
    if (!root) {
      root = runtime.document.createElement('div');
      root.id = ROOT_ID;
      runtime.document.body.appendChild(root);
    }
    const wasOpen = root.querySelector('.pm-panel') && !root.querySelector('.pm-panel').classList.contains('pm-hidden');
    root.innerHTML = `<button class="pm-fab" aria-label="飞鸽传书"><span>🕊️</span>${totalUnread() ? `<span class="pm-badge">${totalUnread()}</span>` : ''}</button>
      <section class="pm-panel ${wasOpen ? '' : 'pm-hidden'}">
        <header class="pm-header"><div class="pm-title">飞鸽传书</div><div class="pm-header-actions"><button class="pm-icon-btn" data-action="close-panel">×</button></div></header>
        <main class="pm-body">${renderBody()}</main>
        ${runtime.activeFriendId ? '' : `<nav class="pm-tabs"><button class="pm-tab ${runtime.view === 'threads' ? 'active' : ''}" data-action="tab" data-view="threads">消息</button><button class="pm-tab ${runtime.view === 'friends' ? 'active' : ''}" data-action="tab" data-view="friends">好友</button><button class="pm-tab ${runtime.view === 'settings' ? 'active' : ''}" data-action="tab" data-view="settings">设置</button></nav>`}
      </section>`;
    applyButtonPosition(root.querySelector('.pm-fab'));
    bindUiEvents(root);
    if (runtime.activeFriendId) {
      schedule(() => {
        const messages = runtime.document.getElementById('pm-messages');
        if (messages) messages.scrollTop = messages.scrollHeight;
      }, 0);
    }
  }

  function applyButtonPosition(button) {
    const pos = runtime.settings.buttonPosition;
    if (!button || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
    button.style.left = `${clamp(pos.x, 0, runtime.rootWindow.innerWidth - 58)}px`;
    button.style.top = `${clamp(pos.y, 0, runtime.rootWindow.innerHeight - 58)}px`;
    button.style.right = 'auto';
    button.style.bottom = 'auto';
  }

  function installDrag(button, root) {
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    const onMove = (event) => {
      if (!dragging) return;
      const point = event.touches?.[0] || event;
      const dx = point.clientX - startX;
      const dy = point.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 5) moved = true;
      const x = clamp(originX + dx, 0, runtime.rootWindow.innerWidth - 58);
      const y = clamp(originY + dy, 0, runtime.rootWindow.innerHeight - 58);
      button.style.left = `${x}px`;
      button.style.top = `${y}px`;
      button.style.right = 'auto';
      button.style.bottom = 'auto';
      event.preventDefault?.();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      runtime.document.removeEventListener('mousemove', onMove);
      runtime.document.removeEventListener('mouseup', onUp);
      runtime.document.removeEventListener('touchmove', onMove);
      runtime.document.removeEventListener('touchend', onUp);
      if (moved) {
        const rect = button.getBoundingClientRect();
        runtime.settings.buttonPosition = { x: rect.left, y: rect.top };
        saveSettings();
      } else {
        root.querySelector('.pm-panel')?.classList.toggle('pm-hidden');
      }
    };
    const onDown = (event) => {
      const point = event.touches?.[0] || event;
      const rect = button.getBoundingClientRect();
      dragging = true;
      moved = false;
      startX = point.clientX;
      startY = point.clientY;
      originX = rect.left;
      originY = rect.top;
      runtime.document.addEventListener('mousemove', onMove, { passive: false });
      runtime.document.addEventListener('mouseup', onUp);
      runtime.document.addEventListener('touchmove', onMove, { passive: false });
      runtime.document.addEventListener('touchend', onUp);
    };
    button.addEventListener('mousedown', onDown);
    button.addEventListener('touchstart', onDown, { passive: true });
  }

  async function searchWorldbook() {
    const input = runtime.document.getElementById('pm-search-input');
    const query = asText(input?.value).trim();
    runtime.searchQuery = query;
    if (!query) {
      notify('请输入角色名。', 'warning');
      return;
    }
    if (!runtime.settings.worldbookName) {
      notify('请先在设置中绑定世界书。', 'warning');
      runtime.view = 'settings';
      render();
      return;
    }
    try {
      const entries = await getWorldbook(runtime.settings.worldbookName);
      const lower = query.toLocaleLowerCase();
      runtime.searchResults = entries.filter((entry) => !isPigeonEntry(entry)).map((entry) => {
        const profile = normalizeProfileEntry(entry);
        const name = profile.name.toLocaleLowerCase();
        const keys = profile.keys.map((key) => key.toLocaleLowerCase());
        const secondary = profile.secondaryKeys.map((key) => key.toLocaleLowerCase());
        const content = profile.content.toLocaleLowerCase();
        let score = 0;
        if (keys.includes(lower)) score += 100;
        if (name === lower) score += 90;
        if (name.includes(lower)) score += 70;
        if (keys.some((key) => key.includes(lower))) score += 60;
        if (secondary.some((key) => key.includes(lower))) score += 40;
        if (content.includes(lower)) score += 10;
        const sourceType = isDatabaseEntry(entry) ? 'database' : 'worldbook';
        // 数据库投影反映动态状态，不等价于稳定人物设定；保留给高级用户，但让正式人设优先。
        if (sourceType === 'database') score -= 40;
        return { profile, score, suggestedName: query, sourceType };
      }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 80);
      render();
    } catch (error) {
      notify(`搜索世界书失败：${error.message || error}`, 'error');
    }
  }

  async function addFriendFromResult(index) {
    const item = runtime.searchResults[Number(index)];
    if (!item) return;
    const name = runtime.searchQuery || item.suggestedName || item.profile.keys[0] || item.profile.name;
    const duplicate = friendList().find((friend) => friend.worldbookName === runtime.settings.worldbookName && friend.profile?.fingerprint === item.profile.fingerprint);
    if (duplicate) {
      notify('该人设条目已经添加为好友。', 'warning');
      return;
    }
    const friend = {
      id: uid('friend'),
      name,
      aliases: [...new Set(item.profile.keys.filter((key) => key !== name))],
      worldbookName: runtime.settings.worldbookName,
      profile: item.profile,
      addedAt: now(),
      lastMessageAt: 0,
      unreadCount: 0,
      muted: false,
      projectionWarning: '',
    };
    runtime.chatData.friends[friend.id] = friend;
    runtime.chatData.threads[friend.id] = { friendId: friend.id, messages: [] };
    runtime.searchResults = [];
    saveChatData();
    notify(`已添加好友：${friend.name}`, 'success');
    render();
  }

  async function deleteFriend(friendId) {
    const friend = getFriend(friendId);
    if (!friend) return;
    if (!runtime.rootWindow.confirm(`删除好友“${friend.name}”及当前聊天存档中的全部私聊记录？`)) return;
    delete runtime.chatData.friends[friendId];
    delete runtime.chatData.threads[friendId];
    runtime.chatData.intents = runtime.chatData.intents.filter((intent) => intent.friendId !== friendId);
    saveChatData();
    await rebuildAllProjections();
    render();
  }

  async function refreshWorldbookSelect() {
    try {
      const names = await listWorldbooks();
      const select = runtime.document.getElementById('pm-worldbook');
      if (!select) return;
      select.innerHTML = '<option value="">请选择世界书</option>' + names.map((name) => `<option value="${escapeHtml(name)}" ${name === runtime.settings.worldbookName ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('');
    } catch (error) {
      notify(`获取世界书列表失败：${error.message || error}`, 'error');
    }
  }

  async function refreshModelList() {
    if (runtime.modelLoading) return;
    const doc = runtime.document;
    const apiUrl = asText(doc.getElementById('pm-api-url')?.value || runtime.settings.apiUrl).trim();
    const apiKey = asText(doc.getElementById('pm-api-key')?.value || runtime.settings.apiKey);
    if (!apiUrl) {
      notify('获取模型列表需要先填写独立 API 地址。', 'warning');
      return;
    }
    const getModelList = getHelperFunction('getModelList');
    if (!getModelList) {
      notify('当前酒馆助手不提供 getModelList，请手动填写模型名。', 'warning');
      return;
    }
    runtime.modelLoading = true;
    const button = doc.querySelector('[data-action="refresh-models"]');
    if (button) { button.disabled = true; button.textContent = '获取中…'; }
    try {
      const models = await getModelList({ apiurl: apiUrl, key: apiKey || undefined });
      runtime.modelList = Array.isArray(models)
        ? [...new Set(models.map((model) => asText(model).trim()).filter(Boolean))].sort()
        : [];
      const datalist = doc.getElementById('pm-model-list');
      if (datalist) datalist.innerHTML = runtime.modelList.map((model) => `<option value="${escapeHtml(model)}"></option>`).join('');
      notify(runtime.modelList.length ? `已获取 ${runtime.modelList.length} 个模型。` : '接口返回的模型列表为空。', runtime.modelList.length ? 'success' : 'warning');
    } catch (error) {
      notify(`获取模型列表失败：${error.message || error}`, 'error');
    } finally {
      runtime.modelLoading = false;
      if (button) { button.disabled = false; button.textContent = '获取独立 API 模型'; }
    }
  }

  async function saveSettingsFromUi() {
    const doc = runtime.document;
    const oldBook = runtime.settings.worldbookName;
    runtime.settings.worldbookName = asText(doc.getElementById('pm-worldbook')?.value).trim();
    runtime.settings.apiMode = asText(doc.getElementById('pm-api-mode')?.value || 'current');
    runtime.settings.proxyPreset = asText(doc.getElementById('pm-proxy')?.value).trim();
    runtime.settings.apiUrl = asText(doc.getElementById('pm-api-url')?.value).trim();
    runtime.settings.apiKey = asText(doc.getElementById('pm-api-key')?.value);
    runtime.settings.apiSource = asText(doc.getElementById('pm-api-source')?.value || 'openai');
    runtime.settings.model = asText(doc.getElementById('pm-model')?.value).trim();
    runtime.settings.maxTokens = Number(doc.getElementById('pm-max-tokens')?.value || 1200);
    runtime.settings.temperature = Number(doc.getElementById('pm-temperature')?.value || 0.85);
    runtime.settings.proactiveEnabled = Boolean(doc.getElementById('pm-proactive-enabled')?.checked);
    runtime.settings.proactiveEveryTurns = Number(doc.getElementById('pm-proactive-turns')?.value || 2);
    runtime.settings.proactiveFriendCooldownTurns = Number(doc.getElementById('pm-friend-cooldown')?.value || 3);
    runtime.settings.maxProjectionTokens = Number(doc.getElementById('pm-projection-limit')?.value || 12000);
    saveSettings();
    if (oldBook && oldBook !== runtime.settings.worldbookName) await clearPigeonProjections(oldBook);
    await rebuildAllProjections();
    notify('设置已保存。', 'success');
    render();
  }

  function bindUiEvents(root) {
    const button = root.querySelector('.pm-fab');
    if (button) installDrag(button, root);
    root.querySelectorAll('[data-action]').forEach((element) => {
      element.addEventListener('click', async (event) => {
        event.stopPropagation();
        const target = event.currentTarget;
        const action = target.dataset.action;
        if (action === 'close-panel') root.querySelector('.pm-panel')?.classList.add('pm-hidden');
        if (action === 'tab') { runtime.view = target.dataset.view; runtime.activeFriendId = ''; render(); }
        if (action === 'back') { runtime.activeFriendId = ''; runtime.view = 'threads'; render(); }
        if (action === 'open-friend') {
          runtime.activeFriendId = target.dataset.id;
          const friend = getFriend(runtime.activeFriendId);
          if (friend) { friend.unreadCount = 0; saveChatData(); }
          render();
        }
        if (action === 'search-worldbook') await searchWorldbook();
        if (action === 'add-friend') await addFriendFromResult(target.dataset.index);
        if (action === 'delete-friend') await deleteFriend(target.dataset.id);
        if (action === 'toggle-mute') {
          const friend = getFriend(target.dataset.id);
          if (friend) { friend.muted = !friend.muted; saveChatData(); render(); }
        }
        if (action === 'refresh-worldbooks') await refreshWorldbookSelect();
        if (action === 'refresh-models') await refreshModelList();
        if (action === 'save-settings') await saveSettingsFromUi();
        if (action === 'rebuild-projections') { await rebuildAllProjections(); notify('世界书投影已重建。', 'success'); }
        if (action === 'test-proactive') { await evaluateProactiveMessages('manual_test'); notify('主动联系判断已执行。', 'info'); }
        if (action === 'send-message') {
          const textarea = runtime.document.getElementById('pm-compose');
          const text = asText(textarea?.value).trim();
          if (text) { textarea.value = ''; await sendFriendMessage(runtime.activeFriendId, text); }
        }
      });
    });
    const compose = runtime.document.getElementById('pm-compose');
    compose?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        const text = asText(compose.value).trim();
        if (text) { compose.value = ''; sendFriendMessage(runtime.activeFriendId, text); }
      }
    });
    const search = runtime.document.getElementById('pm-search-input');
    search?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); searchWorldbook(); }
    });
  }

  async function init() {
    const host = getHost();
    runtime.rootWindow = host.rootWindow;
    runtime.document = host.rootWindow.document;

    const existing = runtime.rootWindow[APP_KEY];
    if (existing && typeof existing.destroy === 'function') {
      try { await existing.destroy(); } catch { /* ignore */ }
    }
    runtime.rootWindow[APP_KEY] = {
      version: VERSION,
      destroy,
      rebuildProjections: rebuildAllProjections,
      evaluateProactiveMessages,
      getState: () => clone({
        version: VERSION,
        chatId: runtime.chatId,
        settings: { ...runtime.settings, apiKey: runtime.settings?.apiKey ? '[已设置]' : '' },
        chatData: runtime.chatData,
        busy: runtime.busy,
        plannerBusy: runtime.plannerBusy,
      }),
    };

    loadSettings();
    runtime.chatId = getCurrentChatId() || `temporary_${Date.now()}`;
    loadChatData();
    runtime.lastAssistantCount = getAssistantCount();
    injectStyles();
    render();
    subscribeEvents();
    setRepeating(processIntentQueue, 5000);
    schedule(rebuildAllProjections, 800);
    log(`v${VERSION} 已加载，chatId=${runtime.chatId}`);
  }

  async function destroy() {
    runtime.destroyed = true;
    runtime.sessionToken += 1;
    for (const timer of runtime.timers) {
      runtime.rootWindow?.clearTimeout(timer);
      runtime.rootWindow?.clearInterval(timer);
    }
    runtime.timers.clear();
    for (const unsubscribe of runtime.unsubscribers) {
      try { unsubscribe(); } catch { /* ignore */ }
    }
    runtime.unsubscribers = [];
    runtime.document?.getElementById(ROOT_ID)?.remove();
    runtime.document?.getElementById(STYLE_ID)?.remove();
    if (runtime.rootWindow?.[APP_KEY]?.destroy === destroy) delete runtime.rootWindow[APP_KEY];
  }

  const ready = () => init().catch((error) => {
    console.error('[飞鸽传书] 初始化失败', error);
    notify(`初始化失败：${error.message || error}`, 'error');
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready, { once: true });
  } else {
    ready();
  }
})();
