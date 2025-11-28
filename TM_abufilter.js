// ==UserScript==
// @name         TM abufilter
// @description  Автоскрытие тредов и постов, относительное время, цветные рефки, и еще немного мелочи. GUI управление.
// @namespace    obezyana_na_palke
// @version      1.1.2
// @author       @noname08662
// @match        *://2ch.su/*
// @match        *://2ch.life/*
// @match        *://2ch.org/*
// @exclude      /.*:\/\/2ch\.[^\/]+\/(?:(?!\w)|[^\/]+\/(?!res).+)/
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @downloadURL  https://github.com/noname08662/TM-abufilter
// @updateURL    https://github.com/noname08662/TM-abufilter
// @license      MIT
// ==/UserScript==

// Kelly colors украдено отсюда: https://update.greasyfork.org/scripts/369870/2ch%20Colorized%20Links.user.js

(function() {
'use strict';


// ---------- BASIC HELPERS ----------
const BOARD_ID = (globalThis.location.pathname.split('/')[1] || 'default').replace(/[^\w-]/g, '');
const BOARD_DATA_KEY = `tm_abufilter_${BOARD_ID}`;
const RULES_SCOPE_KEY = `tm_abufilter_rules_scope_${BOARD_ID}`;
const GLOBAL_FILTERS_KEY = 'tm_abufilter_global';

const TEXT_POOL_KEYS = ['all', 'allP', 'only', 'onlyP', 'strip', 'stripP'];
let TEXT_POOLS_T, TEXT_POOLS_R;

const ASCII_PUNCT = (() => {
    const t = new Uint8Array(128);
    for (let i = 0x20; i <= 0x2F; i++) t[i] = 1;
    for (let i = 0x3A; i <= 0x40; i++) t[i] = 1;
    for (let i = 0x5B; i <= 0x60; i++) t[i] = 1;
    for (let i = 0x7B; i <= 0x7E; i++) t[i] = 1;
    return t;
})();

const REPLY_OR_GREEN_RE =/<a[^>]*class="post-reply-link"[^>]*>.*?<\/a>|<span[^>]*class="[^"]*(?:unkfunc|greentext)[^"]*"[^>]*>.*?<\/span>/gis;
const GREEN_SPAN_RE = /<span[^>]*class="[^"]*(?:unkfunc|greentext)[^"]*"[^>]*>(.*?)<\/span>/gis;
const TAG_OR_BR_RE = /(<br\s*\/?>)|<[^>]+>/gi;
const PUNCT_RE = /\p{P}/gu;

const DECODE_MAP = {
    '&nbsp;': ' ',
    '&gt;':   '>',
    '&lt;':   '<',
    '&amp;':  '&',
    '&quot;': '"',
    '&#39;':  "'",
    '&apos;': "'"
};
const DECODE_RE = /&(?:nbsp|gt|lt|amp|quot|#39|apos|#\d+|#x[0-9a-fA-F]+);/gi;

const decode = (str) => str.replace(DECODE_RE, m => {
    const known = DECODE_MAP[m];
    if (known !== undefined) return known;
    if (m[1] === '#') {
        if (m[2] === 'x' || m[2] === 'X') {
            // hex
            const code = parseInt(m.slice(3, -1), 16);
            if (Number.isFinite(code)) return String.fromCharCode(code);
        } else {
            // decimal
            const code = parseInt(m.slice(2, -1), 10);
            if (Number.isFinite(code)) return String.fromCharCode(code);
        }
    }
    return m;
});

const T_POST_CONTROLS = (() => {
    const t = document.createElement('template');
    t.innerHTML = `
        <span class="post__detailpart tm-snippet-part">
            <a class="post-reply-link tm-match-snippet--link tm-element-hidden"></a>
            <span class="tm-match-snippet--text tm-element-hidden"></span>
        </span>
        <span class="post__detailpart tm-media-part">
            <button class="tm-control-btn tm-media-toggle" type="button"></button>
        </span>
        <span class="post__detailpart tm-collapse-part">
            <button class="tm-control-btn tm-collapse-btn" type="button"></button>
        </span>
    `;
    return t;
})();

const DESC_MAP = {
	'manual': 'вручную',
	'filtered': 'фильтр',
	'duplicate': 'дубль',
	'duplicate-post': 'дубль-пост',
};

const currentThreadId = (() => {
    const match = globalThis.location.pathname.match(/\/res\/(\d+)/);
    return match ? match[1] : null;
})();

const h32 = s => {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
};

const escapeHtml = str => String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/'/g, '&#39;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');


const runIdle = (cb, timeout=250) => (globalThis.requestIdleCallback ? globalThis.requestIdleCallback(cb, { timeout }) : setTimeout(cb, 0));

const getConfigStorageKey = (scope) => scope === 'global' ? 'tm_config_global' : `tm_config_${BOARD_ID}`;

const getPreferredConfigScope = () => {
    return (safeGet(getConfigStorageKey('board'), {}) || {}).__useBoardConfig === true ? 'board' : 'global';
};

const setPreferredConfigScope = (scope) => {
    const key = getConfigStorageKey('board');
    const boardCfg = safeGet(key, {}) || {};
    boardCfg.__useBoardConfig = (scope === 'board');
    safeSet(key, boardCfg);
};

const getPreferredRulesScope = () => {
    return (safeGet(RULES_SCOPE_KEY, 'global') === 'board' ? 'board' : 'global');
};

const setPreferredRulesScope = (scope) => {
    if (scope !== 'board' && scope !== 'global') return;
    safeSet(RULES_SCOPE_KEY, scope);
};

const loadConfigFromStorage = (scope) => {
    const source = safeGet(getConfigStorageKey(scope), {});
    const config = {};
    for (const def of [...CONFIG_DEFINITIONS.basic, ...CONFIG_DEFINITIONS.advanced]) {
        config[def.key] = source[def.key] !== undefined ? source[def.key] : def.default;
    };
    return config;
};


// ---------- STORAGE UTILS ----------
const HAS_GM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

const safeGet = HAS_GM
    ? (key, def = null) => {
        const v = GM_getValue(key);
        return v === undefined ? def : v;
    }
    : (key, def = null) => {
        try {
            const s = localStorage.getItem(key);
            return s === null ? def : JSON.parse(s);
        } catch { return def; }
    };

const safeSet = HAS_GM
    ? (key, val) => {
        if (val === undefined) {
            try { GM_deleteValue(key); } catch { /**/ }
            return;
        }
        GM_setValue(key, val);
    }
    : (key, val) => {
        try {
            if (val === undefined) {
                localStorage.removeItem(key);
            } else {
                localStorage.setItem(key, JSON.stringify(val));
            }
        } catch { /**/ }
    };


// ---------- CONFIGURATION ----------
const CONFIG_DEFINITIONS = {
	basic: [
		{ key: 'WHITELIST_PARTICIPATED', label: 'Авто-белый список', type: 'checkbox', default: true, desc: 'Содержащие посты от пользователя треды (кроме скрытых вручную) будут автоматически добавлены в белый список' },
		{ key: 'FADE_COLLAPSED_POSTS', label: 'Затенять свёрнутые', type: 'checkbox', default: true, desc: 'Свёрнутые посты будут становиться полупрозрачными' },
		{ key: 'PROPAGATE_TAINT_BY_DEFAULT', label: '"Загрязнять" посты по умолчанию', type: 'checkbox', default: true, desc: 'Ответы на "загрязнённые" свёрнутые посты также будут свёрнуты' },
		{ key: 'HIDE_DUP_THREADS', label: 'Скрывать дубли тредов', type: 'checkbox', default: true, desc: 'Треды, чей текст совпадает с текстом других тредов, будут скрыты автоматически' },
		{ key: 'HIDE_DUP_POSTS', label: 'Скрывать дубли постов', type: 'checkbox', default: false, desc: 'Посты, чей текст совпадает с текстом других тредов, будут скрыты автоматически' },
		{ key: 'RELATIVE_TIME', label: 'Относительное время', type: 'checkbox', default: true, desc: 'Время будет отображаться в относительности (напр. "2 часа назад")', needsReload: true },
		{ key: 'MANAGER_BUTTON_POSITION', label: 'Позиция кнопки', type: 'string', default: 'bottom-left', desc: 'top-right | top-left | bottom-right | bottom-left' },
		{ key: 'DETAILS_REFORMAT', label: 'Переформатировать детали', type: 'checkbox', default: true, desc: 'Порядок: № → время → сага → #OP → остальное', needsReload: true },
		{ key: 'TRUNCATE_REPLY_LINKS', label: 'Обрезать ссылки-ответы', type: 'checkbox', default: true, desc: 'Только последние N цифр номера поста будут отображены', needsReload: true },
		{ key: 'TRUNCATE_REPLY_LINKS_DIGITS', label: 'Цифр (ссылки-ответы)', type: 'number', min: 1, max: 10, default: 4, desc: 'Лимит цифр обрезанных ссылок-ответов', needsReload: true },
		{ key: 'GREYSCALE_CLICKED_REPLY_LINKS', label: 'Затенять кликнутые ссылки', type: 'checkbox', default: true, desc: 'Кликнутые ссылки будут окрашены в серый' },
		{ key: 'COLORIZE_REPLY_LINKS', label: 'Раскрашивать ссылки', type: 'checkbox', default: true, desc: 'Ссылки-ответы будут окрашиваться по номеру поста', needsReload: true },
		{ key: 'AUTO_COLLAPSE_MEDIA_H', label: 'Свёртывать медиа ОП-постов', type: 'checkbox', default: false, desc: 'Прикреплённые к ОП-постам файлы будут свёрнуты автоматически' },
		{ key: 'AUTO_COLLAPSE_MEDIA_P', label: 'Свёртывать медиа постов', type: 'checkbox', default: false, desc: 'Прикреплённые к постам файлы будут свёрнуты автоматически' },
		{ key: 'KEEP_REMOVED_POSTS', label: 'Не удалять потёртые посты', type: 'checkbox', default: true, desc: 'Фича не была опробована в действии' },
	],
	advanced: [
		{ key: 'DAYS_TO_KEEP', label: 'Хранить дней', type: 'number', min: 1, max: 365, default: 7, desc: 'Дней для хранения данных о скрытых/свёрнутых' },
		{ key: 'SNIPPET_BEFORE_CHARS', label: 'Символов до совпадения', type: 'number', min: 0, max: 100, default: 20, desc: 'Отображаемое количество символов до совпадения в вырезке текста ОП-поста во вкладке "Треды"' },
		{ key: 'SNIPPET_AFTER_CHARS', label: 'Символов после совпадения', type: 'number', min: 10, max: 200, default: 60, desc: 'Отображаемое количество символов после совпадения в вырезке текста ОП-поста во вкладке "Треды"' },
		{ key: 'MAX_CHARS_IN_LIST', label: 'Символов текста ОП-поста во вкладке "Треды"', type: 'number', min: 20, max: 600, default: 500, desc: 'Макс. кол-во отображаемых символов из текста треда' },
		{ key: 'INSTANT_DETAILS', label: 'Мгновенно обрабатывать полосу деталей постов (время, номер, и т.д.)', type: 'checkbox', default: false, desc: 'На случай, если дефолтная (асинхронная) обработка создает видимое мигание' },
		{ key: 'MAX_SNIPPET_LENGTH', label: 'Лимит символов фрагмента совпадения', type: 'number', min: 4, max: 40, default: 15, desc: 'Макс. кол-во отображаемых символов во фрагментах (совпадений) постов', needsReload: true },
		{ key: 'PREVIEW_GREYSCALE_DELAY', label: 'Задержка затенения при взаимодействии с превью', type: 'number', min: 1000, max: 8000, default: 3000, desc: 'Временной интервал (мс) перед началом обработки ссылок' },
	]
};

const DEFAULT_CONFIG = {
    DAYS_TO_KEEP: 7,
    FADE_COLLAPSED_POSTS: true,
    AUTO_COLLAPSE_MEDIA_H: false,
    AUTO_COLLAPSE_MEDIA_P: false,
    PROPAGATE_TAINT_BY_DEFAULT: true,
    HIDE_DUP_THREADS: true,
    HIDE_DUP_POSTS: false,
    RELATIVE_TIME: true,
    KEEP_REMOVED_POSTS: true,
    DETAILS_REFORMAT: true,
    TRUNCATE_REPLY_LINKS: true,
    TRUNCATE_REPLY_LINKS_DIGITS: 4,
    GREYSCALE_CLICKED_REPLY_LINKS: true,
    INSTANT_DETAILS: false,
    COLORIZE_REPLY_LINKS: true,
    SNIPPET_BEFORE_CHARS: 20,
    SNIPPET_AFTER_CHARS: 60,
	MAX_CHARS_IN_LIST: 500,
    MAX_SNIPPET_LENGTH: 15,
    MANAGER_BUTTON_POSITION: 'bottom-left',

    BATCH_PROCESS_FRAME_BUDGET_MS: 16,
    SAVE_DEBOUNCE: 250,
	MAX_NORM_CACHE_SIZE: 100,
};
let CONFIG = { ...DEFAULT_CONFIG, ...loadConfigFromStorage(getPreferredConfigScope()) };


// ---------- FLAGS / DEFINITIONS ----------
const FLAGS_BM = {
    OP_INCLUDE:         1 << 0,
    OP_EXCLUDE:         1 << 1,
    SAGE_INCLUDE:       1 << 2,
    SAGE_EXCLUDE:       1 << 3,
    MEDIA_INCLUDE:      1 << 4,
    MEDIA_EXCLUDE:      1 << 5,
    TO_ME_INCLUDE:      1 << 6,
    TO_ME_EXCLUDE:      1 << 7,
    MY_POST_INCLUDE:    1 << 8,
    MY_POST_EXCLUDE:    1 << 9,
    TAINT_INCLUDE:      1 << 10,
    TAINT_EXCLUDE:      1 << 11,
    GREENTEXT_INCLUDE:  1 << 12,
    GREENTEXT_EXCLUDE:  1 << 13
};

const REGEX_FLAG_DEFINITIONS = [
    { key: 'i', name: 'Без учёта регистра', desc: 'Игнорировать регистр букв', default: true },
    { key: 'u', name: 'Юникод', desc: 'Поддержка юникода', default: true }
];

const FLAG_DEFINITIONS = [
    { id: 'op', name: 'ОП-посты', desc: 'Только/искл. начальные посты (ОП тредов)', include: FLAGS_BM.OP_INCLUDE, exclude: FLAGS_BM.OP_EXCLUDE, replyOnly: true },
    { id: 'sage', name: 'Сага', desc: 'Только/искл. посты с sage', include: FLAGS_BM.SAGE_INCLUDE, exclude: FLAGS_BM.SAGE_EXCLUDE },
    { id: 'media', name: 'С медиа', desc: 'Только/искл. посты с вложениями', include: FLAGS_BM.MEDIA_INCLUDE, exclude: FLAGS_BM.MEDIA_EXCLUDE, replyOnly: true },
    { id: 'toMe', name: 'Ответы мне', desc: 'Только/искл. ответы на ваши посты', include: FLAGS_BM.TO_ME_INCLUDE, exclude: FLAGS_BM.TO_ME_EXCLUDE, replyOnly: true },
    { id: 'myPost', name: 'Мои посты', desc: 'Только/искл. ваши посты', include: FLAGS_BM.MY_POST_INCLUDE, exclude: FLAGS_BM.MY_POST_EXCLUDE },
    { id: 'taint', name: 'Загрязнять', desc: 'Ответ "загрязненному" посту также будет свёрнут', include: FLAGS_BM.TAINT_INCLUDE, exclude: FLAGS_BM.TAINT_EXCLUDE, replyOnly: true },
    { id: 'greentext',name: 'Гринтекст', desc: 'Только/искл. строки с гринтекстом', include: FLAGS_BM.GREENTEXT_INCLUDE, exclude: FLAGS_BM.GREENTEXT_EXCLUDE }
];

const FLAG_BY_ID = Object.fromEntries(FLAG_DEFINITIONS.map(c => [c.id, c]));

const softAnchorToken = '\\s*\\p{L}+(?:[\\s\\p{P}\\p{S}]*)?';


// ---------- STYLES ----------
const KELLY_COLORS = [
    "#FFB300", "#803E75", "#FF6800", "#A6BDD7", "#C10020", "#CEA262",
    /*"#817066",*/ "#007D34", "#F6768E", "#00538A", "#FF7A5C", /*"#53377A",*/
    "#FF8E00", "#B32851", "#F4C800", "#7F180D", "#93AA00",
    "#593315", "#F13A13", /*"#232C16",*/ "#982143", /*"#6E5168"*/
];
const KELLY_LEN = KELLY_COLORS.length;
const KELLY = Array.from({length: KELLY_LEN}, (_, i) => 'kelly-' + i);

const trunc = !!CONFIG.TRUNCATE_REPLY_LINKS;
const greyscale = !!CONFIG.GREYSCALE_CLICKED_REPLY_LINKS;
const keep = +CONFIG.TRUNCATE_REPLY_LINKS_DIGITS;
const colorize = !!CONFIG.COLORIZE_REPLY_LINKS;

const updatePostStyle = () => {
	document.documentElement.classList.toggle('tm-fade-collapsed-on', CONFIG.FADE_COLLAPSED_POSTS);
	//document.documentElement.classList.toggle('tm-details-on', CONFIG.DETAILS_REFORMAT);
	//document.documentElement.classList.toggle('tm-trunc-on', CONFIG.TRUNCATE_REPLY_LINKS);
};

const applyManagerButtonPosition = (val) => {
	const box = document.getElementById('tm-helper-button');
	if (!box) return;
	box.className = `tm-helper-pos-${val || (loadConfigFromStorage('board').MANAGER_BUTTON_POSITION ||
	loadConfigFromStorage('global').MANAGER_BUTTON_POSITION || 'bottom-left')}`;
};

const TM_STYLE_ID = 'tm-style';
const TM_STYLE = (`
/* ================= Root / Theme Tokens ================= */
:root {
  color-scheme: light dark;

  /* Palette */
  --tm-bg: var(--theme_default_bg, Canvas);
  --tm-muted: var(--theme_default_alttext, #666);
  --tm-text-base: color-mix(in oklab, var(--theme_default_text) 75%, var(--tm-muted) 25%);
  --tm-text: color-mix(in oklab, var(--tm-text-base) 75%, var(--tm-bg) 25%);
  --tm-link: var(--theme_default_link);
  --tm-border: color-mix(in oklab, var(--tm-text-base) 25%, transparent);

  /* Elevation */
  --tm-surface: color-mix(in oklab, var(--tm-bg) 95%, var(--tm-text-base) 5%);
  --tm-surface-2: color-mix(in oklab, var(--tm-bg) 95%, var(--tm-muted) 5%);
  --tm-shadow: 0 10px 30px color-mix(in oklab, var(--tm-text-base) 20%, transparent);
  --tm-ring: 0 0 0 2px color-mix(in oklab, var(--tm-link) 75%, transparent);

  /* Hover/Active */
  --tm-hover-bg: color-mix(in oklab, var(--tm-bg) 92%, var(--tm-text-base) 8%);
  --tm-active-bg: color-mix(in oklab, var(--tm-bg) 88%, var(--tm-text-base) 12%);
  --tm-border-hover: color-mix(in oklab, var(--tm-text-base) 30%, transparent);
  --tm-border-accent-hover: color-mix(in oklab, var(--tm-link) 40%, var(--tm-border) 60%);

  /* Spacing + Radius */
  --tm-r-2: 6px;
  --tm-r-3: 8px;
  --tm-px-1: 6px;
  --tm-px-2: 8px;
  --tm-px-3: 12px;
  --tm-px-4: 16px;

  /* State colors */
  --tm-ok: color-mix(in oklab, #059911 60%, var(--tm-link) 40%);
  --tm-warn: color-mix(in oklab, #995B05 60%, var(--tm-link) 40%);
  --tm-bad: color-mix(in oklab, #991105 60%, var(--tm-link) 40%);
}

/* ================= Post ================= */
.post { position: relative; }

.post__detailpart { order: 10; }
.post__detailpart--num { order: 1; }
.post__detailpart--refl { order: 2; }
.post__detailpart--time { order: 3; }
.post__detailpart--op { order: 4; }
.post__detailpart--mail { order: 5; }

.post_preview .tm-collapse-part,
.post_type_oppost .tm-collapse-part { display: none !important; }

.post:has(.post__images) .tm-media-part { display: flex; }

.tm-element-hidden { display: none !important; }

/* ================= Post Controls ================= */
.tm-snippet-part { margin-left: auto !important; }
.tm-media-part { display: none; padding-right: 0 !important; }
.tm-collapse-part { padding-right: 0 !important; }

.tm-post_type_mocha_sosat { background: var(--tm-bg); border-left: 2px dashed var(--tm-muted); }

.tm-match-snippet--link {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 150px;
  min-width: 0;
  font-size: 80%;
}
.tm-match-snippet--text {
  color: var(--tm-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 150px;
  min-width: 0;
  font-size: 80%;
}

.tm-control-btn {
  cursor: pointer;
  color: var(--tm-muted);
  padding: 0;
  border: none;
  background: none;
  border-radius: var(--tm-r-2);
  outline-offset: 2px;
  transition: color 0.12s ease, box-shadow 0.12s ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: calc(1.1em * 1.6);
  block-size: calc(1.1em * 1.6);
  flex: 0 0 auto;
}

.tm-control-btn::before {
  content: "";
  display: block;
  inline-size: 1.1em;
  block-size: 1.1em;
  background: currentColor;
  -webkit-mask: var(--tm-icon) no-repeat center / 100% 100%;
  mask: var(--tm-icon) no-repeat center / 100% 100%;
}

.tm-control-btn:hover,
.tm-control-btn:focus,
.tm-control-btn:active { color: var(--tm-link); }

.tm-control-btn:focus-visible { box-shadow: var(--tm-ring); }

.tm-collapse-btn::before {
  --tm-icon: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7.41 14.59 12 10l4.59 4.59 1.41-1.41L12 7.17 6 13.18z"/></svg>');
}
.tm-collapsed .tm-collapse-btn::before {
  --tm-icon: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7.41 8.41 12 13l4.59-4.59 1.41 1.41L12 15.83 6 9.82z"/></svg>');
}

.tm-media-toggle::before {
  --tm-icon: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-3.5 6h7v8h-7V8z"/></svg>');
}
.tm-media-collapsed .tm-media-toggle::before {
  --tm-icon: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1.5 6.5 6 3.5-6 3.5V8.5z"/></svg>');
}

.tm-hidden { display: none !important; }

.tm-collapsed:not(.post_preview) .post__message,
.tm-collapsed:not(.post_preview) .post__images,
.tm-collapsed:not(.post_preview) .tm-media-part { display: none !important; }

.tm-media-collapsed .post__images,
.tm-media-collapsed .post__image-link,
.tm-media-collapsed .post__file-attr { display: none !important; }

.tm-clicked { color: var(--tm-muted) !important; }

/* ================= Notifications ================= */
.tm-notifications {
  position: fixed;
  top: 20px;
  right: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  pointer-events: none;
  z-index: 2147483646;
}
.tm-notification {
  background: var(--tm-bg);
  color: var(--tm-text);
  padding: 12px 16px;
  border-radius: 6px;
  min-width: 250px;
  max-width: 400px;
  opacity: 0;
  transform: translateX(100px);
  transition: all 0.3s ease;
  pointer-events: auto;
  border-left: 4px solid;
}
.tm-notification-show { opacity: 1; transform: translateX(0); }
.tm-notification-success { border-left-color: var(--tm-ok); }
.tm-notification-error { border-left-color: var(--tm-bad); }
.tm-notification-warning { border-left-color: var(--tm-warn); }
.tm-notification-info { border-left-color: var(--tm-link); }
.tm-notification-loading::after {
  content: '...';
  animation: tm-ellipsis 1s infinite steps(3, end);
}
@keyframes tm-ellipsis {
  0% { content: '…'; }
  33% { content: '..'; }
  66% { content: '.'; }
  100% { content: '…'; }
}

.tm-confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2147483645;
  animation: tm-fadeIn 0.2s ease;
}
@keyframes tm-fadeIn { from { opacity: 0; } to { opacity: 1; } }
.tm-confirm-dialog {
  background: var(--tm-bg);
  color: var(--tm-text);
  border-radius: 8px;
  padding: 24px;
  max-width: 500px;
  min-width: 300px;
  animation: tm-slideIn 0.3s ease;
}
@keyframes tm-slideIn {
  from { opacity: 0; transform: scale(0.9) translateY(-20px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
.tm-confirm-message { margin-bottom: 20px; line-height: 1.5; white-space: pre-wrap; }
.tm-confirm-actions { display: flex; gap: 12px; justify-content: flex-end; }
.tm-confirm-actions .tm-button { min-width: 80px; }
.tm-confirm-actions .tm-button:focus { outline: none; box-shadow: var(--tm-ring); }

/* ================= Helper Button Positions ================= */
.tm-helper-pos-top-right { top: 16px; right: 16px; flex-direction: row; }
.tm-helper-pos-top-left { top: 16px; left: 16px; flex-direction: row-reverse; }
.tm-helper-pos-bottom-right { bottom: 16px; right: 16px; flex-direction: row; }
.tm-helper-pos-bottom-left { bottom: 16px; left: 16px; flex-direction: row-reverse; }

/* ================= Typography ================= */
.tm-h3 {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 var(--tm-px-3);
  color: var(--tm-text);
}
.tm-h4 {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 var(--tm-px-2);
  color: var(--tm-text);
}
.tm-subtle { color: var(--tm-muted); }

/* ================= Overlay / Modal ================= */
#tm-management-modal,
#tm-management-modal * {
  scrollbar-width: thin;
  scrollbar-color: var(--tm-border) transparent;
}
#tm-management-modal::-webkit-scrollbar { width: 6px; height: 6px; }
#tm-management-modal::-webkit-scrollbar-track { background: transparent; }
#tm-management-modal::-webkit-scrollbar-thumb {
  background: var(--tm-border);
  border-radius: 3px;
}
#tm-management-modal::-webkit-scrollbar-thumb:hover {
  background: var(--tm-border-hover);
}

.tm-management-overlay.tm-dimmed > #tm-management-modal {
  filter: brightness(0.7);
  pointer-events: none;
}

#tm-management-overlay,
.tm-management-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  pointer-events: auto;
}

#tm-management-modal {
  width: 95%;
  max-width: 980px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 10px;
  border: 1px solid var(--tm-border);
  box-shadow: var(--tm-shadow);
  background: var(--tm-bg);
  color: var(--tm-text);
}

#tm-management-header {
  padding: var(--tm-px-2) var(--tm-px-3);
  display: flex;
  align-items: center;
  gap: var(--tm-px-2);
  justify-content: space-between;
  border-bottom: 1px solid var(--tm-border);
  background: var(--tm-surface);
}

/* ================= Tabs ================= */
#tm-management-tabs {
  display: flex;
  gap: var(--tm-px-2);
  flex-wrap: wrap;
}
.tm-tab {
  padding: var(--tm-px-1) var(--tm-px-2);
  border-radius: var(--tm-r-2);
  color: var(--tm-text);
  background: var(--tm-bg);
  border: 1px solid var(--tm-border);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease, box-shadow 0.12s ease;
  font-size: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.tm-tab:focus-visible { outline: none; box-shadow: var(--tm-ring); }
.tm-tab.tm-tab-active {
  color: var(--tm-bg);
  background: var(--tm-link);
  border-color: var(--tm-link);
}
.tm-tab:hover {
  color: var(--tm-link);
  background: var(--tm-hover-bg);
  border-color: var(--tm-border-accent-hover);
}
.tm-tab.tm-tab-active:hover {
  color: var(--tm-bg);
  background: color-mix(in oklab, var(--tm-link) 90%, var(--tm-text) 10%);
  border-color: var(--tm-link);
}
.tm-tab svg {
  display: block;
  width: 18px;
  height: 18px;
}

#tm-management-content {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
.tm-tab-content {
  display: none !important;
  width: 100%;
  overflow-y: auto;
  padding: 0;
}
.tm-tab-content.tm-tab-active {
  display: block !important;
  padding: var(--tm-px-3);
}

/* ================= Panels ================= */
.tm-panel {
  background: var(--tm-surface);
  border: 1px solid var(--tm-border);
  border-radius: var(--tm-r-3);
  padding: var(--tm-px-3);
}
.tm-tab-content > * + * { margin-top: var(--tm-px-3); }
.tm-panel > * + * { margin-top: var(--tm-px-3); }

.tm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--tm-px-2);
  flex-wrap: nowrap;
}
.tm-header--column {
  flex-direction: column;
  align-items: stretch;
  justify-content: initial;
  padding-bottom: var(--tm-px-2);
  border-bottom: 1px solid var(--tm-border);
}
.tm-header h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--tm-text);
}

.tm-select-all {
  font-size: 0.9em;
  color: var(--tm-muted);
}

/* ================= Buttons ================= */
.tm-button {
  padding: var(--tm-px-1) var(--tm-px-2);
  border-radius: var(--tm-r-2);
  cursor: pointer;
  font-size: 14px;
  line-height: 1.2;
  white-space: nowrap;
  color: var(--tm-text);
  background: var(--tm-bg);
  border: 1px solid var(--tm-border);
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;
  outline-offset: 2px;
}
.tm-button:focus-visible { outline: none; box-shadow: var(--tm-ring); }
.tm-button:disabled { opacity: 0.45; cursor: not-allowed; }
.tm-button.primary {
  color: var(--tm-bg);
  background: var(--tm-link);
  border-color: var(--tm-link);
}
.tm-button:hover {
  color: var(--tm-link);
  background: var(--tm-hover-bg);
  border-color: var(--tm-border-accent-hover);
}
.tm-button.primary:hover {
  background: color-mix(in oklab, var(--tm-link) 90%, var(--tm-text) 10%);
  border-color: var(--tm-link);
  color: var(--tm-bg);
}
.tm-button.tm-danger {
  color: var(--tm-bad);
  border-color: color-mix(in oklab, var(--tm-bad) 40%, transparent);
}
.tm-button.tm-danger:hover {
  background: color-mix(in oklab, var(--tm-bad) 10%, var(--tm-bg) 90%);
  border-color: var(--tm-bad);
}
.tm-actions {
  display: flex;
  gap: var(--tm-px-2);
  align-items: center;
  margin-left: auto;
}

/* ================= Storage Menu ================= */
.tm-storage-menu { position: relative; }
.tm-storage-dropdown {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  min-width: 280px;
  max-width: 360px;
  max-height: 60vh;
  overflow: auto;
  display: none;
  z-index: 10001;
  padding: var(--tm-px-2);
  background: var(--tm-bg);
  border: 1px solid var(--tm-border);
  border-radius: var(--tm-r-2);
}
.tm-storage-dropdown.tm-open { display: block; }
.tm-storage-form { display: grid; gap: var(--tm-px-2); }
.tm-storage-actions { display: flex; gap: var(--tm-px-1); justify-content: flex-end; }

.tm-storage-block {
  border: 1px solid var(--tm-border);
  border-radius: var(--tm-r-2);
  padding: var(--tm-px-2);
  margin: 0;
  background: var(--tm-surface);
  display: grid;
  gap: var(--tm-px-1);
}
.tm-storage-block legend {
  font-size: 13px;
  font-weight: 500;
  color: var(--tm-text);
  padding: 0 6px;
}

/* ================= Choice / Inputs ================= */
.tm-choice {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  line-height: 1.2;
  cursor: pointer;
}
.tm-choice-card { align-items: flex-start; }
.tm-choice:hover { color: var(--tm-link); }

.tm-choice label,
.tm-choice input[type="checkbox"],
.tm-choice input[type="radio"] { margin: 0; cursor: pointer; }

.tm-choice input[type="checkbox"],
.tm-choice input[type="radio"] {
  display: block;
  width: 16px;
  height: 16px;
  vertical-align: middle;
}

.tm-input,
.tm-search-input,
.tm-rule-row input[type="text"],
.tm-rule-row textarea,
#tm-config-body input[type="number"],
#tm-config-body input[type="text"],
#tm-config-body textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  font: inherit;
  font-size: 14px;
  color: var(--tm-text);
  background: var(--tm-bg);
  border: 1px solid var(--tm-border);
  border-radius: var(--tm-r-2);
  transition: border-color 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
}
.tm-input::placeholder,
.tm-search-input::placeholder,
.tm-rule-row input[type="text"]::placeholder,
.tm-rule-row textarea::placeholder,
#tm-config-body input[type="number"]::placeholder,
#tm-config-body input[type="text"]::placeholder,
#tm-config-body textarea::placeholder {
  color: color-mix(in oklab, var(--tm-text) 50%, var(--tm-bg) 50%);
}
.tm-input:hover,
.tm-search-input:hover,
.tm-rule-row input[type="text"]:hover,
.tm-rule-row textarea:hover,
#tm-config-body input[type="number"]:hover,
#tm-config-body input[type="text"]:hover,
#tm-config-body textarea:hover {
  background: var(--tm-surface-2);
  border-color: var(--tm-border-accent-hover);
}
.tm-input:focus,
.tm-search-input:focus,
.tm-rule-row input[type="text"]:focus,
.tm-rule-row textarea:focus,
#tm-config-body input[type="number"]:focus,
#tm-config-body input[type="text"]:focus,
#tm-config-body textarea:focus {
  outline: none;
  box-shadow: var(--tm-ring);
}

input[type="number"].tm-nosnap::-webkit-outer-spin-button,
input[type="number"].tm-nosnap::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
input[type="number"].tm-nosnap { -moz-appearance: textfield; }

/* ================= Dropdown / Multiselect ================= */
.tm-flags-multiselect { position: relative; }
.tm-flags-display {
  padding: var(--tm-px-1) var(--tm-px-2);
  border: 1px solid var(--tm-border);
  border-radius: var(--tm-r-2);
  background: var(--tm-bg);
  color: var(--tm-text);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  white-space: nowrap;
  transition: border-color 0.12s ease, background 0.12s ease, box-shadow 0.12s ease;
}
.tm-dd-current { flex: 1 1 auto; min-width: 0; }
.tm-dd-caret { margin-left: auto; flex-shrink: 0; }

.tm-rule-row .tm-flags-display { min-height: 38px; }
.tm-flags-display:hover {
  color: var(--tm-link);
  background: var(--tm-hover-bg);
  border-color: var(--tm-border-accent-hover);
}
.tm-flags-display:focus-visible { outline: none; box-shadow: var(--tm-ring); }
.tm-flags-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin-top: 4px;
  z-index: 1000;
  max-height: 300px;
  overflow: auto;
  display: none;
  background: var(--tm-surface);
  border: 1px solid var(--tm-border);
  border-radius: var(--tm-r-3);
  min-width: 100%;
  width: max-content;
  max-width: 480px;
  padding: var(--tm-px-2);
}
.tm-flags-dropdown.tm-open { display: block; }
.tm-flags-placeholder { color: var(--tm-muted); font-size: 14px; }

.tm-flag-option {
  padding: 10px 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 10px;
  transition: background 0.12s ease;
  background: var(--tm-surface-2);
  position: relative;
  border-radius: var(--tm-r-2);
}
.tm-flag-option + .tm-flag-option { margin-top: 6px; }
.tm-flag-option:hover {
  background: color-mix(in oklab, var(--tm-link) 15%, var(--tm-bg) 85%);
}
.tm-flag-option:focus-visible { outline: none; box-shadow: var(--tm-ring); }

.tm-flag-option-check {
  --flag-bg: transparent;
  --flag-fg: var(--tm-bg);
  --flag-mark: "";
  width: 18px;
  height: 18px;
  border: 1px solid var(--tm-border);
  border-radius: var(--tm-r-2);
  display: grid;
  place-items: center;
  background: var(--flag-bg);
  color: var(--flag-fg);
  line-height: 0;
  box-sizing: border-box;
  flex-shrink: 0;
}
.tm-flag-option-check::after {
  content: var(--flag-mark);
  font-size: 12px;
  transform: translateY(-0.5px);
}
.tm-flag-option.include .tm-flag-option-check {
  --flag-bg: var(--tm-link);
  --flag-mark: "✓";
}
.tm-flag-option.exclude .tm-flag-option-check {
  --flag-bg: var(--tm-muted);
  --flag-mark: "!";
}

.tm-flag-option-label {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.tm-flag-option-name { font-weight: 500; font-size: 14px; color: var(--tm-text); }
.tm-flag-option-desc { font-size: 12px; color: var(--tm-muted); }

.tm-flag-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 12px;
  background: var(--tm-link);
  color: var(--tm-bg);
  font-size: 14px;
  font-weight: 500;
  flex: 0 0 auto;
}
.tm-flag-chip.include { background: var(--tm-link); }
.tm-flag-chip.exclude { background: var(--tm-muted); }
.tm-flag-chip-remove {
  cursor: pointer;
  font-weight: 700;
  width: 1.25em;
  height: 1.25em;
  line-height: 1.15em;
  text-align: center;
  border-radius: 50%;
  opacity: 0.85;
  transition: background 0.15s ease, opacity 0.15s ease, color 0.15s ease;
}
.tm-flag-chip-remove:hover {
  opacity: 1;
  color: var(--tm-bad);
  background: color-mix(in oklab, var(--tm-bg) 20%, transparent);
}

.tm-pattern-help {
  color: var(--tm-muted);
  padding-bottom: var(--tm-px-2);
  border-bottom: 1px solid var(--tm-border);
}
.tm-pattern-help summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--tm-text);
  padding: var(--tm-px-1) 0;
  user-select: none;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 6px;
}
.tm-pattern-help summary::-webkit-details-marker { display: none; }
.tm-pattern-help summary::before {
  content: '▸';
  display: inline-block;
  transition: transform 0.2s ease;
  font-size: 12px;
}
.tm-pattern-help[open] summary::before { transform: rotate(90deg); }
.tm-pattern-help summary:hover { color: var(--tm-link); }
.tm-pattern-help ul { margin-top: var(--tm-px-2); }
.tm-pattern-help code {
  padding: 2px 6px;
  border-radius: 3px;
  background: var(--tm-surface);
}

/* ================= Threads Tab ================= */
#tm-hidden-ops-filters {
  display: flex;
  gap: var(--tm-px-2);
  flex-wrap: wrap;
  padding: 8px;
}
#tm-hidden-ops-body { padding: var(--tm-px-3); }

.tm-ops-row {
  padding: 24px 84px 12px 12px;
  margin-bottom: 8px;
  border: 1px solid var(--tm-border);
  border-radius: 6px;
  position: relative;
  background: var(--tm-bg);
  color: var(--tm-text);
  transition: border-color 0.18s ease, background 0.18s ease;
  cursor: pointer;
}
.tm-ops-row:hover {
  border-color: var(--tm-border-accent-hover);
  background: var(--tm-hover-bg);
}
.tm-ops-row:focus-visible { outline: none; box-shadow: var(--tm-ring); }
.tm-desc-reply:focus-visible { outline: none; box-shadow: var(--tm-ring); }

.tm-ops-text {
  white-space: pre-wrap;
  word-break: break-word;
  margin-bottom: 6px;
  line-height: 1.4;
}
.tm-ops-desc {
  font-size: 0.9em;
  color: var(--tm-muted);
  margin-bottom: 6px;
}

.tm-ops-btn {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  right: 8px;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  line-height: 1;
  font-size: 16px;
  border-radius: var(--tm-r-2);
  color: var(--tm-muted);
  background: transparent;
  border: 1px solid transparent;
  outline-offset: 2px;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;
}
.tm-ops-btn:hover {
  color: var(--tm-link);
  background: var(--tm-hover-bg);
  border-color: var(--tm-border-accent-hover);
}
.tm-ops-btn:focus-visible { outline: none; box-shadow: var(--tm-ring); }

.tm-highlight {
  background: var(--tm-link);
  color: var(--tm-bg);
  padding: 1px 2px;
  border-radius: 2px;
}

/* ================= Rules Tab ================= */
#tm-rules-content {
  display: flex;
  flex-direction: column;
  gap: var(--tm-px-3);
  padding: var(--tm-px-3);
}
#tm-rules-layout {
  display: flex;
  flex-direction: column;
  gap: var(--tm-px-3);
}
.tm-rule-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tm-rule-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tm-rule-row label {
  font-size: 13px;
  color: var(--tm-muted);
  font-weight: 500;
}
.tm-rule-row small {
  font-size: 12px;
  color: var(--tm-muted);
}

#tm-rules-items {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 400px;
  overflow-y: auto;
  margin-top: var(--tm-px-2);
}
#tm-rules-items:focus-visible { outline: none; box-shadow: var(--tm-ring); }
.tm-rules-items-empty {
  padding: 20px;
  text-align: center;
  color: var(--tm-muted);
  border: 1px solid var(--tm-border);
  border-radius: var(--tm-r-3);
  background: var(--tm-bg);
}
.tm-rules-items-empty:focus-visible { outline: none; box-shadow: var(--tm-ring); }

.tm-rule-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  border: 1px solid var(--tm-border);
  border-radius: var(--tm-r-3);
  background: var(--tm-bg);
  transition: background 0.12s ease, border-color 0.12s ease;
  cursor: pointer;
}
.tm-rule-item:hover {
  color: var(--tm-link);
  background: var(--tm-surface-2);
  border-color: var(--tm-border-accent-hover);
}
.tm-rule-item:focus-visible { outline: none; box-shadow: var(--tm-ring); }
.tm-rule-item.tm-rule-error:not(.disabled) {
  border-color: var(--tm-bad);
  background: color-mix(in oklab, var(--tm-bad) 8%, var(--tm-bg) 92%);
}
.tm-rule-item.tm-rule-error:not(.disabled):hover {
  background: color-mix(in oklab, var(--tm-bad) 12%, var(--tm-bg) 88%);
}
.tm-rule-item.tm-rule-error.selected:not(.disabled) {
  border-color: color-mix(in oklab, var(--tm-bad) 60%, var(--tm-link) 40%);
  background: color-mix(in oklab, var(--tm-bad) 15%, color-mix(in oklab, var(--tm-surface) 85%, var(--tm-link) 15%));
}
.tm-rule-error-badge {
  background: var(--tm-bad) !important;
  color: var(--tm-bg) !important;
  cursor: help;
}
.tm-rule-header {
  display: flex;
  gap: 8px;
  align-items: center;
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
}
.tm-rule-type-badge {
  display: inline-flex;
  min-width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border-radius: var(--tm-r-2);
  color: var(--tm-muted);
  font-weight: 700;
  font-family: monospace;
  border: 1px solid var(--tm-border);
  background: var(--tm-surface-2);
  flex-shrink: 0;
}
.tm-rule-pattern {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
  color: var(--tm-text);
}
.tm-rule-desc-badge {
  margin-left: 8px;
  font-size: 12px;
  padding: 3px 8px;
  border-radius: var(--tm-r-2);
  background: var(--tm-link);
  color: var(--tm-bg);
  font-weight: 600;
  flex-shrink: 0;
}
.tm-rule-disabled-badge {
  margin-left: 8px;
  font-size: 12px;
  padding: 3px 8px;
  border-radius: var(--tm-r-2);
  background: var(--tm-muted);
  color: var(--tm-bg);
  font-weight: 600;
  flex-shrink: 0;
}
.tm-rule-actions {
  display: flex;
  gap: 2px;
  align-items: center;
  flex-shrink: 0;
}
.tm-rule-btn {
  width: 34px;
  height: 34px;
  border-radius: var(--tm-r-2);
  cursor: pointer;
  background: var(--tm-surface-2);
  color: var(--tm-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  outline-offset: 2px;
  border: 1px solid var(--tm-border);
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;
}
.tm-rule-btn:hover {
  color: var(--tm-link);
  background: var(--tm-hover-bg);
  border-color: var(--tm-border-accent-hover);
}
.tm-rule-btn:focus-visible { outline: none; box-shadow: var(--tm-ring); }
.tm-rule-btn[disabled] { opacity: 0.35; cursor: not-allowed; }
.tm-rule-btn svg { display: block; }

.tm-rule-toggle {
  width: 24px;
  height: 24px;
}
.tm-rule-item.disabled {
  background: repeating-linear-gradient(
    135deg,
    transparent 0 10px,
    color-mix(in oklab, var(--tm-text-base) 6%, transparent) 10px 20px
  ), var(--tm-surface-2);
  opacity: 0.9;
  cursor: auto;
}
.tm-rule-item.disabled .tm-rule-pattern { color: var(--tm-muted); }
.tm-rule-item.disabled .tm-rule-type-badge,
.tm-rule-item.disabled .tm-rule-btn {
  color: var(--tm-muted);
  background: transparent;
  border-color: color-mix(in oklab, var(--tm-border) 60%, var(--tm-text-base));
}
.tm-rule-item .tm-rule-actions,
.tm-rule-item .tm-rule-select { cursor: auto; }

.tm-rule-item.selected:not(.disabled) {
  filter: saturate(1.05);
  border-color: color-mix(in oklab, var(--tm-link) 40%, var(--tm-border) 60%);
  background: color-mix(in oklab, var(--tm-surface) 85%, var(--tm-link) 15%);
}
.tm-rule-item.disabled.selected {
  filter: saturate(1.05);
  border-color: color-mix(in oklab, var(--tm-link) 40%, var(--tm-border) 60%);
  background: repeating-linear-gradient(
    135deg,
    transparent 0 10px,
    color-mix(in oklab, var(--tm-text-base) 6%, transparent) 10px 20px
  ), color-mix(in oklab, var(--tm-surface) 85%, var(--tm-link) 15%);
  opacity: 0.9;
  cursor: auto;
}

.tm-rules-controls {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  margin-left: auto;
}

.tm-test-multi-results {
  display: flex;
  flex-direction: column;
  gap: var(--tm-px-2);
  margin-top: var(--tm-px-2);
  border-top: 1px dashed var(--tm-border);
  padding-top: var(--tm-px-2);
  overflow-y: auto;
  max-height: 400px;
}
.tm-test-multi-item {
  padding: var(--tm-px-2);
  border-radius: var(--tm-r-2);
  background: var(--tm-surface-2);
  border: 1px solid var(--tm-border);
}
.tm-test-multi-header {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.tm-test-multi-pattern {
  font-size: 13px;
  font-family: ui-monospace, monospace;
  color: var(--tm-text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tm-test-success,
.tm-test-nomatch,
.tm-test-error {
  padding: var(--tm-px-3);
  border-radius: var(--tm-r-3);
  border: 1px solid var(--tm-border);
  background: var(--tm-surface);
  position: relative;
  color: var(--tm-text);
}
.tm-test-success { border-left: 4px solid var(--tm-ok); }
.tm-test-nomatch { border-left: 4px solid var(--tm-warn); }
.tm-test-error { border-left: 4px solid var(--tm-bad); }
.tm-test-success > strong { color: var(--tm-ok); }
.tm-test-nomatch > strong { color: var(--tm-warn); }
.tm-test-error > strong { color: var(--tm-bad); }

.tm-test-preview {
  margin-top: 8px;
  white-space: pre-wrap;
  overflow: auto;
  max-height: 200px;
  border-top: 1px dashed var(--tm-border);
  padding-top: 8px;
  line-height: 1.45;
}
.tm-test-preview .tm-highlight {
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--tm-link);
  color: var(--tm-bg);
}
.tm-test-details {
  margin-top: 8px;
  font-size: 13px;
  color: var(--tm-muted);
  display: grid;
  gap: 4px;
}
.tm-test-details code {
  padding: 1px 4px;
  border-radius: 4px;
  background: color-mix(in oklab, var(--tm-bg) 92%, var(--tm-text-base) 8%);
  color: var(--tm-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  word-break: break-word;
}

/* ================= Clear Tab ================= */
.tm-clear-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
  gap: 8px 16px;
}
.tm-clear-buttons {
  margin-top: var(--tm-px-3);
  display: flex;
  gap: var(--tm-px-2);
  justify-content: flex-end;
}

/* ================= Config Tab ================= */
#tm-config-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--tm-px-2);
}
.tm-config-section { margin-bottom: var(--tm-px-3); }
.tm-config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: var(--tm-px-3);
}
.tm-config-field {
  padding: var(--tm-px-3);
  border: 1px solid var(--tm-border);
  border-radius: var(--tm-r-2);
  background: var(--tm-bg);
  color: var(--tm-text);
  transition: background 0.12s ease, border-color 0.12s ease;
}
.tm-config-field:hover {
  background: var(--tm-hover-bg);
  border-color: var(--tm-border-accent-hover);
}
.tm-config-error {
  display: none;
  color: var(--tm-bad);
  font-size: 12px;
  margin-top: 4px;
  font-weight: 500;
}
.tm-config-error:not(:empty) { display: block; }
.tm-config-title {
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--tm-text);
}
.tm-config-desc {
  font-size: 13px;
  color: var(--tm-muted);
}
#tm-config-body .tm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--tm-px-2);
}

/* ================= User Select Prevention ================= */
#tm-rule-type-dd .tm-flags-display,
.tm-flags-placeholder,
.tm-dd-current,
.tm-dd-caret,
.tm-flag-chip,
.tm-flag-option-label,
.tm-flags-display * {
  user-select: none;
  -webkit-user-select: none;
}

/* ================= Custom Form Controls ================= */
#tm-management-modal input[type="checkbox"],
#tm-management-modal input[type="radio"] {
  appearance: none;
  -webkit-appearance: none;
  outline: none;
  display: grid;
  place-items: center;
  margin: 0;
  box-sizing: border-box;
  border: 2px solid var(--tm-border);
  background: var(--tm-bg);
  border-radius: 4px;
  vertical-align: middle;
  transition: border-color 0.12s ease, background 0.12s ease, box-shadow 0.12s ease, color 0.12s ease;
}
#tm-management-modal input[type="radio"] { border-radius: 50%; }
#tm-management-modal input[type="checkbox"]:hover,
#tm-management-modal input[type="radio"]:hover {
  border-color: var(--tm-border-accent-hover);
}
#tm-management-modal input[type="checkbox"]:focus-visible,
#tm-management-modal input[type="radio"]:focus-visible {
  box-shadow: var(--tm-ring);
}

#tm-management-modal input[type="checkbox"]::before,
#tm-management-modal input[type="radio"]::before {
  content: "";
  width: 12px;
  height: 12px;
  transform: scale(0);
  transition: transform 0.12s ease;
  background: var(--tm-link);
  display: block;
}
#tm-management-modal input[type="checkbox"]::before { border-radius: 2px; }
#tm-management-modal input[type="radio"]::before { border-radius: 50%; }

#tm-management-modal input[type="checkbox"]:checked,
#tm-management-modal input[type="radio"]:checked {
  border-color: var(--tm-border);
  background: color-mix(in oklab, var(--tm-link) 10%, var(--tm-bg) 90%);
}
#tm-management-modal input[type="checkbox"]:checked::before,
#tm-management-modal input[type="radio"]:checked::before {
  transform: scale(1);
}

/* ================= Rhythm Helpers ================= */
#tm-tab-rules .tm-panel + .tm-panel,
#tm-tab-threads .tm-panel + .tm-panel,
#tm-tab-clear .tm-panel + .tm-panel,
#tm-tab-config .tm-panel + .tm-panel {
  margin-top: var(--tm-px-3);
}

/* ================= Helper Button ================= */
#tm-helper-button {
  position: fixed;
  top: 8px;
  right: 8px;
  z-index: 10000;
  display: flex;
  gap: 8px;
  align-items: flex-end;
  color: var(--tm-text);
  opacity: 1 !important;
  width: max-content;
}

/* ================= Feature Toggles ================= */
.tm-fade-collapsed-on .tm-collapsed:not(.post_preview) {
  opacity: 0.6;
  transition: opacity 0.5s ease;
}
.tm-fade-collapsed-on .tm-collapsed:not(.post_preview):hover { opacity: 1; }

.tm-details-on .post__ophui {
  color: var(--theme_default_postnum);
  padding: 0;
}

.tm-trunc-on .post__number { display: none; }

.no-scroll-touch { touch-action: none; }
`);


// ---------- FILTER ENGINE ----------
class FilterEngine {
    PROPS_FLAG_BUILDER = [
        [FLAGS_BM.OP_INCLUDE, 'if(!p.isOP) return false;'],
        [FLAGS_BM.OP_EXCLUDE, 'if(p.isOP) return false;'],
        [FLAGS_BM.SAGE_INCLUDE, 'if(!p.isSage) return false;'],
        [FLAGS_BM.SAGE_EXCLUDE, 'if(p.isSage) return false;'],
        [FLAGS_BM.MEDIA_INCLUDE, 'if(!p.hasMedia) return false;'],
        [FLAGS_BM.MEDIA_EXCLUDE, 'if(p.hasMedia) return false;'],
        [FLAGS_BM.TO_ME_INCLUDE, 'if(!p.isReplyToMe) return false;'],
        [FLAGS_BM.TO_ME_EXCLUDE, 'if(p.isReplyToMe) return false;'],
        [FLAGS_BM.MY_POST_INCLUDE, 'if(!p.isMyPost) return false;'],
        [FLAGS_BM.MY_POST_EXCLUDE, 'if(p.isMyPost) return false;'],
    ];

    CYR_EXPANDED = {
        'а': '[aа]', 'б': '[bб6]', 'в': '[bв]', 'г': '[rг]', 'д': '[dgд]',
        'е': '[еeё]', 'ё': '[еeё]', 'з': '[з3]', 'и': '[iuий]', 'й': '[iuий]',
        'к': '[kк]', 'м': '[mм]', 'н': '[hн]', 'о': '[oо0]', 'п': '[nп]',
        'р': '[pр]', 'с': '[cс]', 'т': '[tт]', 'у': '[yу]', 'х': '[xх]',
        'ч': '[4ч]', 'ш': '[шщ]', 'щ': '[шщ]', 'ъ': '[bъь]', 'ь': '[bъь]',
    }

    constructor() {
        this.maskMatcherCache = new Map();
        this.compiledThreadFilters = [];
        this.compiledReplyFilters = [];
    }

    // ---------- core helpers ----------

    _loadFilters() {
        const src = (getPreferredRulesScope() === 'board') ? (safeGet(BOARD_DATA_KEY, {}) || {}) : (safeGet(GLOBAL_FILTERS_KEY, {}) || {});
        const threadRules = (src.threadRules || []).filter(r => !r?.disabled);
        const replyRules = (src.replyRules || []).filter(r => !r?.disabled);
        return { threadRules, replyRules };
    }

    _getMaskMatcher(mask) {
        mask = mask >>> 0;
        let fn = this.maskMatcherCache.get(mask);
        if (fn) return fn;

        let body = '';
        for (const [bit, clause] of this.PROPS_FLAG_BUILDER) {
            if (mask & bit) body += clause;
        }
        body += 'return true;';

        fn = new Function('p', body);
        this.maskMatcherCache.set(mask, fn);
        return fn;
    }

    _maskToTextMode(mask) {
        if (mask & FLAGS_BM.GREENTEXT_INCLUDE) return 'only';
        if (mask & FLAGS_BM.GREENTEXT_EXCLUDE) return 'strip';
        return 'all';
    }

    getCompiledThreadFilters() { return this.compiledThreadFilters; }
    getCompiledReplyFilters() { return this.compiledReplyFilters; }

    // ---------- processing ----------

    expandCyrillicInPattern(src) {
        const L = src.length;
        if (L === 0) return '';

        const out = [];
        let i = 0;

        while (i < L) {
            const ch = src[i];

            if (ch === '\\') {
                const next = src[i + 1];

                // \p{...}
                if (next === 'p' && src[i + 2] === '{') {
                    let j = i + 3;
                    while (j < L && src[j] !== '}') j++;
                    out.push(src.slice(i, ++j));
                    i = j;
                    continue;
                }

                // escaped char
                if (i + 1 < L) {
                    out.push(ch, next);
                    i += 2;
                    continue;
                }
            }

            // character class [...]
            if (ch === '[') {
                const start = i++;
                while (i < L) {
                    const c = src[i];
                    if (c === '\\') {
                        i += 2;
                        continue;
                    }
                    i++;
                    if (c === ']') break;
                }
                out.push(src.slice(start, i));
                continue;
            }
            out.push(this.CYR_EXPANDED[ch.toLowerCase()] || ch);
            i++;
        }
        return out.join('');
    }

    buildMaskFromSelections(selectedFlags) {
        let mask = 0;
        if (!selectedFlags) return mask;

        for (const [id, mode] of selectedFlags) {
            const def = FLAG_BY_ID[id];
            if (!def) continue;
            if (mode === 'include' && def.include) mask |= def.include;
            if (mode === 'exclude' && def.exclude) mask |= def.exclude;
        }
        return mask >>> 0;
    }

    // ---------- output ----------

    compileList(rules) {
        if (!Array.isArray(rules) || !rules.length) return [];

        const out = [];
        for (let i = 0; i < rules.length; i++) {
            const built = this.constructFilterObj(rules[i]);
            if (!built) continue;
            out.push({
                pattern: built.pattern,
                desc: built.desc,
                preservePunct: !!built.preservePunct,
                matchProps: built.matchProps,
                textMode: built.textMode,
                propagateTaint: built.propagateTaint
            });
        }
        return out;
    };

    compileActiveFilters() {
        const { threadRules, replyRules } = this._loadFilters();

        this.compiledThreadFilters = this.compileList(threadRules);
        this.compiledReplyFilters = this.compileList(replyRules);

        const poolsT = { all: [], allP: [], only: [], onlyP: [], strip: [], stripP: [] };
        for (const f of this.compiledThreadFilters) {
            const key = (f.textMode === 'only' ? 'only' : f.textMode === 'strip' ? 'strip' : 'all') + (f.preservePunct ? 'P' : '');
            poolsT[key].push(f);
        }

        const poolsR = { all: [], allP: [], only: [], onlyP: [], strip: [], stripP: [] };
        for (const f of this.compiledReplyFilters) {
            const key = (f.textMode === 'only' ? 'only' : f.textMode === 'strip' ? 'strip' : 'all') + (f.preservePunct ? 'P' : '');
            poolsR[key].push(f);
        }

        TEXT_POOLS_T = poolsT;
        TEXT_POOLS_R = poolsR;
    }

    constructFilterObj(ruleObj) {
        if (!ruleObj?.pattern) return null;

        let source = ruleObj.pattern;
        if (typeof source !== 'string' || !source.trim()) return null;

        if (ruleObj.expandCyrillic) {
            source = this.expandCyrillicInPattern(source);
        }

        source = source
            .replace(/!&/g, '(?<!\\p{L})')
            .replace(/&!/g, '(?!\\p{L})')
            .replace(/~/g, '\\S*\\s*?')
            .replace(/\s/g, '\\W');

        const startMatch = source.match(/^#(\d*)\D*(\d*)#/);
        const endMatch = source.match(/@(\d*)\D*(\d*)@$/);

        let leftLow = 0, leftHigh = 5, rightLow = 0, rightHigh = 5;

        if (startMatch) {
            leftLow = parseInt(startMatch[1] || leftLow, 10);
            leftHigh = parseInt(startMatch[2] || leftHigh, 10);
            source = source.slice(startMatch[0].length);
        }

        if (endMatch) {
            rightLow = parseInt(endMatch[1] || rightLow, 10);
            rightHigh = parseInt(endMatch[2] || rightHigh, 10);
            source = source.slice(0, source.length - endMatch[0].length);
        }

        if (leftLow > leftHigh) [leftLow, leftHigh] = [leftHigh, leftLow];
        if (rightLow > rightHigh)[rightLow, rightHigh] = [rightHigh, rightLow];

        if (startMatch && endMatch) {
            source = `(?:^(?:${softAnchorToken}){${leftLow},${leftHigh}}?${source})|(?:${source}(?:${softAnchorToken}){${rightLow},${rightHigh}}?$)`;
        } else if (startMatch) {
            source = `^(?:${softAnchorToken}){${leftLow},${leftHigh}}?${source}`;
        } else if (endMatch) {
            source = `${source}(?:${softAnchorToken}){${rightLow},${rightHigh}}?$`;
        }

        const mask = (ruleObj.flagMask >>> 0) || 0;

        try {
            return {
                pattern: new RegExp(source, ruleObj.flags?.replace(/g/g, '') || 'ui'),
                desc: ruleObj.desc || '',
                flagMask: mask,
                preservePunct: !!ruleObj.preservePunct,
                matchProps: this._getMaskMatcher(mask),
                textMode: this._maskToTextMode(mask),
                propagateTaint: ruleObj.propagateTaint
            };
        } catch (e) {
	        console.error('[abufilter] Failed to construct filter object:', { source: 'filterEngine.constructFilterObj', error: e, stack: e?.stack });
            return null;
        }
    }
}
const filterEngine = new FilterEngine();

// ---------- OPERATIONS MANAGER ----------
class OperationsManager {
    constructor() {
        this._domRaf = 0;
        this._domQueue = new Map();
        this._jsOpsQueue = new Map();
        this._jsOpsRaf = 0;

		this.scheduleSave = this.createDebouncer(() => {
			safeSet(BOARD_DATA_KEY, stateManager.serializeForStorage());
		}, CONFIG.SAVE_DEBOUNCE, true);
    }

    // ---------- debouncer ----------

    createDebouncer(fn, delay, resetOnCall = false) {
        let timeout = null;
        let lastArgs = null;

        const debounced = (...args) => {
            lastArgs = args;
            if (timeout && resetOnCall) {
                clearTimeout(timeout);
                timeout = null;
            }
            if (!timeout) {
                timeout = setTimeout(() => {
                    timeout = null;
                    const argsToUse = lastArgs;
                    lastArgs = null;
                    fn(...argsToUse);
                }, delay);
            }
        };

        debounced.flush = () => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = null;
            }
            if (lastArgs) {
                const argsToUse = lastArgs;
                lastArgs = null;
                fn(...argsToUse);
            }
        };

        debounced.cancel = () => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = null;
            }
            lastArgs = null;
        };

        return debounced;
    }

    // ---------- dom ----------

    _toArray(v) {
        if (v === null) return [];

        const arr = Array.isArray(v) ? v : [v];
        const out = [];

        for (let i = 0; i < arr.length; i++) {
            const t = arr[i];
            if (t === null) continue;
            const s = ('' + t).trim();
            if (s) out.push(s);
        }
        return out;
    }

    _mergeClassList(base, incoming) {
        if (!incoming.length) return base || incoming;
        if (!base || !base.length) return incoming;
        const set = new Set(base);
        for (const c of incoming) set.add(c);
        return Array.from(set);
    }

    _flushDom = () => {
        this._domRaf = 0;
        try {
            for (const [el, v] of this._domQueue) {
                if (!el.isConnected) continue;
                const { text, href, dataset, attrs, classAdd, classRemove } = v;
                if (text !== undefined && el.textContent !== text) el.textContent = text;
                if (href !== undefined && el.getAttribute('href') !== href) el.setAttribute('href', href);
                if (dataset) {
                    for (const k in dataset) {
                        const sval = dataset[k] === null ? '' : '' + dataset[k];
                        if (el.dataset[k] !== sval) el.dataset[k] = sval;
                    }
                }
                if (attrs) {
                    for (const k in attrs) {
                        if (el.getAttribute(k) !== attrs[k]) el.setAttribute(k, attrs[k]);
                    }
                }
                if (classRemove && classRemove.length) el.classList.remove(...classRemove);
                if (classAdd && classAdd.length) el.classList.add(...classAdd);
            }
        } finally {
            this._domQueue.clear();
        }
    }

    queueWrite(el, patch = {}) {
        if (!el) return;

        const prev = this._domQueue.get(el);
        const paClassAdd = patch.classAdd !== undefined ? this._toArray(patch.classAdd) : undefined;
        const paClassRemove = patch.classRemove !== undefined ? this._toArray(patch.classRemove) : undefined;

        if (!prev) {
            if (paClassAdd !== undefined) patch.classAdd = paClassAdd;
            if (paClassRemove !== undefined) patch.classRemove = paClassRemove;
            this._domQueue.set(el, patch);
        } else {
            if (patch.dataset) {
                const ds = prev.dataset || (prev.dataset = {});
                for (const k in patch.dataset) ds[k] = patch.dataset[k];
            }
            if (patch.attrs) {
                const as = prev.attrs || (prev.attrs = {});
                for (const k in patch.attrs) as[k] = patch.attrs[k];
            }
            if (paClassAdd) prev.classAdd = this._mergeClassList(prev.classAdd || [], paClassAdd);
            if (paClassRemove) prev.classRemove = this._mergeClassList(prev.classRemove || [], paClassRemove);
            for (const k in patch) {
                if (k === 'dataset' || k === 'attrs' || k === 'classAdd' || k === 'classRemove') continue;
                prev[k] = patch[k];
            }
        }
        return (this._domRaf ||= requestAnimationFrame(this._flushDom));
    }

    queueWriteWithKelly(el, num, desc) {
        if (!el) return;

        const d = desc || {};
        const cur = el.dataset.kelly || '';
        const n = parseInt(num, 10);

        if (!Number.isFinite(n)) {
            if (cur) {
                d.classRemove = cur;
                d.dataset = { kelly: '' };
                this.queueWrite(el, d);
            } else if (desc) {
                this.queueWrite(el, d);
            }
            return;
        }

        const next = KELLY[n % KELLY_LEN];
        if (cur === next) {
            if (desc) this.queueWrite(el, d);
            return;
        }

        d.dataset = { ...d.dataset, kelly: next };
        d.classAdd = next;
        if (cur) d.classRemove = cur;
        this.queueWrite(el, d);
    }

    // ---------- js ----------

    _flushJsOps = () => {
        const batch = new Map(this._jsOpsQueue);
        this._jsOpsQueue.clear();
        this._jsOpsRaf = 0;
        for (const [_key, op] of batch) {
            try { op.fn.apply(null, op.args); }
            catch (e) { console.error('[abufilter] JS operation error', { source: 'OperationsManager._flushJsOps', error: e, stack: e?.stack}); }
        }
    }

    queueJsOp(key, fn, ...args) {
        const existing = this._jsOpsQueue.get(key);
        if (existing) {
            existing.fn = fn;
            existing.args = args;
        } else {
            this._jsOpsQueue.set(key, { fn, args });
        }
        return (this._jsOpsRaf ||= requestAnimationFrame(this._flushJsOps));
    }

    cancelJsOp(key) {
        this._jsOpsQueue.delete(key);
    }
}
const opsManager = new OperationsManager();

// ---------- EVENT EMITTER ----------
class Emitter {
    constructor() {
        this.listeners = new Map();
    }

    on(event, callback) {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event).add(callback);
        return () => this.off(event, callback);
    }

    off(event, callback) {
        const set = this.listeners.get(event);
        if (!set) return;
        set.delete(callback);
        if (set.size === 0) this.listeners.delete(event);
    }

    emit(event, payload) {
        const set = this.listeners.get(event);
        if (!set) return;
        const listeners = Array.from(set);
        for (const cb of listeners) {
            try { cb(payload); }
            catch (e) { console.error('[abufilter] Event emission error', { source: 'Emitter.emit', error: e, stack: e?.stack}); }
        }
    }
}

// ---------- STATE MANAGER ----------
class StateManager extends Emitter {
    STATE_FLAGS = {
        HIDDEN:          1 << 0,
        COLLAPSED:       1 << 1,
        WHITELIST:       1 << 2,
        MEDIA_COLLAPSED: 1 << 3,
        PASSTHROUGH:     1 << 4,
		SEEN:			 1 << 5
    };

    constructor(opsManager) {
        super();
		this.ops = opsManager;
        this._state = new Map();
        this._headerFirstId = new Map();
        this._postMinIdByText = new Map();
		this._emitQ = [];
		this._emitScheduled = false;
    }

    // ---------- emission queue ----------

	_enqueueEmit(evt) {
		this._emitQ.push(evt);
		if (!this._emitScheduled) {
			this._emitScheduled = true;
            queueMicrotask(this._flushEmits);
		}
	}

	_flushEmits = () => {
		if (!this._emitQ.length) return;

		const batch = this._emitQ.splice(0);
		this._emitScheduled = false;

		for (const ch of batch) {
            if (ch.type) this.emit(ch.type, ch);
		}
	}

    // ---------- state core ----------

    _ensureState(id) {
        let st = this._state.get(id);
        if (!st) {
            st = { flags: 0 };
            this._state.set(id, st);
        }
        return st;
    }

    _updateState(id, flagMask, propName, payload, isSet) {
		if (!id) return;

		const st = isSet ? this._ensureState(id) : this._state.get(id);
		if (!st && !isSet) return;

		const hadFlag = (st.flags & flagMask) !== 0;
		const prevSnapshot = hadFlag ? { ...(st[propName] || {}) } : null;

		if (isSet && hadFlag) {
			const currentData = st[propName] || {};
			const newData = { ...currentData, ...payload };

			let changed = false;
			for (const k in newData) {
				if (currentData[k] !== newData[k]) { changed = true; break; }
			}
			if (!changed) return;
		}

		if (isSet) {
            st[propName] = { ...(st[propName] || {}), ...payload };
            st.flags |= flagMask;
            delete st[propName + 'Deleted'];
        } else {
            if (!hadFlag) return;
            st.flags &= ~flagMask;
            st[propName + 'Deleted'] = { time: Date.now() };
            delete st[propName];
        }

		let hasTombstones = false;
		for (const key in st) {
			if (key.endsWith('Deleted')) {
				hasTombstones = true;
				break;
			}
		}

		if (st.flags === 0 && !hasTombstones) this._state.delete(id);
		else this._state.set(id, st);

		this._enqueueEmit({
			id,
			type: 'state:change',
			state: propName,
			prev: prevSnapshot,
			next: isSet ? { ...(st[propName] || {}) } : null
		});
	}

    // ---------- setters ----------

    setHidden(id, payload = {}) { this._updateState(id, this.STATE_FLAGS.HIDDEN, 'hidden', payload, true); }
    deleteHidden(id) { this._updateState(id, this.STATE_FLAGS.HIDDEN, 'hidden', null, false); }
    isHidden(id) { const st = this._state.get(id); return st && (st.flags & this.STATE_FLAGS.HIDDEN) !== 0; }
    getHidden(id) { const st = this._state.get(id); return st && st.hidden; }

    setCollapsed(id, payload = {}) { this._updateState(id, this.STATE_FLAGS.COLLAPSED, 'collapsed', payload, true); }
    deleteCollapsed(id) { this._updateState(id, this.STATE_FLAGS.COLLAPSED, 'collapsed', null, false); }
    isCollapsed(id) { const st = this._state.get(id); return st && (st.flags & this.STATE_FLAGS.COLLAPSED) !== 0; }
    getCollapsed(id) { const st = this._state.get(id); return st && st.collapsed; }

    setWhitelist(id, payload = {}) { this._updateState(id, this.STATE_FLAGS.WHITELIST, 'whitelist', payload, true); }
    deleteWhitelist(id) { this._updateState(id, this.STATE_FLAGS.WHITELIST, 'whitelist', null, false); }
    isWhitelisted(id) { const st = this._state.get(id); return st && (st.flags & this.STATE_FLAGS.WHITELIST) !== 0; }
    getWhitelist(id) { const st = this._state.get(id); return st && st.whitelist; }

    setMediaCollapsed(id, payload = {}) { this._updateState(id, this.STATE_FLAGS.MEDIA_COLLAPSED, 'mediaCollapsed', payload, true); }
    deleteMediaCollapsed(id) { this._updateState(id, this.STATE_FLAGS.MEDIA_COLLAPSED, 'mediaCollapsed', null, false); }
    isMediaCollapsed(id) { const st = this._state.get(id); return st && (st.flags & this.STATE_FLAGS.MEDIA_COLLAPSED) !== 0; }
    getMediaCollapsed(id) { const st = this._state.get(id); return st && st.mediaCollapsed; }

    setPassthrough(id, payload = {}) { this._updateState(id, this.STATE_FLAGS.PASSTHROUGH, 'passthrough', payload, true); }
    deletePassthrough(id) { this._updateState(id, this.STATE_FLAGS.PASSTHROUGH, 'passthrough', null, false); }
    isPassthrough(id) { const st = this._state.get(id); return st && (st.flags & this.STATE_FLAGS.PASSTHROUGH) !== 0; }

    setSeen(id, payload = {}) { this._updateState(id, this.STATE_FLAGS.SEEN, 'seen', payload, true); }
    deleteSeen(id) { this._updateState(id, this.STATE_FLAGS.SEEN, 'seen', null, false); }
    isSeen(id) { const st = this._state.get(id); return st && (st.flags & this.STATE_FLAGS.SEEN) !== 0; }

	deleteAll(id) {
		if (this._state.has(id)) {
			this._state.delete(id);
			this._enqueueEmit({ id, type: 'state:clear' });
		}
	}

    // ---------- relations ----------

    isTainted(id) {
        const post = Post.get(id);
        if (!post) return { tainted: false };

        const visited = new Set();
        const queue = [];

        for (const pid of post.repliesTo) {
            const key = String(pid);
            if (!this.isPassthrough(key)) queue.push(key);
        }

        for (let i = 0; i < queue.length; i++) {
            const curId = queue[i];
            if (visited.has(curId)) continue;
            visited.add(curId);

            const st = this.getCollapsed(curId);
            if (st && st.propagateTaint === true) {
                return { tainted: true, rootId: curId };
            }

            const postR = Post.get(curId);
            if (postR) {
                for (const pid of postR.repliesTo) {
                    const key = String(pid);
                    if (!this.isPassthrough(key)) queue.push(key);
                }
            }
        }
        return { tainted: false };
    }

    isDuplicate(id) {
        const post = Post.get(id);
        if (!post) return null;

        const text = post.allP;
        if (!text) return false;

        const pid = post.num;

        if (post.isHeader) {
            const firstId = this._headerFirstId.get(text);
            if (firstId === undefined) {
                this._headerFirstId.set(text, pid);
                return false;
            }
            return firstId !== pid;
        }

        const tid = post.threadId;
        if (!tid) return false;

        let threadMap = this._postMinIdByText.get(tid);
        if (!threadMap) {
            threadMap = new Map();
            this._postMinIdByText.set(tid, threadMap);
        }

        const currentNum = Number(pid);
        if (Number.isNaN(currentNum)) {
            if (!threadMap.has(text)) threadMap.set(text, { minNum: Infinity });
            return false;
        }

        const rec = threadMap.get(text);
        if (!rec) {
            threadMap.set(text, { minNum: currentNum });
            return false;
        }

        if (rec.minNum < currentNum) return true;

        if (currentNum < rec.minNum) rec.minNum = currentNum;
        return false;
    }

    // ---------- storage ----------

    loadState() {
        CONFIG = { ...DEFAULT_CONFIG, ...loadConfigFromStorage(getPreferredConfigScope()) };

        const stored = safeGet(BOARD_DATA_KEY, {}) || {};
        const raw = Array.isArray(stored.stateData) ? stored.stateData : [];
        const now = Date.now();
        const fresh = (sub) => sub && sub.time &&
              (now - sub.time) <= (Number(CONFIG.DAYS_TO_KEEP) || DEFAULT_CONFIG.DAYS_TO_KEEP) * 86400000;
        const shouldPersist = (sub) => sub && (sub.reason === 'manual' || !sub.reason);

        const filtered = raw.filter(entry => {
            if (!entry || entry.length !== 2) return false;
            const [id, st] = entry;
            if (!id || !st) return false;
            return (st.whitelist && fresh(st.whitelist)) ||
                (st.hidden && shouldPersist(st.hidden) && fresh(st.hidden)) ||
                (st.collapsed && shouldPersist(st.collapsed) && fresh(st.collapsed)) ||
                (st.mediaCollapsed && fresh(st.mediaCollapsed));
        });
        this._state.clear();
        this.loadFromStorage({ stateData: filtered });
    }

    loadFromStorage(data) {
        if (!data || !Array.isArray(data.stateData)) return;
        for (const entry of data.stateData) {
            if (!entry || entry.length !== 2) continue;
            const [id, st] = entry;
            if (!id) continue;
            this._state.set(id, st);
        }
        //this.emit('state:load', { stateData: data.stateData });
    }

    serializeForStorage() {
        const storedRules = safeGet(BOARD_DATA_KEY, {});
        const out = {
            stateData: [],
            threadRules: Array.isArray(storedRules.threadRules) ? storedRules.threadRules : [],
            replyRules: Array.isArray(storedRules.replyRules) ? storedRules.replyRules : []
        };

        for (const [id, st] of this._state.entries()) {
            if (!id || typeof id !== 'string') continue;
            if (!st || typeof st !== 'object') continue;

            const persistentState = { flags: 0 };

            if (st.whitelist && typeof st.whitelist === 'object') {
                persistentState.whitelist = { ...st.whitelist };
                persistentState.flags |= this.STATE_FLAGS.WHITELIST;
            }
            if (st.hidden && typeof st.hidden === 'object' && st.hidden.reason === 'manual') {
                persistentState.hidden = { ...st.hidden };
                persistentState.flags |= this.STATE_FLAGS.HIDDEN;
            }
            if (st.collapsed && typeof st.collapsed === 'object' && st.collapsed.reason === 'manual') {
                persistentState.collapsed = { ...st.collapsed };
                persistentState.flags |= this.STATE_FLAGS.COLLAPSED;
            }
            if (st.mediaCollapsed && typeof st.mediaCollapsed === 'object' && st.mediaCollapsed.reason === 'manual') {
                persistentState.mediaCollapsed = { ...st.mediaCollapsed };
                persistentState.flags |= this.STATE_FLAGS.MEDIA_COLLAPSED;
            }

            if (persistentState.flags !== 0) {
                out.stateData.push([id, persistentState]);
            }
        }
        return out;
    }

    forEach(fn) {
        for (const [id, st] of this._state.entries()) {
            fn(id, st);
        }
    }
}
const stateManager = new StateManager(opsManager);

// ---------- PROCESSOR ----------
class PostProcessor {
    constructor(stateManager, opsManager) {
        this.state = stateManager;
        this.ops = opsManager;
        this._bound = false;
        this._pendingControlAppends = new Map();
        this._controlAppendScheduled = false;

        this.state.on('state:change', this.handleStateChange);
        this.state.on('state:clear', this.handleStateClear);
    }

    // ---------- init ----------

    initialize() {
        if (this._bound) return;
        this._bound = true;

        this._fmt = this._fmt();
        this._rt = this._rt();

        document.getElementById('js-posts').addEventListener('click', (e) => {
            const collapseBtn = e.target.closest('.tm-collapse-btn');
            if (collapseBtn) {
                const postEl = collapseBtn.closest('.post[data-num]');
                if (!postEl) return;

                const id = String(postEl.dataset.num);
                if (!id) return;
                const post = Post.get(id);
                if (!post) return;

                if (!this.state.isCollapsed(id)) {
                    this.state.deletePassthrough(id);
                    if (this.processPost(post)) {
                        this.toggleCollapsed(post, true, {
                            reason: 'manual',
                            time: Date.now(),
                            propagateTaint: CONFIG.PROPAGATE_TAINT_BY_DEFAULT
                        });
                    }
                } else {
                    if (this.state.getCollapsed(id)?.reason !== 'manual') {
                        this.state.setPassthrough(id);
                    }
                    this.toggleCollapsed(post, false);
                }
                return;
            }

            const mediaBtn = e.target.closest('.tm-media-toggle');
            if (mediaBtn) {
                const postEl = mediaBtn.closest('.post[data-num]');
                if (!postEl) return;

                const id = String(postEl.dataset.num);
                if (!id) return;

                const post = postEl.id.startsWith('preview-') ? Post.getPreview(id) : Post.get(id);
                if (!post) return;

                if (post.isPreview) {
                    this.handleMedia(post, !postEl.classList.contains('tm-media-collapsed'));
                } else if (!this.state.isMediaCollapsed(id)) {
                    this.toggleMedia(post, true, { reason: 'manual', time: Date.now() });
                } else {
                    this.toggleMedia(post, false);
                }
                return;
            }
        }, { capture: true });

        if (greyscale) {
            document.getElementById('js-posts').addEventListener('pointerdown', (e) => {
                const link = e.target.closest('a.js-post-reply-btn.post__reflink, .post-reply-link');
                if (!link) return;

                const id = String(link.dataset.num);
                if (!id) return;

                const pid = String(link.closest('.post[data-num]')?.dataset.num || '');
                if (!pid) return;

				if (!this.state.isSeen(id)) this.toggleSeen(id, true);
				if (!this.state.isSeen(pid)) this.toggleSeen(pid, true);
            }, { passive: true });
        }
    }

    // ---------- controls ----------

    handlePostDetails = {
        [true]: (post) => {
            const details = post.details;
            if (!details || details.dataset.tm_controlsSet) return;
            this._pendingControlAppends.set(details, post);
            if (!this._controlAppendScheduled) {
                this._controlAppendScheduled = true;
                queueMicrotask(() => {
					this._controlAppendScheduled = false;
					if (this._pendingControlAppends.size === 0) return;
					const batch = new Map(this._pendingControlAppends);
					this._pendingControlAppends.clear();
					this.ops.queueJsOp('batch-append-controls', () => {
						for (const [details, post] of batch) {
							if (!details.isConnected || details.dataset.tm_controlsSet) continue;
							details.appendChild(T_POST_CONTROLS.content.cloneNode(true));
							this._fmt(details, post); this._rt(details);
							details.dataset.tm_controlsSet = '1';
                            if (post._pendingSnippet) {
                                this.handleMatchSnippet(post);
                                post._pendingSnippet = null;
                            }
						}
					});
				});
            }
        },
        [null]: (post) => { if (post.el) this._controlsIO.observe(post.el); },
        [false]: (post) => { if (post.el) this._controlsIO.observe(post.el); }
    }

    _controlsIO = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;

            const postEl = entry.target;
            const post = postEl.id.startsWith('preview-') ? Post.getPreview(postEl.dataset.num) : Post.get(postEl.dataset.num);
            if (!post) continue;

            const details = post.details;
            if (!details) continue;
            if (details.dataset.tm_controlsSet) {
                this._controlsIO.unobserve(postEl);
                continue;
            }
            details.appendChild(T_POST_CONTROLS.content.cloneNode(true));

            this._fmt(details, post);
            this._rt(details);

            details.dataset.tm_controlsSet = '1';

            if (post._pendingSnippet) {
                this.handleMatchSnippet(post);
                post._pendingSnippet = null;
            }
            this._controlsIO.unobserve(postEl);
        }
    }, {
        root: null,
        rootMargin: '200px 200px',
        threshold: 0.05,
    });

    _fmt() {
        if (!CONFIG.DETAILS_REFORMAT) {
			if (trunc || colorize) {
				return (_details, post) => {
					const refl = post.refl;
					if (!refl) return;

					const id = post.num;
					this.ops.queueJsOp('fmt-tn-' + id, () => {
						let tn = refl.firstChild;
						if (!tn || tn.nodeType !== 3) {
							tn = document.createTextNode(refl.textContent || '');
							refl.replaceChildren(tn);
						}
						refl._tn = tn;
					});
					const text = trunc ? (post.postNum || (id || refl.textContent).slice(-keep)) : id;
					if (refl.dataset._lastTxt !== text) {
						this.ops.queueJsOp('fmt-txt-' + id, () => {
							const tn = refl._tn || refl.firstChild;
							if (tn && tn.nodeType === 3) {
								tn.data = text;
								refl.dataset._lastTxt = text;
							}
						});
					}
					if (greyscale && this.state.isSeen(id)) {
						this.ops.queueWrite(refl, { classAdd: 'tm-clicked' });
					} else if (colorize) {
						this.ops.queueWriteWithKelly(refl, text);
					}
				};
			} else if (greyscale) {
				return (_details, post) => {
					const refl = post.refl;
					if (!refl) return;
					if (this.state.isSeen(post.num)) {
						this.ops.queueWrite(refl, { classAdd: 'tm-clicked' });
					}
				}
			}
			return () => {};
		}

        const PARTS = new WeakMap();
        const DETAILS_INIT = new WeakSet();
        const ANON_STR = 'Аноним';
        const isSpace = c => c === 32 || c === 160 || c === 9 || c === 10 || c === 13;

        const topPart = (details, node) => {
            if (!node) return null;
            let el = node;
            while (el && el !== details) {
                if (el.parentElement === details && el.classList?.contains('post__detailpart')) return el;
                el = el.parentElement;
            }
            return null;
        };

        const init = (details, post) => {
            if (!details) return {};
            if (DETAILS_INIT.has(details)) return PARTS.get(details);

            const num = details.querySelector('.post__number');
            const mail = details.querySelector('.post__email');
            const anon = details.querySelector('.post__anon');
            const refl = post.refl;

			this.ops.queueWrite(topPart(details, num), { classAdd: 'post__detailpart--num' });
            this.ops.queueWrite(topPart(details, refl), { classAdd: 'post__detailpart--refl' });
            this.ops.queueWrite(topPart(details, details.querySelector('.post__time')), { classAdd: 'post__detailpart--time' });
            this.ops.queueWrite(topPart(details, details.querySelector('.post__ophui')), { classAdd: 'post__detailpart--op' });
            if (mail) this.ops.queueWrite(topPart(details, mail), { classAdd: 'post__detailpart--mail' });

            const hasMailto = !!(mail && (mail.getAttribute('href')||'').startsWith('mailto:'));
            if (hasMailto) {
                const href = mail.getAttribute('href');
                const decoded = decodeURIComponent(href.slice(7).split('?')[0] || '');
                if (decoded && mail.textContent !== decoded) this.ops.queueWrite(mail, { text: decoded });
            }
            if (anon) {
				const idEl = anon.querySelector('[id^="id_tag_"]');
				if (idEl) {
					this.ops.queueJsOp('anon-cleanup-' + post.num, anon.replaceChildren(idEl));
				} else if (!hasMailto) {
					this.ops.queueJsOp('anon-text-cleanup-' + post.num, () => {
						let node = anon.firstChild;
						while (node) {
							const next = node.nextSibling;
							if (node.nodeType === Node.TEXT_NODE) {
								const s = node.data;
								let p = 0;
								while (p < s.length && isSpace(s.charCodeAt(p))) p++;
								if (s.substr(p, ANON_STR.length) === ANON_STR) {
									let q = p + ANON_STR.length;
									while (q < s.length && (s.charCodeAt(q) === 32 || s.charCodeAt(q) === 160)) q++;
									const newText = s.slice(0, p) + s.slice(q);
									if (newText.length) node.data = newText;
									else anon.removeChild(node);
								}
							}
							node = next;
						}
						if (!anon.firstElementChild && anon.textContent.trim() === '') anon.remove();
					});
				}
			}
			if (refl) {
				this.ops.queueJsOp('refl-init-' + post.num, () => {
					let tn = refl.firstChild;
					if (!tn || tn.nodeType !== 3) {
						tn = document.createTextNode(refl.textContent || '');
						refl.replaceChildren(tn);
					}
					refl.dataset._lastTxt = tn.data;
					refl._tn = tn;
				});
			}

            const bundle = { num, refl, mail, anon };
            PARTS.set(details, bundle);
            DETAILS_INIT.add(details);
            return bundle;
        };

        if (trunc || colorize) {
            return (details, post) => {
                const { num, refl } = init(details, post);
                if (refl) {
                    const id = post.num;
                    const text = num?.textContent || id.slice(-keep);
                    if (trunc && refl.dataset._lastTxt !== text) {
                        const tn = refl._tn || refl.firstChild;
                        this.ops.queueJsOp('fmt' + id, () => {
                            (refl._tn || tn).data = text;
                            refl.dataset._lastTxt = text;
                        });
                    }
                    if (greyscale && this.state.isSeen(id)) this.ops.queueWrite(refl, { text, classAdd: 'tm-clicked' });
                    else if (colorize) this.ops.queueWriteWithKelly(refl, trunc ? text : id);
                }
            };
        } else {
            return init;
        }
    }

    _rt() {
        if (!CONFIG.RELATIVE_TIME) return () => {};

        const rtf = Intl.RelativeTimeFormat
			? new Intl.RelativeTimeFormat('ru', { numeric: 'auto', style: 'short' })
			: null;

        const fastParse = (t) => {
            const ts = Date.parse(t);
            if(!isNaN(ts)) return new Date(ts);

            if(t.length < 16) return null;
            const dd = (t.charCodeAt(0)-48)*10 + (t.charCodeAt(1)-48);
            const mm = (t.charCodeAt(3)-48)*10 + (t.charCodeAt(4)-48);
            const yy = (t.charCodeAt(6)-48)*10 + (t.charCodeAt(7)-48);
            const len = t.length;
            const ss = (t.charCodeAt(len-2)-48)*10 + (t.charCodeAt(len-1)-48);
            const mi = (t.charCodeAt(len-5)-48)*10 + (t.charCodeAt(len-4)-48);
            const hh = (t.charCodeAt(len-8)-48)*10 + (t.charCodeAt(len-7)-48);

            if (dd>=0 && dd<=31 && mm>=1 && mm<=12 && yy>=0 && yy<=99 && hh>=0 && hh<24 && mi>=0 && mi<60 && ss>=0 && ss<60) {
                return new Date(2000 + yy, mm - 1, dd, hh, mi, ss);
            }
            return null;
        };

		const pad2 = (n) => (n < 10 ? '0' + n : '' + n);

        const formatAbsolute = (d) => {
            return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
        };

        const formatRelative = (dMs, nowMs) => {
            const s = (dMs - nowMs) / 1000;
            const a = Math.abs(s);
            if (rtf) {
                if (a < 45) return 'только что';
                if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
                if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
                const days = Math.round(s / 86400);
                if (Math.abs(days) === 1) return s < 0 ? 'вчера' : 'завтра';
                if (a < 604800) return rtf.format(days, 'day');
                return rtf.format(Math.round(s / 604800), 'week');
            } else {
                const ago = s < 0 ? 'назад' : 'спустя';
                if (a < 45) return 'только что';
                if (a < 3600) return `${Math.round(a / 60)} мин ${ago}`;
                if (a < 86400) return `${Math.round(a / 3600)} ч ${ago}`;
                const days = Math.round(a / 86400);
                if (days === 1) return s < 0 ? 'вчера' : 'завтра';
                if (days < 7) return `${days} дн ${ago}`;
                return formatAbsolute(new Date(dMs));
            }
        };

        const C = new WeakMap();

        const prime = (el) => {
            let st = C.get(el);
            if (st) return st;
            const abs = el.dataset.tmAbsTime || el.textContent || '';
            if (!el.dataset.tmAbsTime) this.ops.queueWrite(el, { dataset: { tmAbsTime: abs } });

            const d = fastParse(abs);
            if (!d) return null;

			this.ops.queueJsOp('rt-prime-' + (el.id || Math.random()), () => {
				let tn = el.firstChild;
				if (!tn || tn.nodeType !== 3) {
					tn = document.createTextNode(el.textContent || '');
					el.replaceChildren(tn);
				}
				const state = { abs, dateMs: d.getTime(), tn, last: tn.data };
				C.set(el, state);
			});

			const tn = el.firstChild;
			st = { abs, dateMs: d.getTime(), tn, last: tn?.data || abs };
			C.set(el, st);
			return st;
        };

		const updateAll = (root = document) => {
			const nodes = root.getElementsByClassName('post__time');
			if (!nodes.length) return;
			const nowMs = Date.now();

			const updates = [];
			for (let i = 0; i < nodes.length; i++) {
				const el = nodes[i];
				const st = C.get(el) || prime(el);
				if (!st) continue;
				const txt = formatRelative(st.dateMs, nowMs);
				if (txt !== st.last) {
					updates.push({ el, st, txt });
				}
			}
			if (updates.length > 0) {
				this.ops.queueJsOp('rt-update-all', () => {
					for (const { st, txt } of updates) {
						if (st.tn && st.tn.nodeType === 3) {
							st.tn.data = txt;
							st.last = txt;
						}
					}
				});
			}
		};

        let timer = 0;
        const schedule = () => {
            clearTimeout(timer);
            const now = Date.now();
            const untilNext = 60000 - (now % 60000);
            timer = setTimeout(() => {
                updateAll();
                schedule();
            }, untilNext + 5);
        };
        schedule();

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                updateAll();
                schedule();
            } else {
                clearTimeout(timer);
            }
        });

        return (root) => {
            const timeEl = root?.querySelector('.post__time');
            if (!timeEl) return;
            const st = C.get(timeEl) || prime(timeEl);
            if (!st) return;
            const txt = formatRelative(st.dateMs, Date.now());
            if (txt !== st.last) {
                st.tn.data = txt;
                st.last = txt;
            }
        };
    }

    // ---------- events ----------

    handleStateChange = ({ id, state, prev, next }) => {
        if (next?.reason === 'manual' || prev?.reason === 'manual' || state === 'whitelist') this.ops.scheduleSave();

        const post = Post.get(id);
        if (!post) return;

        switch (state) {
            case 'hidden':
                this.handleHidden(post, !!next);
                break;
            case 'collapsed':
				this.handleCollapsed(post, !!next);
				this.reprocessReplies(post);
                break;
            case 'mediaCollapsed':
                this.handleMedia(post, !!next);
                break;
            case 'seen':
                this.handleSeen(post, !!next);
                break;
        }
    };

    handleStateClear = ({ id }) => {
        const post = Post.get(id);
        if (post) {
            this.handleCollapsed(post, false);
            this.handleMedia(post, false);
            this.handleHidden(post, false);
        }
        this.ops.scheduleSave();
    };

    // ---------- actions ----------

	toggleHidden(postOrId, on, state = {}) {
		const id = typeof postOrId === 'object' ? postOrId.num : String(postOrId);
		if (on) {
			this.state.deleteWhitelist(id);
			this.state.setHidden(id, { ...state });
		} else {
			this.state.deleteHidden(id);
			const post = typeof postOrId === 'object' ? postOrId : Post.get(id);
			if (post && post.threadPosts) {
				for (const pid of post.threadPosts) {
					this.processNewPost(Post.get(pid));
				}
			}
		}
		return true;
	}

	toggleCollapsed(postOrId, on, state = {}) {
		const id = typeof postOrId === 'object' ? postOrId.num : String(postOrId);
		if (on) this.state.setCollapsed(id, state);
		else this.state.deleteCollapsed(id);
		return true;
	}

    toggleWhitelist(postOrId, on, state = {}) {
        const id = typeof postOrId === 'object' ? postOrId.num : String(postOrId);
        if (on) {
            const st = this.state.getHidden(id);
            this.state.setWhitelist(id, {
                id,
                time: Date.now(),
                matchChunk: st?.matchChunk,
                fullText: st?.fullText || Post.get(id)?.allP,
                ...state
            });
            if (this.state.isHidden(id)) this.toggleHidden(postOrId, false);
        } else {
            this.state.deleteAll(id);
			this.processPost(Post.get(id));
        }
    }

    toggleMedia(postOrId, on, state = {}) {
        const id = typeof postOrId === 'object' ? postOrId.num : String(postOrId);
        if (on) this.state.setMediaCollapsed(id, state);
        else this.state.deleteMediaCollapsed(id);
    }

    toggleSeen(postOrId, on) {
        const id = typeof postOrId === 'object' ? postOrId.num : String(postOrId);
        if (on) this.state.setSeen(id, { time: Date.now() });
        else this.state.deleteSeen(id);
    }

    // ---------- visual ----------

    handleHidden(post, on) {
        const target = (post.isHeader || post.thread) ? (post.thread || post.el) : post.el;
        if (!target) return;
        if (on) {
            if (currentThreadId !== post.num) this.ops.queueWrite(target, { classAdd: 'tm-hidden' });
        } else {
            this.ops.queueWrite(target, { classRemove: 'tm-hidden' });
        }
    }

    handleCollapsed(post, on) {
        if (!post?.el) return;
        if (on) {
            this.ops.queueWrite(post.el, { classAdd: 'tm-collapsed' });
            this.handleMatchSnippet(post);
        } else if (this.state.isPassthrough(post.num)) {
            this.ops.queueWrite(post.el, { classRemove: 'tm-collapsed' });
        } else {
            this.ops.queueWrite(post.el, { classRemove: 'tm-collapsed' });
            this.handleMatchSnippet(post);
        }
    }

    handleMedia(post, on) {
        const el = post?.el;
        const images = post.images;
        if (!el || !images) return;

        const msg = post.message;
        if (on) {
            this.ops.queueWrite(el, { classAdd: 'tm-media-collapsed' });

            const typeClasses = Array.from(images.classList).filter(c => c.startsWith('post__images_type_'));
            if (typeClasses.length) {
                images.dataset.tmWasTypes = typeClasses.join(' ');
                this.ops.queueWrite(images, { classRemove: typeClasses.join(' ') });
            }
            if (msg) {
                const isEmpty = !/\S/.test((msg.textContent || '').replace(/\u00A0/g, ' ')) &&
                      (msg.children.length === 0 || ([...msg.children].every(c => c.tagName === 'BR')));
                if (isEmpty) this.ops.queueWrite(msg, { classAdd: 'tm-element-hidden' });
            }
        } else {
            this.ops.queueWrite(el, { classRemove: 'tm-media-collapsed' });

            const was = images.dataset.tmWasTypes;
            if (was) {
                this.ops.queueWrite(images, { classAdd: was });
                delete images.dataset.tmWasTypes;
            }
            if (msg) this.ops.queueWrite(msg, { classRemove: 'tm-element-hidden' });
        }
    }

	handleSeen(post, on) {
		if (!greyscale || !post) return;
		const id = post.num;

		const refl = post.refl;
		if (refl) this.ops.queueWrite(refl, on ? { classAdd: 'tm-clicked' } : { classRemove: 'tm-clicked' });

		for (const pid of post.repliesTo) {
			const postR = Post.get(String(pid));
			if (!postR) continue;
			const inLinks = postR.refmap?.querySelectorAll('.post-reply-link') || [];
			for (let i = 0; i < inLinks.length; ++i) {
				const l = inLinks[i];
				if (String(l.dataset.num || '') === id) {
					this.ops.queueWrite(l, on ? { classAdd: 'tm-clicked' } : { classRemove: 'tm-clicked' });
				}
			}
		}
		for (const cid of post.replies) {
            const k = String(cid);
			const postR = Post.get(k);
			if (!postR) continue;
			const outLinks = postR.outLinks || [];
			for (let i = 0; i < outLinks.length; ++i) {
				const l = outLinks[i];
				if (String(l.dataset.num || '') === id) {
					this.ops.queueWrite(l, on ? { classAdd: 'tm-clicked' } : { classRemove: 'tm-clicked' });
				}
			}
            const st = this.state.getCollapsed(k);
            if (st && st.reason === 'tainted' && st.desc === id) {
                this.ops.queueWrite(postR.el?.querySelector('.tm-snippet-part a.post-reply-link'), on ? { classAdd: 'tm-clicked' } : { classRemove: 'tm-clicked' });
            }
		}
	}

    handleMatchSnippet(post) {
		if (!post) return;

        const wrap = post.el?.querySelector('.tm-snippet-part');
        if (!wrap) {
			post._pendingSnippet = true;
            return;
        }

        const link = wrap.querySelector('a.post-reply-link');
        const snippet = wrap.querySelector('.tm-match-snippet--text');
        if (!link || !snippet) return;

        if (!this.state.isCollapsed(post.num)) {
            this.ops.queueWrite(link, { classAdd: 'tm-element-hidden' });
            this.ops.queueWrite(snippet, { classAdd: 'tm-element-hidden' });
            return;
        }

		const st = this.state.getCollapsed(post.num);
		const text = st.desc || st.snippet || st.reason || '';
        if (st.reason === 'tainted') {
            const threadId = post.threadId || '';
            const n = trunc ? String(Post.get(text)?.postNum || text.slice(-keep)) : text;

            const baseConfig = {
                text: `>>${n}`,
                href: `/${BOARD_ID}/res/${threadId}.html#${text}`,
                dataset: { num: text, thread: threadId },
                classRemove: 'tm-element-hidden'
            };

            if (greyscale && this.state.isSeen(text)) {
                this.ops.queueWrite(link, { ...baseConfig, classAdd: 'tm-clicked' });
            } else if (colorize) {
                this.ops.queueWriteWithKelly(link, n, baseConfig);
            } else {
                this.ops.queueWrite(link, baseConfig);
            }
            this.ops.queueWrite(snippet, { classAdd: 'tm-element-hidden' });

        } else {
            this.ops.queueWrite(link, { classAdd: 'tm-element-hidden' });
            this.ops.queueWrite(snippet, {
                text: `(${DESC_MAP[text] || (text.length > CONFIG.MAX_SNIPPET_LENGTH ? text.slice(0, CONFIG.MAX_SNIPPET_LENGTH) + '...' : text)})`,
                classRemove: 'tm-element-hidden'
            });
        }
    }

    // ---------- processors ----------

    registerNewPost(p) { return this.processNewPost(new Post(p)); }

    processNewPost(post) {
        if (!post) return false;

        const id = post.num;
        const threadId = post.threadId;

        if (!currentThreadId && this.state.isHidden(threadId)) {
            if (id === threadId) this.handleHidden(post, true);
            return false;
        }

		if (this.state.isCollapsed(id)) this.handleCollapsed(post, true);
        if (this.state.isMediaCollapsed(id)) {
			this.handleMedia(post, true);
		} else if (post.isHeader ? CONFIG.AUTO_COLLAPSE_MEDIA_H : CONFIG.AUTO_COLLAPSE_MEDIA_P) {
			this.toggleMedia(post, true, { reason: 'auto', time: Date.now() });
		}

		const isMyPost = post.isMyPost;
        if (isMyPost && !this.state.isSeen(id)) {
            this.toggleSeen(id, true);

            if (CONFIG.WHITELIST_PARTICIPATED) {
                const st = this.state.getHidden(threadId);
                if (!st || st.reason !== 'manual') this.toggleWhitelist(threadId, true);
            }
        }

        if (trunc || colorize || greyscale) {
            const outLinks = post.outLinks || [];
            for (let i = 0; i < outLinks.length; ++i) {
                const l = outLinks[i];
                const rid = String(l.dataset.num || '');
                const postR = Post.get(rid);

                if (isMyPost) this.toggleSeen(rid, true);
                if (trunc) {
	                const n = String(postR?.postNum || rid.slice(-keep));
                    const txt = (rid === threadId) ? '>>OP' : `>>${n}` + (postR?.isMyPost ? ' (You)' : '');
			        if (greyscale && this.state.isSeen(rid)) {
			            this.ops.queueWrite(l, { text: txt, classAdd: 'tm-clicked' });
			        } else if (colorize) {
			            this.ops.queueWriteWithKelly(l, n, { text: txt });
			        } else {
			            this.ops.queueWrite(l, { text: txt });
			        }
                } else if (greyscale && this.state.isSeen(rid)) {
                    this.ops.queueWrite(l, { text: `>>${rid}` + (postR?.isMyPost ? ' (You)' : ''), classAdd: 'tm-clicked' });
                } else if (colorize) {
                    this.ops.queueWriteWithKelly(l, postR?.postNum || rid);
                }
            }
        }
        this.handlePostDetails[CONFIG.INSTANT_DETAILS || null]?.(post);

        return (this.state.isCollapsed(id) ? false : this.processPost(post));
    }

    processPost(post) {
        if (!post) return false;

        const id = post.num;
        if (currentThreadId !== id && !this.state.isWhitelisted(id)) {
            if (this.state.isPassthrough(id)) return true;

            const isHeader = post.isHeader;
			if (isHeader ? this.state.getHidden(id)?.reason === 'manual'
						: this.state.getCollapsed(id)?.reason === 'manual') return false;
			const matchResult = post.getMatch();

			if (matchResult?.matched) {
				const { desc, matched, filter, propagateTaint } = matchResult;
				if (isHeader) {
					this.toggleHidden(post, true, {
						reason: 'filtered',
						desc,
						filter,
						fullText: post.allP,
						time: Date.now()
					});
				} else {
					this.toggleCollapsed(post, true, {
						reason: 'filtered',
						desc,
						snippet: matched[0],
						time: Date.now(),
						propagateTaint: propagateTaint !== undefined ? propagateTaint : CONFIG.PROPAGATE_TAINT_BY_DEFAULT
					});
				}
				return false;
			}

			if (!isHeader && CONFIG.HIDE_DUP_POSTS && this.state.isDuplicate(id)) {
				this.toggleCollapsed(post, true, {
					reason: 'duplicate-post',
					time: Date.now(),
					propagateTaint: CONFIG.PROPAGATE_TAINT_BY_DEFAULT
				});
				return false;
			}
			if (isHeader && CONFIG.HIDE_DUP_THREADS && this.state.isDuplicate(id)) {
				this.toggleHidden(post, true, {
					reason: 'duplicate',
					fullText: post.allP,
					time: Date.now()
				});
				return false;
			}

			if (!isHeader) {
				const taintResult = this.state.isTainted(id);
				if (taintResult.tainted) {
					this.toggleCollapsed(post, true, {
						reason: 'tainted',
						time: Date.now(),
						desc: taintResult.rootId,
						propagateTaint: true
					});
					return false;
				}
			}
        }
		if (this.state.isCollapsed(id)) {
            if (this.state.getCollapsed(id)?.reason !== 'manual') {
                this.toggleCollapsed(post, false);
            } else {
                return false;
            }
        } else if (this.state.isHidden(id)) {
            if (this.state.getHidden(id)?.reason !== 'manual') {
                this.toggleHidden(post, false);
            } else {
                return false;
            }
        }
        return true;
    }

    reprocessReplies(post) {
        if (!post) return;
        const pcst = this.state.isCollapsed(post.num);
        for (const cid of post.replies) {
            const key = String(cid);
            if (!this.state.isPassthrough(key) && this.state.isCollapsed(key) !== pcst) {
                const postC = Post.get(key);
                if (!postC) continue;

                const t = this.state.isTainted(key);
                if (t.tainted) {
                    if (!this.state.getCollapsed(key)) {
                        this.toggleCollapsed(postC, true, {
                            reason: 'tainted',
                            time: Date.now(),
                            desc: t.rootId,
                            propagateTaint: true
                        });
                    }
                } else if (this.state.getCollapsed(key)?.reason === 'tainted') {
                    this.toggleCollapsed(postC, false);
                }
            }
        }
    }
}
const postProcessor = new PostProcessor(stateManager, opsManager);

// ---------- CROSS-TAB SYNC ----------
class CrossTabSync {
    constructor(postProcessor, stateManager, opsManager, filterEngine) {
        this.reconcile = opsManager.createDebouncer(this._reconcile, 100, true);
        this.processor = postProcessor;
        this.state = stateManager;
        this.ops = opsManager;
        this.engine = filterEngine;
        this._snapshot = null;
    }

    // ---------- signatures ----------

    _sig(obj) { return h32(JSON.stringify(obj ?? null)); }

    _stateSig(stateData) {
        if (!Array.isArray(stateData)) return h32('[]');

        const entries = [];
        for (let i = 0; i < stateData.length; i++) {
            const e = stateData[i];
            if (!e || e.length !== 2 || e[0] === null) continue;

            const id = String(e[0]);
            const st = e[1] || {};

            let parts = `f=${st.flags >>> 0}`;

            if (st.whitelist) parts += `|w=${this._enc(st.whitelist.id ?? id)}`;
            if (st.hidden) parts += `|h=${this._enc(st.hidden.reason)}|${st.hidden.propagateTaint ? '1' : '0'}`;
            if (st.collapsed) parts += `|c=${this._enc(st.collapsed.reason)}|${st.collapsed.propagateTaint ? '1' : '0'}`;
            if (st.mediaCollapsed) parts += `|m=${this._enc(st.mediaCollapsed.id ?? id)}|${this._enc(st.mediaCollapsed.reason)}`;

            entries.push([id, parts]);
        }
        entries.sort(this._binSort);

        let s = '';
        for (let i = 0; i < entries.length; ++i) {
            s += this._enc(entries[i][0]) + '|' + entries[i][1];
        }
        return h32(s);
    }

    _rulesSig(threadRules, replyRules) {
        const processRules = (rules) => {
            if (!Array.isArray(rules)) return [];

            const temp = [];
            for (let i = 0; i < rules.length; i++) {
                const x = rules[i];
                if (!x || x.disabled) continue;

                const p = String(x.pattern || '');
                const f = String(x.flags || '');
                const d = String(x.desc || '');

                const sortKey = `${p}\x1f${f}\x1f${d}`;
                const serialized =
                      this._enc(p) + '|' +
                      this._enc(f) + '|' +
                      this._enc(d) + '|' +
                      (x.flagMask >>> 0) + '|' +
                      (x.preservePunct ? '1' : '0') + '|' +
                      (x.expandCyrillic ? '1' : '0') + '|' +
                      (x.propagateTaint === true ? '1' : '0');
                temp.push([sortKey, serialized]);
            }
            temp.sort(this._binSort);

            const result = new Array(temp.length);
            for (let i = 0; i < temp.length; i++) result[i] = temp[i][1];
            return result;
        };

        const tArr = processRules(threadRules);
        const rArr = processRules(replyRules);
        const final = `t[${tArr.length}]:${tArr.join(';')}|r[${rArr.length}]:${rArr.join(';')}`;

        return h32(final);
    }

    // ---------- util ----------

    _enc(v) {
        if (v === null || v === undefined) return '0:';
        const s = String(v); return `${s.length}:${s}`;
    };

    _binSort(a, b) { return (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); }

	_toMap(arr) {
		const out = new Map();
		if (!Array.isArray(arr)) return out;
		for (const entry of arr) {
			if (!Array.isArray(entry) || entry.length < 2) continue;
			out.set(String(entry[0]), entry[1]);
		}
		return out;
	}

    _getTime(st, field) { return st?.[field]?.time || 0; }

    _takeSnapshot() {
        const board = safeGet(BOARD_DATA_KEY, {}) || {};
        const stateRaw = Array.isArray(board.stateData) ? board.stateData : [];
        const filters = this._readEffectiveFilters();
        const cfgObj = safeGet(getConfigStorageKey(getPreferredConfigScope()), {}) || {};

        return {
            stateSig: this._stateSig(stateRaw),
            filtersSig: this._rulesSig(filters.threadRules, filters.replyRules),
            configSig: this._sig(cfgObj),
            scope: safeGet(RULES_SCOPE_KEY, 'global'),
            stateRaw,
            cfgObj
        };
    }

    // ---------- change handlers ----------

    _readEffectiveFilters() {
        if (safeGet(RULES_SCOPE_KEY, 'global') === 'board') {
            const bd = safeGet(BOARD_DATA_KEY, {}) || {};
            return {
                threadRules: Array.isArray(bd.threadRules) ? bd.threadRules : [],
                replyRules: Array.isArray(bd.replyRules) ? bd.replyRules : []
            };
        }
        const gd = safeGet(GLOBAL_FILTERS_KEY, {}) || {};
        return {
            threadRules: Array.isArray(gd.threadRules) ? gd.threadRules : [],
            replyRules: Array.isArray(gd.replyRules) ? gd.replyRules : []
        };
    }

    _applyFilterChanges() {
        this.engine.compileActiveFilters();

        const headers = [];
        const replies = [];

        for (const id in mPosts) {
            const post = Post.get(id); if (!post) continue;
            if (post.isHeader) headers.push(String(id));
            else replies.push(String(id));
        }

        let countH = 0;
        const stepHeaders = () => {
            const deadlineH = performance.now() + CONFIG.BATCH_PROCESS_FRAME_BUDGET_MS;
            let i = countH;

            while (i < headers.length) {
                const curId = headers[i];
                const post = Post.get(curId);
                i++;
                if (!post) continue;

                if (CONFIG.AUTO_COLLAPSE_MEDIA_H) {
                    this.processor.toggleMedia(post, true, { reason: 'auto', time: Date.now() });
                } else if (this.state.getMediaCollapsed(curId)?.reason !== 'manual') {
                    this.processor.toggleMedia(post, false);
                }
                this.processor.processPost(post);

                if ((i & 7) === 0 && performance.now() >= deadlineH) break;
            }

            countH = i;
            if (countH < headers.length) {
                runIdle(stepHeaders, { timeout: 100 });
            } else {
                let countR = 0;
                const stepReplies = () => {
                    const deadlineR = performance.now() + CONFIG.BATCH_PROCESS_FRAME_BUDGET_MS;
                    let j = countR;

                    while (j < replies.length) {
                        const curIdR = replies[j];
                        const post = Post.get(curIdR);
                        j++;
                        if (!post) continue;

                        if (CONFIG.AUTO_COLLAPSE_MEDIA_P) {
                            this.processor.toggleMedia(post, true, { reason: 'auto', time: Date.now() });
                        } else if (this.state.getMediaCollapsed(curIdR)?.reason !== 'manual') {
                            this.processor.toggleMedia(post, false);
                        }
                        this.processor.processPost(post);

                        if ((j & 7) === 0 && performance.now() >= deadlineR) break;
                    }
                    countR = j;
                    if (countR < replies.length) runIdle(stepReplies, { timeout: 100 });
                };
                runIdle(stepReplies, { timeout: 100 });
            }
        };

        runIdle(stepHeaders, { timeout: 100 });
    }

    _applyConfigChanges(prevCfg, nextCfg, reprocess = false) {
        CONFIG = { ...DEFAULT_CONFIG, ...loadConfigFromStorage(getPreferredConfigScope()) };

        if (prevCfg.MANAGER_BUTTON_POSITION !== nextCfg.MANAGER_BUTTON_POSITION) {
            applyManagerButtonPosition(CONFIG.MANAGER_BUTTON_POSITION);
        }
        if (prevCfg.PROPAGATE_TAINT_BY_DEFAULT !== nextCfg.PROPAGATE_TAINT_BY_DEFAULT) {
            this.state.forEach((id, st) => {
                if (st.collapsed?.reason === 'manual') {
                    this.processor.toggleCollapsed(id, true, {
                        reason: 'manual',
                        time: st.collapsed.time || Date.now(),
                        propagateTaint: nextCfg.PROPAGATE_TAINT_BY_DEFAULT
                    });
                }
            });
            this._applyFilterChanges();
        } else if ((prevCfg.AUTO_COLLAPSE_MEDIA_H !== nextCfg.AUTO_COLLAPSE_MEDIA_H) ||
                (prevCfg.AUTO_COLLAPSE_MEDIA_P !== nextCfg.AUTO_COLLAPSE_MEDIA_P) ||
                (prevCfg.HIDE_DUP_THREADS !== nextCfg.HIDE_DUP_THREADS) ||
                (prevCfg.HIDE_DUP_POSTS !== nextCfg.HIDE_DUP_POSTS) || reprocess) {
            this._applyFilterChanges();
        }
        updatePostStyle();
    }

    _applyStateChanges(oldStateData, newStateData) {
        const oldMap = this._toMap(oldStateData);
        const newMap = this._toMap(newStateData);
        const ids = new Set([...oldMap.keys(), ...newMap.keys()]);

        for (const id of ids) {
            const prev = oldMap.get(id);
            const next = newMap.get(id);

            if (this._sig(prev) === this._sig(next)) continue;

            const curr = this.state._state.get(id);

			if (next?.whitelist && (!curr?.whitelist || this._getTime(next, 'whitelist') > this._getTime(curr, 'whitelist'))) {
				this.state.setWhitelist(id, next.whitelist);
				if(this.state.isHidden(id)) this.state.deleteHidden(id);
			} else if (curr?.whitelist
					&& (!next?.whitelist || (next?.whitelistDeleted?.time || 0) > this._getTime(curr, 'whitelist'))) {
				this.state.deleteWhitelist(id);
			}

			if (next?.hidden && next.hidden.reason === 'manual') {
				if (!curr?.hidden || this._getTime(next, 'hidden') > this._getTime(curr, 'hidden')) {
					this.state.setHidden(id, next.hidden);
				}
			} else if (curr?.hidden && curr.hidden.reason === 'manual'
					&& (!next?.hidden || (next?.hiddenDeleted?.time || 0) > this._getTime(curr, 'hidden'))) {
				this.state.deleteHidden(id);
			}

			if (next?.collapsed && next.collapsed.reason === 'manual') {
				if (!curr?.collapsed || this._getTime(next, 'collapsed') > this._getTime(curr, 'collapsed')) {
					this.state.setCollapsed(id, next.collapsed);
				}
			} else if (curr?.collapsed && curr.collapsed.reason === 'manual'
					&& (!next?.collapsed || (next?.collapsedDeleted?.time || 0) > this._getTime(curr, 'collapsed'))) {
				this.state.deleteCollapsed(id);
			}

			if (next?.mediaCollapsed && next.mediaCollapsed.reason === 'manual') {
				if (!curr?.mediaCollapsed || this._getTime(next, 'mediaCollapsed') > this._getTime(curr, 'mediaCollapsed')) {
					this.state.setMediaCollapsed(id, next.mediaCollapsed);
				}
			} else if (curr?.mediaCollapsed && curr.mediaCollapsed.reason === 'manual'
					&& (!next?.mediaCollapsed || (next?.mediaCollapsedDeleted?.time || 0) > this._getTime(curr, 'mediaCollapsed'))) {
				this.state.deleteMediaCollapsed(id);
			}
        }
    }

    _reconcile = () => {
        if (!this._snapshot) return;

        const current = this._takeSnapshot();
        const sigs = {
            state: this._snapshot.stateSig !== current.stateSig,
            filters: this._snapshot.filtersSig !== current.filtersSig,
            scope: this._snapshot.scope !== current.scope,
            config: this._snapshot.configSig !== current.configSig
        };
        if (!sigs.state && !sigs.filters && !sigs.scope && !sigs.config) return;

        if (sigs.scope || sigs.filters) this.engine.compileActiveFilters();

        if (sigs.config) this._applyConfigChanges(this._snapshot.cfgObj, current.cfgObj, sigs.scope || sigs.filters);
        else if (sigs.scope || sigs.filters) this._applyFilterChanges();
        if (sigs.state) this._applyStateChanges(this._snapshot.stateRaw, current.stateRaw);

        this._snapshot = current;

        this.state.emit('sync:reconciled', { sigs });
    }

    initialize() {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                this._snapshot = this._takeSnapshot();
            } else if (document.visibilityState === 'visible') {
                this._reconcile();
            }
        });
        globalThis.addEventListener('storage', (e) => {
            if (!e?.key) return;
            if ([
                BOARD_DATA_KEY,
                GLOBAL_FILTERS_KEY,
                RULES_SCOPE_KEY,
                getConfigStorageKey('board'),
                getConfigStorageKey('global')
            ].includes(e.key)) {
                this.reconcile();
            }
        });
        this._snapshot = this._takeSnapshot();
    }
}
const crossTabSync = new CrossTabSync(postProcessor, stateManager, opsManager, filterEngine);

// ---------- POST CLASS ----------
class Post {
    static _cache = new Map();
    static _pcache = new Map();

    static _previewProto = (() => {
        const proto = Object.create(Post.prototype);
        Object.defineProperties(proto, {
            el: {
                get() { return document.getElementById('preview-' + this.num) || null; },
                configurable: true
            },
            details: {
                get() { return this.el?.querySelector('.post__details') || null; },
                configurable: true
            },
            message: {
                get() { return this.el?.querySelector('.post__message') || null; },
                configurable: true
            },
            refmap: {
                get() { return this.el?.querySelector('.post__refmap') || null; },
                configurable: true
            },
            outLinks: {
                get() { return this.message?.querySelectorAll('.post-reply-link') || null; },
                configurable: true
            },
            images: {
                get() { return this.el?.querySelector('.post__images') || null; },
                configurable: true
            },
            refl: {
                get() { return this.details?.querySelector('a.js-post-reply-btn.post__reflink[data-num]') || null; },
                configurable: true
            }
        });
        return proto;
    })();

    static get(id) { return Post._cache.get(String(parseInt(id, 10) || '')); }

    static getPreview(id) {
        const key = 'p' + String(parseInt(id, 10));
        let preview = Post._pcache.get(key);

        if (!preview) {
            const post = Post.get(id);
            if (!post) return null;

            preview = Object.create(Post._previewProto);
            Object.assign(preview, {
                num: post.num,
                rec: post.rec,
                comment: post.comment,
                threadId: post.threadId,
                postNum: post.postNum,
                isOP: post.isOP,
                isHeader: post.isHeader,
                isSage: post.isSage,
                isPreview: true,
                hasMedia: post.hasMedia,
                _cache: {}
            });
            Post._pcache.set(key, preview);
        }
        return preview;
    }

    constructor(p) {
        if (!p?.num) return;

        const key = String(parseInt(p.num, 10));
        const parentId = String(parseInt(p.parent, 10) || key);

        this.num = key;
        this.rec = mPosts[p.num];
        this.comment = p.comment ?? null;
        this.threadId = parentId;
        this.postNum = currentThreadId && (p.number != null ? String(p.number) : null);

        this.isOP = p.op === 1 || parentId === key;
        this.isHeader = parentId === key;
        this.isSage = !!(p.email && p.email.indexOf && p.email.indexOf('mailto:sage') !== -1);
        this.isPreview = false;
        this.hasMedia = !!(p.files && p.files.length) || !!p.video;

        this._cache = {};

        Post._cache.set(key, this);
    }

    get el() { return (this._cache.el ??= document.getElementById('post-' + this.num)) || null; }
    get thread() { return (this._cache.thread ??= document.getElementById('thread-' + this.threadId)) || null; }
    get details() { return (this._cache.details ??= document.getElementById('post-details-' + this.num)) || null; }
    get message() { return (this._cache.message ??= document.getElementById('m' + this.num))|| null; }
    get refmap() { return (this._cache.refmap ??= document.getElementById('refmap-' + this.num)) || null; }
    get outLinks() { return (this._cache.outLinks ??= this.message?.querySelectorAll('.post-reply-link')) || []; }
    get images() { return (this._cache.images ??= this.el?.querySelector('.post__images')) || null; }
    get refl() { return (this._cache.refl ??= this.details?.querySelector('a.js-post-reply-btn.post__reflink[data-num]')) || null; }

    get replies() { return this.rec.replies || []; }
    get repliesTo() { return this.rec.repliesTo || []; }
    get threadPosts() { return this.rec.threadPosts || []; }

    get isMyPost() { return (this._cache.isMyPost ??= !!this.el?.classList.contains('post_type_watched')); }
    get isReplyToMe() { return (this._cache.isReplyToMe ??= !!this.el?.classList.contains('post_type_replied')); }

    // ---------- text / matching ----------

    getText(preservePunct, mode) {
        const html = this.comment;
        if (!html) return null;

        const ck = (preservePunct ? 4 : 0) | mode;
        if (this._cache[ck] !== undefined) return this._cache[ck];

        let stripped = html;

        if (mode === 0) {
            stripped = html.replace(/<a[^>]*class="post-reply-link"[^>]*>.*?<\/a>/gi, '');
        } else if (mode === 1) {
            stripped = html.replace(REPLY_OR_GREEN_RE, '');
        } else if (mode === 2) {
            const parts = [];
            html.replace(GREEN_SPAN_RE, (_, inner) => {
                if (inner) parts.push(inner);
            });
            stripped = parts.length ? parts.join('\n') : '';
        }

        const decoded = decode(stripped).replace(TAG_OR_BR_RE, (_m, br) => br ? '\n' : '').trim();
        const noPunct = decoded.replace(PUNCT_RE, '');

        this._cache[4 | mode] = decoded;
        this._cache[0 | mode] = noPunct;

        return preservePunct ? decoded : noPunct;
    }

	get all() { return this.getText(false, 0); }
	get allP() { return this.getText(true, 0); }
	get strip() { return this.getText(false, 1); }
	get stripP() { return this.getText(true, 1); }
	get only() { return this.getText(false, 2); }
	get onlyP() { return this.getText(true, 2); }

    getMatch() {
        const pools = this.isHeader ? TEXT_POOLS_T : TEXT_POOLS_R;

        for (let k = 0; k < TEXT_POOL_KEYS.length; k++) {
            const key = TEXT_POOL_KEYS[k];
            const filters = pools[key];
            if (!filters || !filters.length) continue;

            const text = this[key] || '';
            for (const filter of filters) {
                if (!filter.matchProps(this)) continue;
                const m = filter.pattern.exec(text);
                if (m) {
                    return {
                        matched: m,
                        filter,
                        desc: filter.desc,
                        propagateTaint: filter.propagateTaint
                    };
                }
            }
        }
        return { matched: false };
    }
}


// ---------- UI MANAGEMENT ----------
const openModal = (() => {
	let isOpen = false, isTransitioning = false, pendingAction = null;

	const activeTimers = new Set();
	const notifyTimers = new Set();
	const normalizeCache = new Map();

	return (defaultTab = 'threads') => {
		if (isTransitioning) {
			pendingAction = defaultTab;
			return;
		}

		const existing = document.getElementById('tm-management-overlay');
		if (existing) {
			isTransitioning = true;
			activeTimers.forEach(id => clearTimeout(id));
			activeTimers.clear();
			normalizeCache.clear();

			existing.remove();
			document.documentElement.style.overflow = '';
			document.body.style.overflow = '';
			isOpen = false;

			const timer = setTimeout(() => {
				isTransitioning = false;
				activeTimers.delete(timer);
				if (pendingAction !== null) {
					const action = pendingAction;
					pendingAction = null;
					openModal(action);
				}
			}, 100);
			activeTimers.add(timer);
			return;
		}

		if (isOpen) return;
		isOpen = true;
		isTransitioning = true;

		/* ================== UTILS ================== */
		const qs = (root, sel) => root?.querySelector(sel);
		const qsa = (root, sel) => root ? Array.from(root.querySelectorAll(sel)) : [];
		const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);
		const setText = (el, txt) => { if (el) el.textContent = txt; };
		const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

		const sanitizeNumber = (raw, def) => {
			const toNum = (val) => {
				if (typeof val === 'number' && Number.isFinite(val)) return val;
				const s = String(val ?? '').trim();
				if (s === '') return NaN;
				const cleaned = s
					.replace(/[\s_]/g, '')
					.replace(/(?<=\d),(?=\d)/g, '.')
					.replace(/^[^\d+\-\.]+|[^\d\.]+$/g, '');
				return Number.parseFloat(cleaned);
			};

			const nFloat = toNum(raw);
			if (!Number.isFinite(nFloat)) return { error: 'Должно быть числом' };
			const n = Math.round(nFloat);

			const min = Number.isFinite(def?.min) ? def.min : -Infinity;
			const max = Number.isFinite(def?.max) ? def.max : Infinity;
			if (n < min || n > max) return { error: `От ${min} до ${max}` };

			return n;
		};

		const resetScrollLocks = () => {
			document.documentElement.style.overflow = '';
			document.body.style.overflow = '';
		};

		const inThread = (threadContainer, id) => {
			if (!threadContainer || !id) return false;
			const post = Post.get(id);
			return !!(post && post.thread === threadContainer);
		};

		const createDropdown = ({ container, options, initialValue, onChange, renderOption = (opt) => opt.label, getValue = (opt) => opt.value }) => {
			const displayBtn = qs(container, '.tm-flags-display');
			const menu = qs(container, '.tm-flags-dropdown');
			const currentText = qs(container, '.tm-dd-current');

			if (!displayBtn || !menu || !currentText) return { getValue: () => initialValue, setValue: () => {}, close: () => {} };

			let selectedValue = initialValue;

			const render = () => {
				const selected = options.find(o => getValue(o) === selectedValue);
				currentText.textContent = selected ? renderOption(selected) : '';

				menu.innerHTML = options.map(opt => {
					const val = getValue(opt);
					const isSelected = val === selectedValue;
					return `<div class="tm-flag-option ${isSelected ? 'selected' : ''}" data-value="${escapeHtml(String(val))}" tabindex="0" role="option" aria-selected="${isSelected}"><div class="tm-flag-option-label"><div class="tm-flag-option-name">${escapeHtml(renderOption(opt))}</div></div></div>`;
				}).join('');
			};

			const close = () => {
				menu.classList.remove('tm-open');
				menu.setAttribute('aria-expanded', 'false');
				menu.setAttribute('aria-hidden', 'true');
				displayBtn.setAttribute('aria-expanded', 'false');
			};
			const open = () => {
				const allMenus = qsa(document, '.tm-flags-dropdown.tm-open');
				for (let i = 0; i < allMenus.length; i++) {
					const m = allMenus[i];
					if (m !== menu) {
						m.classList.remove('tm-open');
						m.setAttribute('aria-expanded', 'false');
						m.setAttribute('aria-hidden', 'true');
						const b = m.closest('.tm-flags-multiselect')?.querySelector('.tm-flags-display');
						if (b) b.setAttribute('aria-expanded', 'false');
					}
				}
				menu.classList.add('tm-open');
				menu.setAttribute('aria-expanded', 'true');
				menu.setAttribute('aria-hidden', 'false');
				displayBtn.setAttribute('aria-expanded', 'true');
			};

			on(displayBtn, 'click', (e) => {
				e.stopPropagation();
				menu.classList.contains('tm-open') ? close() : open();
			});

			on(menu, 'click', (e) => {
				const opt = e.target.closest('.tm-flag-option');
				if (!opt) return;
				selectedValue = opt.dataset.value;
				render();
				close();
				if (onChange) onChange(selectedValue);
			});

			displayBtn.setAttribute('tabindex', '0');
			displayBtn.setAttribute('role', 'button');
			displayBtn.setAttribute('aria-haspopup', 'listbox');
			displayBtn.setAttribute('aria-expanded', 'false');
			menu.setAttribute('role', 'listbox');
			menu.setAttribute('aria-expanded', 'false');

			const focusOption = (el) => el?.focus();
			const getOptions = () => qsa(menu, '.tm-flag-option');
			const moveFocus = (dir) => {
				const opts = getOptions();
				if (opts.length === 0) return;
				const i = opts.indexOf(document.activeElement);
				focusOption(opts[clamp(i + dir, 0, opts.length - 1)]);
			};

			on(displayBtn, 'keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); menu.classList.contains('tm-open') ? close() : open(); }
				if (e.key === 'ArrowDown') { e.preventDefault(); open(); focusOption(getOptions()[0]); }
			});

			on(menu, 'keydown', (e) => {
				if (e.key === 'Escape') { e.preventDefault(); close(); displayBtn.focus(); }
				if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); }
				if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-1); }
				if (e.key === 'Enter' || e.key === ' ') {
					const opt = document.activeElement?.closest('.tm-flag-option');
					if (!opt) return;
					selectedValue = opt.dataset.value;
					render(); close(); if (onChange) onChange(selectedValue); displayBtn.focus();
				}
			});

			render();

			return {
				getValue: () => selectedValue,
				setValue: (val) => { selectedValue = val; render(); },
				close
			};
		};

		const computeCounts = (scopeThreadContainer) => {
			const c = {
				manualHidden: 0, manualCollapsed: 0, media: 0, whitelist: 0,
				filteredThreads: 0, filteredPosts: 0,
				duplicateThreads: 0, duplicatePosts: 0
			};

			stateManager.forEach((id, st) => {
				if (scopeThreadContainer && !inThread(scopeThreadContainer, id)) return;
				if (st.hidden) {
					if (st.hidden.reason === 'manual') c.manualHidden++;
					else if (st.hidden.reason === 'filtered') c.filteredThreads++;
					else if (st.hidden.reason === 'duplicate') c.duplicateThreads++;
				}
				if (st.collapsed) {
					if (st.collapsed.reason === 'manual') c.manualCollapsed++;
					else if (st.collapsed.reason === 'duplicate-post') c.duplicatePosts++;
					else c.filteredPosts++;
				}
				if (st.whitelist) c.whitelist++;
				if (st.mediaCollapsed) c.media++;
			});
			return c;
		};

		const updateCounter = (selector, count) => {
			const label = qs(modal, selector);
			if (!label) return;
			const base = label.textContent.replace(/\s*\(\d+\)\s*$/, '').trim();
			label.textContent = `${base} (${count})`;
		};

		const updateAllCounters = () => {
			const t = computeCounts(currentThreadContainer);
			const b = computeCounts();

			updateCounter('#tm-filter-manual + span', b.manualHidden);
			updateCounter('#tm-filter-filtered + span', b.filteredThreads);
			updateCounter('#tm-filter-duplicate + span', b.duplicateThreads);
			updateCounter('#tm-filter-whitelist + span', b.whitelist);

			updateCounter('label[for="tm-clear-manual-collapsed-thread"]', t.manualCollapsed);
			updateCounter('label[for="tm-clear-media-thread"]', t.media);

			updateCounter('label[for="tm-clear-hidden-board"]', b.manualHidden);
			updateCounter('label[for="tm-clear-whitelist-board"]', b.whitelist);
			updateCounter('label[for="tm-clear-collapsed-board"]', b.manualCollapsed);
			updateCounter('label[for="tm-clear-media-board"]', b.media);
		};

		const createFlagDisplay = ({ display, dropdown, data, onUpdate, getLabel }) => {
			const updateDisplay = () => {
				display.innerHTML = '';
				if (!data.size) {
					display.innerHTML = '<span class="tm-flags-placeholder">Выберите флаги...</span>';
				} else {
					const entries = Array.from(data.entries());
					for (let i = 0; i < entries.length; i++) {
						const [key, mode] = entries[i];
						const label = (typeof getLabel === 'function') ? getLabel(key) : (FLAG_BY_ID[key]?.name ?? String(key));
						const chip = document.createElement('div');
						chip.className = `tm-flag-chip ${mode === 'exclude' ? 'exclude' : 'include'}`;
						chip.innerHTML = `<span>${escapeHtml(mode === 'exclude' ? 'Искл: ' : 'Вкл: ')}${escapeHtml(label)}</span><span class="tm-flag-chip-remove" data-key="${escapeHtml(String(key))}">×</span>`;
						display.appendChild(chip);
					}
				}
				display.setAttribute('tabindex', '0');
				display.setAttribute('role', 'button');
				display.setAttribute('aria-haspopup', 'listbox');
				display.setAttribute('aria-expanded', 'false');
				dropdown.setAttribute('role', 'listbox');
				dropdown.setAttribute('aria-expanded', 'false');

				const allOpts = qsa(dropdown, '.tm-flag-option');
				for (let i = 0; i < allOpts.length; i++) {
					const opt = allOpts[i];
					const mode = data.get(opt.dataset.key);
					opt.classList.toggle('selected', !!mode);
					opt.classList.toggle('include', mode === 'include');
					opt.classList.toggle('exclude', mode === 'exclude');
					opt.setAttribute('aria-selected', String(!!mode));
				}
			};

			const toggle = () => dropdown.classList.toggle('tm-open');
			const close = () => dropdown.classList.remove('tm-open');

			on(display, 'click', (e) => {
				const rm = e.target.closest('.tm-flag-chip-remove');
				if (rm) {
					data.delete(rm.dataset.key);
					updateDisplay();
					if (onUpdate) onUpdate();
					return;
				}
				const allDropdowns = qsa(document, '.tm-flags-dropdown.tm-open');
				for (let i = 0; i < allDropdowns.length; i++) {
					const m = allDropdowns[i];
					if (m !== dropdown) m.classList.remove('tm-open');
				}
				toggle();
			});

			on(dropdown, 'click', (e) => {
				const opt = e.target.closest('.tm-flag-option');
				if (!opt) return;
				const key = opt.dataset.key;

				if (e.shiftKey || e.ctrlKey || e.metaKey) {
					const cur = data.get(key);
					data.delete(key);
					if (cur !== 'exclude') data.set(key, 'exclude');
				} else {
					const cur = data.get(key);
					if (!cur) data.set(key, 'include');
					else if (cur === 'include') data.set(key, 'exclude');
					else data.delete(key);
				}

				updateDisplay();
				if (onUpdate) onUpdate();
			});

			display.setAttribute('tabindex', '0');
			display.setAttribute('role', 'button');
			dropdown.setAttribute('role', 'listbox');

			const getOpts = () => qsa(dropdown, '.tm-flag-option');
			const focusOpt = (i) => { const opts = getOpts(); if (opts[i]) opts[i].focus(); };

			on(display, 'keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					const allDropdowns = qsa(document, '.tm-flags-dropdown.tm-open');
					for (let i = 0; i < allDropdowns.length; i++) {
						const m = allDropdowns[i];
						if (m !== dropdown) m.classList.remove('tm-open');
					}
					toggle();
					if (dropdown.classList.contains('tm-open')) focusOpt(0);
				}
				if (e.key === 'ArrowDown') { e.preventDefault(); if (!dropdown.classList.contains('tm-open')) toggle(); focusOpt(0); }
			});

			on(dropdown, 'keydown', (e) => {
				const opts = getOpts();
				if (!opts.length) return;
				const idx = opts.indexOf(document.activeElement);
				if (e.key === 'Escape') { e.preventDefault(); close(); display.focus(); }
				if (e.key === 'ArrowDown') { e.preventDefault(); const next = opts[Math.min(idx + 1, opts.length - 1)]; if (next) next.focus(); }
				if (e.key === 'ArrowUp') { e.preventDefault(); const prev = opts[Math.max(idx - 1, 0)]; if (prev) prev.focus(); }
				if (e.key === 'Enter' || e.key === ' ') {
					const opt = document.activeElement?.closest('.tm-flag-option'); if (!opt) return;
					opt.click();
					e.preventDefault();
				}
			});

			return { updateDisplay, close };
		};

		/* ================== NOTIFICATIONS ================== */
		const notify = {
			container: null,

			init() {
				if (this.container) return;
				this.container = document.createElement('div');
				this.container.id = 'tm-notifications';
				this.container.className = 'tm-notifications';
				document.body.appendChild(this.container);
			},

			show(message, type = 'info', duration = 3000) {
				this.init();
				this.container.style.zIndex = '2147483647';
				const notif = document.createElement('div');
				notif.className = `tm-notification tm-notification-${type}`;
				notif.textContent = String(message || '');
				this.container.appendChild(notif);

				const showTimer = setTimeout(() => {
					notifyTimers.delete(showTimer);
					notif.classList.add('tm-notification-show');
				}, 10);
				notifyTimers.add(showTimer);

				if (duration > 0) {
					const hideTimer = setTimeout(() => {
						notifyTimers.delete(hideTimer);
						notif.classList.remove('tm-notification-show');
						const removeTimer = setTimeout(() => {
							notifyTimers.delete(removeTimer);
							notif.remove();
						}, 300);
						notifyTimers.add(removeTimer);
					}, duration);
					notifyTimers.add(hideTimer);
				}
				return notif;
			},

			dismiss(node) {
				if (!node) return;
				node.classList.remove('tm-notification-show');
				const timer = setTimeout(() => {
					notifyTimers.delete(timer);
					node.remove();
				}, 300);
				notifyTimers.add(timer);
			},

			loading(msg = 'Обработка', minVisibleMs = 800) {
				const n = this.show(msg, 'info', 0);
				n.classList.add('tm-notification-loading');

				const started = Date.now();
				let dismissed = false;

				return (next) => {
					if (dismissed) return;
					dismissed = true;
					const remaining = Math.max(0, minVisibleMs - (Date.now() - started));
					const timer = setTimeout(() => {
						notifyTimers.delete(timer);
						this.dismiss(n);
						if (typeof next === 'function') next();
					}, remaining);
					notifyTimers.add(timer);
				};
			},

			success(msg) { this.show(msg, 'success'); },
			error(msg) { this.show(msg, 'error', 5000); },
			warning(msg) { this.show(msg, 'warning', 4000); },
			info(msg) { this.show(msg, 'info'); }
		};

		const confirmDialog = (message, onConfirm, onCancel) => {
			const overlay = document.createElement('div');
			overlay.className = 'tm-confirm-overlay';
			overlay.style.zIndex = '2147483647';
			overlay.setAttribute('role', 'dialog');
			overlay.setAttribute('aria-modal', 'true');

			const dialog = document.createElement('div');
			dialog.className = 'tm-confirm-dialog';
			dialog.innerHTML = `
				<div class="tm-confirm-message" id="tm-confirm-msg">${escapeHtml(String(message || ''))}</div>
				<div class="tm-confirm-actions">
					<button class="tm-button tm-confirm-cancel">Отмена</button>
					<button class="tm-button primary tm-confirm-ok">Подтвердить</button>
				</div>
			`;
			dialog.setAttribute('aria-labelledby', 'tm-confirm-msg');

			overlay.appendChild(dialog);
			document.body.appendChild(overlay);

			const modalOverlay = document.getElementById('tm-management-overlay');
			if (modalOverlay) modalOverlay.classList.add('tm-dimmed');

			const prevActive = document.activeElement;
			const okBtn = qs(dialog, '.tm-confirm-ok');
			const cancelBtn = qs(dialog, '.tm-confirm-cancel');

			let closed = false;
			const cleanup = () => {
				if (closed) return;
				closed = true;
				document.removeEventListener('keydown', keydownTrap, true);
				overlay.remove();
				const mm = document.getElementById('tm-management-overlay');
				if (mm) mm.classList.remove('tm-dimmed');
				if (prevActive && typeof prevActive.focus === 'function') {
					try { prevActive.focus(); } catch { /**/ }
				}
			};

			const confirm = () => { cleanup(); if (onConfirm) onConfirm(); };
			const cancel = () => { cleanup(); if (onCancel) onCancel(); };

			opsManager.queueJsOp('modal:focus', () => {
				if (runIdle) runIdle(() => (okBtn || cancelBtn)?.focus());
				else (okBtn || cancelBtn)?.focus();
			});

			on(okBtn, 'click', confirm);
			on(cancelBtn, 'click', cancel);
			on(overlay, 'click', (e) => { if (e.target === overlay) cancel(); });

			const keydownTrap = (e) => {
				if (closed) return;
				if (!overlay.contains(e.target)) return;

				if (e.key === 'Escape') {
					e.preventDefault();
					e.stopPropagation();
					cancel();
					return;
				}

				if (e.key === 'Enter') return;
				if (e.key !== 'Tab') return;

				const items = [cancelBtn, okBtn].filter(Boolean);
				if (!items.length) return;

				const first = items[0];
				const last = items[items.length - 1];

				if (e.shiftKey) {
					if (document.activeElement === first || !overlay.contains(document.activeElement)) {
						e.preventDefault();
						last.focus();
					}
				} else {
					if (document.activeElement === last || !overlay.contains(document.activeElement)) {
						e.preventDefault();
						first.focus();
					}
				}
			};

			document.addEventListener('keydown', keydownTrap, true);
		};

		const reprocessAffectedPosts = () => {
			return new Promise((resolve) => {
				const done = notify.loading('Обновление');
				const timer = setTimeout(() => {
					activeTimers.delete(timer);
					crossTabSync.reconcile();
					updateAllCounters();
					updatePostStyle();
					done(() => { notify.success('Правила применены'); resolve(); });
				}, 100);
				activeTimers.add(timer);
			});
		};

		/* ================== OVERLAY ================== */
		const overlay = document.createElement('div');
		overlay.id = 'tm-management-overlay';
		overlay.className = 'tm-management-overlay no-scroll-touch';
		document.documentElement.style.overflow = 'hidden';
		document.body.style.overflow = 'hidden';

		const currentThreadContainer = currentThreadId ? Post.get(currentThreadId)?.thread : null;

		overlay.innerHTML = `
			<div id="tm-management-modal" class="post post_type_reply" role="dialog" aria-modal="true" aria-labelledby="tm-management-header">
				<div id="tm-management-header">
					<div id="tm-management-tabs" role="tablist" aria-label="Менеджер тредов">
						<button class="tm-tab ${defaultTab === 'threads' ? 'tm-tab-active' : ''}" data-tab="threads" role="tab" aria-selected="${defaultTab === 'threads'}">Треды</button>
						<button class="tm-tab ${defaultTab === 'rules' ? 'tm-tab-active' : ''}" data-tab="rules" role="tab" aria-selected="${defaultTab === 'rules'}">Правила</button>
						<button class="tm-tab ${defaultTab === 'clear' ? 'tm-tab-active' : ''}" data-tab="clear" role="tab" aria-selected="${defaultTab === 'clear'}">Очистка</button>
						<button class="tm-tab ${defaultTab === 'config' ? 'tm-tab-active' : ''}" data-tab="config" role="tab" aria-selected="${defaultTab === 'config'}">
						  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						    <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.115c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.117 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.118 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.117c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.118c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.117-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.118-2.573c-.94-1.543.826-3.31 2.37-2.37a1.724 1.724 0 0 0 2.572-1.117Z"/>
						    <path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0-6 0"/>
						  </svg>
						</button>
					</div>
					<div class="tm-actions">
						<div class="tm-storage-menu">
							<button class="tm-button" id="tm-storage-menu-toggle" aria-expanded="false" aria-haspopup="true">БД ▾</button>
							<div class="tm-storage-dropdown" id="tm-storage-dropdown" role="menu" aria-hidden="true">
								<form id="tm-storage-form" class="tm-storage-form" aria-label="Опции хранилища">
									<fieldset class="tm-storage-block">
										<legend>Включить</legend>
										<label class="tm-choice">
											<input type="checkbox" id="tm-storage-what-rules" checked>
											<span>Правила</span>
										</label>
										<label class="tm-choice">
											<input type="checkbox" id="tm-storage-what-config" checked>
											<span>Настройки</span>
										</label>
									</fieldset>
									<fieldset class="tm-storage-block">
										<legend>Область</legend>
										<label class="tm-choice">
											<input type="radio" name="tm-storage-scope" value="board" checked>
											<span>Борда (/${BOARD_ID}/)</span>
										</label>
										<label class="tm-choice">
											<input type="radio" name="tm-storage-scope" value="global">
											<span>Глобально</span>
										</label>
									</fieldset>
									<div class="tm-storage-actions">
										<button type="button" class="tm-button" data-action="export">Экспорт</button>
										<button type="button" class="tm-button" data-action="import">Импорт</button>
										<button type="button" class="tm-button tm-danger" data-action="reset">Сброс</button>
									</div>
								</form>
							</div>
						</div>
						<button class="tm-button" id="tm-management-close">Закрыть</button>
					</div>
				</div>
				<div id="tm-management-content">
					<div id="tm-tab-threads" class="tm-tab-content ${defaultTab === 'threads' ? 'tm-tab-active' : ''}" role="tabpanel"></div>
					<div id="tm-tab-rules" class="tm-tab-content ${defaultTab === 'rules' ? 'tm-tab-active' : ''}" role="tabpanel"></div>
					<div id="tm-tab-clear" class="tm-tab-content ${defaultTab === 'clear' ? 'tm-tab-active' : ''}" role="tabpanel"></div>
					<div id="tm-tab-config" class="tm-tab-content ${defaultTab === 'config' ? 'tm-tab-active' : ''}" role="tabpanel"></div>
				</div>
			</div>
		`;
		document.body.appendChild(overlay);

		const modal = qs(overlay, '#tm-management-modal');
		const threadsTab = qs(modal, '#tm-tab-threads');
		const rulesTab = qs(modal, '#tm-tab-rules');
		const clearTab = qs(modal, '#tm-tab-clear');
		const configTab = qs(modal, '#tm-tab-config');

		/* ================== FOCUS TRAP + CLEANUP ================== */
		const focusableSelector = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

		const getFocusableElements = () => {
			return qsa(modal, focusableSelector).filter(el => {
				try { return el.offsetParent !== null && !el.closest('.tm-tab-content:not(.tm-tab-active)'); }
				catch { return false; }
			});
		};

		const trapFocus = (e) => {
			if (e.key !== 'Tab') return;
			if (qs(document, '.tm-confirm-overlay')) return;

			const focusable = getFocusableElements();
			if (focusable.length === 0) return;

			const first = focusable[0];
			const last = focusable[focusable.length - 1];

			if (e.shiftKey) {
				if (document.activeElement === first || !modal.contains(document.activeElement)) {
					e.preventDefault();
					last.focus();
				}
			} else {
				if (document.activeElement === last || !modal.contains(document.activeElement)) {
					e.preventDefault();
					first.focus();
				}
			}
		};

		modal.setAttribute('tabindex', '-1');
		const focusTimer = setTimeout(() => {
			activeTimers.delete(focusTimer);
			const focusable = getFocusableElements();
			if (focusable.length > 0) focusable[0].focus();
			else modal.focus();
			isTransitioning = false;
		}, 0);
		activeTimers.add(focusTimer);

		const handlers = [];
		const addDocListener = (type, fn, opts) => {
			document.addEventListener(type, fn, opts);
			handlers.push(() => document.removeEventListener(type, fn, opts));
		};

		const closeModal = () => {
			for (let i = 0; i < handlers.length; i++) handlers[i]();
			activeTimers.forEach(id => clearTimeout(id));
			activeTimers.clear();
			normalizeCache.clear();
			overlay.remove();
			resetScrollLocks();
			isOpen = false;
			isTransitioning = false;
		};

		addDocListener('keydown', (e) => { if (e.key === 'Escape' && !qs(document, '.tm-confirm-overlay')) closeModal(); });
		addDocListener('keydown', trapFocus);
		on(qs(modal, '#tm-management-close'), 'click', closeModal);
		on(overlay, 'click', e => { if (e.target === overlay) closeModal(); });

		const closeAllDropdowns = () => {
			const allDropdowns = qsa(document, '.tm-flags-dropdown.tm-open, .tm-storage-dropdown.tm-open');
			for (let i = 0; i < allDropdowns.length; i++) {
				const dd = allDropdowns[i];
				dd.classList.remove('tm-open');
				dd.setAttribute('aria-expanded', 'false');
				dd.setAttribute('aria-hidden', 'true');
				const btn = dd.closest('.tm-flags-multiselect, .tm-storage-menu')?.querySelector('[aria-haspopup="true"], .tm-flags-display, #tm-storage-menu-toggle');
				if (btn) btn.setAttribute('aria-expanded', 'false');
			}
		};

		addDocListener('click', (e) => {
			if (!e.target.closest('.tm-flags-multiselect, .tm-storage-menu')) closeAllDropdowns();
		});
		addDocListener('keydown', (e) => { if (e.key === 'Escape') closeAllDropdowns(); });

		stateManager.on('sync:reconciled', () => {
			if (document.visibilityState !== 'visible' || !document.getElementById('tm-management-overlay')) return;
			const timer = setTimeout(() => {
				activeTimers.delete(timer);
				updateAllCounters();
				renderList();
				renderRulesList();
			}, 0);
			activeTimers.add(timer)
		});

		/* ================== STORAGE HELPERS ================== */
		const getRulesKeyForScope = (scope) => (scope === 'global' ? GLOBAL_FILTERS_KEY : BOARD_DATA_KEY);
		const readRulesForScope = (scope) => {
			const stored = safeGet(getRulesKeyForScope(scope), {}) || {};
			return {
				threadRules: Array.isArray(stored.threadRules) ? stored.threadRules : [],
				replyRules: Array.isArray(stored.replyRules) ? stored.replyRules : []
			};
		};
		const writeRulesForScope = (scope, threadRules, replyRules) => {
			const key = getRulesKeyForScope(scope);
			const stored = safeGet(key, {}) || {};
			stored.threadRules = threadRules;
			stored.replyRules = replyRules;
			safeSet(key, stored);
		};

		/* ================== EXPORT / IMPORT / RESET ================== */
		const buildExportPayload = ({ scope, what }) => {
			const payload = { version: '1.1.2', exportDate: new Date().toISOString(), scope };
			if (what === 'rules' || what === 'both') {
				const { threadRules, replyRules } = readRulesForScope(scope);
				payload.threadRules = threadRules;
				payload.replyRules = replyRules;
			}
			if (what === 'config' || what === 'both') payload.config = loadConfigFromStorage(scope);
			return payload;
		};

		const doExport = ({ scope, what }) => {
			const data = buildExportPayload({ scope, what });
			const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			const boardSuffix = (scope === 'global' ? 'global' : BOARD_ID);
			a.href = url; a.download = `tm-export-${what}-${boardSuffix}-${Date.now()}.json`; a.click();
			URL.revokeObjectURL(url);
			notify.success('Экспорт завершён');
		};

		const doImport = ({ scope, what }) => {
			const input = document.createElement('input');
			input.type = 'file'; input.accept = 'application/json';
			on(input, 'change', (e) => {
				const file = e.target.files?.[0]; if (!file) return;
				const reader = new FileReader();
				reader.onload = (ev) => {
					try {
						const data = JSON.parse(String(ev.target.result || '{}'));
						if (what === 'rules' || what === 'both') {
							const cur = readRulesForScope(scope);
							const newT = Array.isArray(data.threadRules) ? data.threadRules : [];
							const newR = Array.isArray(data.replyRules) ? data.replyRules : [];
							const keyOf = r => [r.pattern, r.flags, r.flagMask, r.desc, r.preservePunct ? 1 : 0, r.expandCyrillic === false ? 0 : 1].join('||');
							const seenT = new Set(cur.threadRules.map(keyOf));
							const mergedT = [...cur.threadRules];
							for (let i = 0; i < newT.length; i++) {
								const r = newT[i], k = keyOf(r);
								if (!seenT.has(k)) { seenT.add(k); mergedT.push(r); }
							}
							const seenR = new Set(cur.replyRules.map(keyOf));
							const mergedR = [...cur.replyRules];
							for (let i = 0; i < newR.length; i++) {
								const r = newR[i], k = keyOf(r);
								if (!seenR.has(k)) { seenR.add(k); mergedR.push(r); }
							}
							writeRulesForScope(scope, mergedT, mergedR);
						}
						if (what === 'config' || what === 'both') {
							const defs = [...CONFIG_DEFINITIONS.basic, ...CONFIG_DEFINITIONS.advanced];
							const incomingCfg = (data && typeof data.config === 'object') ? data.config : {};
							const current = loadConfigFromStorage(scope);
							const cleaned = {};
							for (let i = 0; i < defs.length; i++) {
								const def = defs[i];
								const v = incomingCfg[def.key];
								if (def.type === 'checkbox') cleaned[def.key] = Boolean(v);
								else {
									const r = sanitizeNumber(v, def);
									cleaned[def.key] = (typeof r === 'number') ? r : current[def.key];
								}
							}
							if (typeof incomingCfg.MANAGER_BUTTON_POSITION === 'string') {
								cleaned.MANAGER_BUTTON_POSITION = incomingCfg.MANAGER_BUTTON_POSITION;
							}
							safeSet(getConfigStorageKey(scope), { ...current, ...cleaned });
						}
						notify.success('Импорт завершён');
						reprocessAffectedPosts().then(() => {
							renderList();
							updateAllCounters();
						});
                        applyManagerButtonPosition(CONFIG.MANAGER_BUTTON_POSITION);
                        renderRulesList();
                        renderConfig();
					} catch (e) {
						console.error('[abufilter] Import failed:', { source: 'doImport', error: e, stack: e?.stack });
						notify.error('Ошибка импорта: ' + (e?.message || String(e)));
					}
				};
				reader.readAsText(file);
			});
			input.click();
		};

		const doReset = ({ scope, what }) => {
			confirmDialog(
				`Сброс ${what.toUpperCase()} для ${scope.toUpperCase()}. Продолжить?`,
				() => {
					if (what === 'rules' || what === 'both') writeRulesForScope(scope, [], []);
					if (what === 'config' || what === 'both') {
						const defaults = {};
						const allDefs = [...CONFIG_DEFINITIONS.basic, ...CONFIG_DEFINITIONS.advanced];
						for (let i = 0; i < allDefs.length; i++) defaults[allDefs[i].key] = allDefs[i].default;
						safeSet(getConfigStorageKey(scope), defaults);
					}
					notify.success('Сброс завершён');
                    reprocessAffectedPosts().then(() => {
                        renderList();
                        updateAllCounters();
                    });
                    applyManagerButtonPosition(CONFIG.MANAGER_BUTTON_POSITION);
                    renderRulesList();
                    renderConfig();
				}
			);
		};

		/* ================== STORAGE DROPDOWN ================== */
		const toggleBtn = qs(modal, '#tm-storage-menu-toggle');
		const dropdown = qs(modal, '#tm-storage-dropdown');
		const form = qs(modal, '#tm-storage-form');

		const closeDropdown = () => {
			if (dropdown) {
				dropdown.setAttribute('aria-hidden', 'true');
				dropdown.classList.remove('tm-open');
			}
			if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
		};
		const openDropdown = () => {
			closeAllDropdowns();
			if (dropdown) {
				dropdown.setAttribute('aria-hidden', 'false');
				dropdown.classList.add('tm-open');
			}
			if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
		};
		on(toggleBtn, 'click', (e) => {
			e.stopPropagation();
			dropdown && dropdown.classList.contains('tm-open') ? closeDropdown() : openDropdown();
		});

		const getWhat = () => {
			const rules = qs(form, '#tm-storage-what-rules')?.checked;
			const cfg = qs(form, '#tm-storage-what-config')?.checked;
			if (rules && cfg) return 'both';
			if (rules) return 'rules';
			if (cfg) return 'config';
			return null;
		};
		const getScope = () => {
			const sel = qs(form, 'input[name="tm-storage-scope"]:checked');
			return sel ? sel.value : 'board';
		};
		const storageButtons = qsa(form, '.tm-storage-actions .tm-button');
		for (let i = 0; i < storageButtons.length; i++) {
			const btn = storageButtons[i];
			on(btn, 'click', (e) => {
				e.preventDefault();
				const action = btn.dataset.action;
				const scope = getScope(), what = getWhat();
				if (!what) { notify.warning('Выберите: Правила или Настройки'); return; }
				closeDropdown();
				if (action === 'export') return doExport({ scope, what });
				if (action === 'import') return doImport({ scope, what });
				if (action === 'reset') return doReset({ scope, what });
			});
		}

		const allTabs = qsa(modal, '.tm-tab');
		for (let i = 0; i < allTabs.length; i++) {
			const tab = allTabs[i];
			on(tab, 'click', () => {
				const target = tab.dataset.tab;
				qsa(modal, '.tm-tab').forEach(t => { t.classList.remove('tm-tab-active'); t.setAttribute('aria-selected', 'false'); });
				qsa(modal, '.tm-tab-content').forEach(c => c.classList.remove('tm-tab-active'));
				tab.classList.add('tm-tab-active');
				tab.setAttribute('aria-selected', 'true');
				const targetTab = qs(modal, `#tm-tab-${target}`);
				if (targetTab) {
					targetTab.classList.add('tm-tab-active');
					targetTab.scrollTop = 0;
				}
				renderList();
				updateAllCounters();
			});
		}

		/* ================== THREADS TAB ================== */
		threadsTab.innerHTML = `
			<div class="tm-panel">
				<div class="tm-header--column">
					<div class="tm-header">
						<h3 class="tm-h3">Обработанные треды (<span id="tm-shown-count">0</span>/<span id="tm-total-count">0</span>)</h3>
					</div>
					<div class="tm-search">
						<input id="tm-hidden-search" class="tm-search-input" type="text" placeholder="Поиск..." autocomplete="off" aria-label="Поиск тредов"/>
					</div>
					<div id="tm-hidden-ops-filters">
						<label class="tm-choice"><input type="checkbox" id="tm-filter-manual" checked><span>Вручную (0)</span></label>
						${!currentThreadId ? `
							<label class="tm-choice"><input type="checkbox" id="tm-filter-filtered" checked><span>Фильтры (0)</span></label>
							<label class="tm-choice"><input type="checkbox" id="tm-filter-duplicate" checked><span>Дубли (0)</span></label>
						` : ''}
						<label class="tm-choice"><input type="checkbox" id="tm-filter-whitelist"><span>БС (0)</span></label>
					</div>
				</div>
				<div id="tm-hidden-ops-body">Загрузка…</div>
			</div>
		`;

		const body = qs(threadsTab, '#tm-hidden-ops-body');
		const searchInput = qs(threadsTab, '#tm-hidden-search');
		const shownCountEl = qs(threadsTab, '#tm-shown-count');
		const totalCountEl = qs(threadsTab, '#tm-total-count');

		let renderToken = 0, fullList = [];

		const rowTemplate = document.createElement('template');
		rowTemplate.innerHTML = `
			<div class="tm-ops-row" data-id="" tabindex="0" role="button" aria-expanded="false" title="Развернуть">
				<div class="tm-ops-text"></div>
				<div class="tm-ops-desc"></div>
				<button type="button" class="tm-ops-btn tm-ops-remove" title="В белый список" aria-label="В белый список">✕</button>
			</div>
		`;

		const getVisibleList = () => {
			const showManual = qs(threadsTab, '#tm-filter-manual')?.checked;
			const showFiltered = qs(threadsTab, '#tm-filter-filtered')?.checked;
			const showDuplicate = qs(threadsTab, '#tm-filter-duplicate')?.checked;
			const showWhitelist = qs(threadsTab, '#tm-filter-whitelist')?.checked;
			const query = searchInput?.value.toLowerCase().trim() || '';
			const hidden = [];

			stateManager.forEach((id, state) => {
				if (state.hidden) {
					if (showManual && state.hidden.reason === 'manual') hidden.push({ id, ...state.hidden, reason: 'manual' });
					if (showFiltered && state.hidden.reason === 'filtered') hidden.push({ id, ...state.hidden, reason: 'filtered' });
					if (showDuplicate && state.hidden.reason === 'duplicate') hidden.push({ id, ...state.hidden, reason: 'duplicate' });
				}
				if (showWhitelist && state.whitelist) hidden.push({ id, ...state.whitelist, reason: 'whitelist' });
			});

			const filterFn = item => (!query) ? true : (item.fullText || '').toLowerCase().includes(query);
			const sortFn = (a, b) => {
				const ORDER = { whitelist: 0, manual: 1, duplicate: 2, filtered: 3, other: 4 };
				const ra = ORDER[a.reason] ?? ORDER.other;
				const rb = ORDER[b.reason] ?? ORDER.other;
				if (ra !== rb) return ra - rb;
				return (b.time || 0) - (a.time || 0);
			};
			fullList = hidden.filter(filterFn).sort(sortFn);
			return fullList;
		};

		const normalizeText = (input = '', preservePunct = false, returnMap = false) => {
			if (!input) return returnMap ? { normalized: '', map: [] } : '';

			const cacheKey = `${input.slice(0, 100)}|${preservePunct}|${returnMap}`;
			if (normalizeCache.has(cacheKey)) return normalizeCache.get(cacheKey);

			const outArray = [];
			const map = new Array(input.length);
			let prevWasSpace = true, pendingSpace = false, lastScript = 0, outIdx = 0, mapIdx = 0;

			for (let i = 0; i < input.length; i++) {
				const code = input.charCodeAt(i);
				if ((code <= 0x20) || code === 0xA0 || (!preservePunct && (code < 128 && ASCII_PUNCT[code]))) {
					if (!prevWasSpace) { pendingSpace = true; prevWasSpace = true; }
					lastScript = 0;
					continue;
				}
				let curScript = 0;
				if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) curScript = 1;
				else if ((code >= 0x0400 && code <= 0x052F) || (code >= 0x2DE0 && code <= 0x2DFF) || (code >= 0xA640 && code <= 0xA69F)) curScript = 2;

				if (!preservePunct && !prevWasSpace && lastScript && curScript && curScript !== lastScript) pendingSpace = true;
				if (pendingSpace && outIdx > 0) {
					outArray[outIdx++] = ' ';
					map[mapIdx++] = i;
					pendingSpace = false;
				}
				outArray[outIdx++] = input[i];
				map[mapIdx++] = i;
				prevWasSpace = false;
				if (curScript) lastScript = curScript;
			}

			const result = !returnMap ?
				(outIdx ? outArray.slice(0, outIdx).join('') : '') :
				{ normalized: outIdx ? outArray.slice(0, outIdx).join('') : '', map: map.slice(0, mapIdx) };

			if (normalizeCache.size >= CONFIG.MAX_NORM_CACHE_SIZE) {
				const firstKey = normalizeCache.keys().next().value;
				normalizeCache.delete(firstKey);
			}
			normalizeCache.set(cacheKey, result);
			return result;
		};

		const makeSnippet = (filter, fullText) => {
			if (!filter || !fullText) return '';

			let { normalized, map } = normalizeText(fullText, false, true);
			let m = null;
			try {
				m = filter.pattern.exec(normalized);
			} catch {
				return '';
			}

			if (!m) {
				const alt = normalizeText(fullText, true, true);
				normalized = alt.normalized;
				map = alt.map;
				try {
					m = filter.pattern.exec(normalized);
				} catch {
					return '';
				}
				if (!m) return '';
			}

			const normStart = m.index;
			const rawMatchStart = (normStart >= 0 && normStart < map.length) ? map[normStart] : undefined;
			const endIdx = (normStart + m[0].length) - 1;
			const rawMatchEnd = (endIdx >= 0 && endIdx < map.length) ? (map[endIdx] + 1) : rawMatchStart;

			if (typeof rawMatchStart !== 'number' || typeof rawMatchEnd !== 'number') {
				return `<span class="tm-highlight">${escapeHtml(m[0])}</span>`;
			}

			const snippetStart = Math.max(0, rawMatchStart - CONFIG.SNIPPET_BEFORE_CHARS);
			const snippetEnd = Math.min(fullText.length, rawMatchEnd + CONFIG.SNIPPET_AFTER_CHARS);

			return `${snippetStart > 0 ? '...' : ''}` +
				`${escapeHtml(fullText.slice(snippetStart, rawMatchStart))}` +
				`<span class="tm-highlight">${escapeHtml(fullText.slice(rawMatchStart, rawMatchEnd))}</span>` +
				`${escapeHtml(fullText.slice(rawMatchEnd, snippetEnd))}` +
				`${snippetEnd < fullText.length ? '...' : ''}`;
		};

		const renderList = () => {
			if (!document.getElementById('tm-management-overlay')) return;
			renderToken++;
			const currentToken = renderToken;
			const list = getVisibleList();
			const totals = computeCounts(currentThreadContainer);
			setText(shownCountEl, list.length);
			setText(totalCountEl, totals.manualHidden + totals.filteredThreads + totals.duplicateThreads + totals.whitelist);
			if (body) body.innerHTML = '';
			if (list.length === 0) { if (body) body.textContent = 'Ничего не найдено'; return; }

			const batchSize = 20;

			const renderBatch = (startIndex = 0) => {
				if (currentToken !== renderToken || !body) return;
				const frag = document.createDocumentFragment();

				for (let i = startIndex; i < Math.min(list.length, startIndex + batchSize); i++) {
					const item = list[i];
					const row = rowTemplate.content.firstElementChild.cloneNode(true);
					row.dataset.id = String(item.id || '');
					row.tabIndex = 0;
					if (item.reason === 'whitelist') row.style.opacity = '0.95';

					const textEl = qs(row, '.tm-ops-text');
					const fullText = item.fullText;
					const descEl = qs(row, '.tm-ops-desc');
					descEl.textContent = item.desc || DESC_MAP[item.reason] || item.reason || '';
					if (item.time) {
						const t = new Date(item.time);
						const timeEl = document.createElement('time');
						timeEl.className = 'tm-ops-time';
						timeEl.dateTime = t.toISOString();
						timeEl.title = t.toISOString();
						timeEl.textContent = t.toLocaleString();
						descEl.append(': ', timeEl);
					}
					if (item.id) {
						const anchor = document.createElement('a');
						anchor.className = 'tm-desc-reply';
						anchor.dataset.num = String(item.id);
						anchor.href = `/${BOARD_ID}/res/${item.id}.html`;
						anchor.innerText = ` >>${item.id}`;
						descEl.appendChild(anchor);
					}

					row._renderCollapsed = () => {
						const htmlContent = makeSnippet(item.filter, fullText);
						if (!htmlContent && fullText) {
							if (fullText.length >= CONFIG.MAX_CHARS_IN_LIST) {
								textEl.innerHTML = escapeHtml(fullText.slice(0, Math.floor(CONFIG.MAX_CHARS_IN_LIST * 0.5))).replace(/\n/g, '<br>') + '...';
							} else {
								textEl.innerHTML = escapeHtml(fullText).replace(/\n/g, '<br>');
							}
						} else {
							textEl.innerHTML = htmlContent || 'Т_Т ...утеряно навсегда... Т_Т';
						}
						row.setAttribute('aria-expanded', 'false');
						row.setAttribute('title', 'Развернуть');
						row.classList.remove('is-expanded');
					};

					row._renderExpanded = () => {
						if (fullText) {
							if (fullText.length >= CONFIG.MAX_CHARS_IN_LIST) {
								textEl.innerHTML = escapeHtml(fullText.slice(0, CONFIG.MAX_CHARS_IN_LIST)).replace(/\n/g, '<br>') + '...';
							} else {
								textEl.innerHTML = escapeHtml(fullText).replace(/\n/g, '<br>');
							}
						} else {
							textEl.innerHTML = 'Т_Т ...утеряно навсегда... Т_Т';
						}
						row.setAttribute('aria-expanded', 'true');
						row.setAttribute('title', 'Свернуть');
						row.classList.add('is-expanded');
					};
					if (fullText) row._renderCollapsed(); else row.classList.add('no-toggle');

					frag.appendChild(row);
				}

				if (body) body.appendChild(frag);
				if (startIndex + batchSize < list.length) {
					opsManager.queueJsOp('modal:renderbatch', () => renderBatch(startIndex + batchSize));
				}
			};

			opsManager.queueJsOp('modal:renderbatch', () => renderBatch(0));
		};

		let drag = { row:null, x:0, y:0, moved:false };
		on(body, 'pointerdown', e => {
			const row = e.target.closest('.tm-ops-row');
			drag = row ? { row, x:e.clientX, y:e.clientY, moved:false } : { row:null, x:0, y:0, moved:false };
		}, { passive:true });
		on(body, 'pointermove', e => {
			if (!drag.row || drag.moved) return;
			if (Math.abs(e.clientX - drag.x) > 5 || Math.abs(e.clientY - drag.y) > 5) drag.moved = true;
		}, { passive:true });
		on(body, 'click', e => {
			const row = e.target.closest('.tm-ops-row');
			if (!row) { drag.row = null; return; }
			if (drag.row === row && drag.moved) { drag.row = null; return; }
			if (e.target.closest('a,button,input,select,textarea') && !e.target.classList.contains('tm-ops-btn')) return;

			if (e.target.matches('.tm-ops-btn.tm-ops-remove')) {
				const id = row.dataset.id;
				if (stateManager.isWhitelisted(id)) postProcessor.toggleWhitelist(id, false);
				else postProcessor.toggleWhitelist(id, true);
				updateAllCounters();
				renderList();
				return;
			}

			if (row.classList.contains('no-toggle')) return;
			if (row.classList.contains('is-expanded') && row._renderCollapsed) row._renderCollapsed();
			else if (row._renderExpanded) row._renderExpanded();
		});

		on(body, 'keydown', e => {
			if (e.key === ' ' && e.target.matches('a')) { e.preventDefault(); e.target.click(); return; }
			if (e.key !== 'Enter' && e.key !== ' ') return;

			const isRowBtn = e.target.classList?.contains('tm-ops-btn');
			if (isRowBtn && e.target.matches('.tm-ops-remove')) {
				e.preventDefault();
				const row = e.target.closest('.tm-ops-row'); if (!row) return;
				const id = row.dataset.id;
				if (stateManager.isWhitelisted(id)) postProcessor.toggleWhitelist(id, false);
				else postProcessor.toggleWhitelist(id, true);
				updateAllCounters();
				renderList();
				return;
			}
			if (e.target.closest('a,button,input,select,textarea,[contenteditable=""],[contenteditable=true]') && !isRowBtn) return;

			const row = e.target.closest('.tm-ops-row');
			if (!row) return;

			const link = qs(row, '.tm-desc-reply');
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && link) { e.preventDefault(); link.click(); return; }

			if (row.classList.contains('no-toggle')) return;
			e.preventDefault();
			if (row.classList.contains('is-expanded') && row._renderCollapsed) row._renderCollapsed();
			else if (row._renderExpanded) row._renderExpanded();
		});

		qsa(threadsTab, '#tm-hidden-ops-filters input').forEach(chk => {
			on(chk, 'change', () => { renderList(); updateAllCounters(); });
		});
		let searchTimeout;
		on(searchInput, 'input', () => {
			clearTimeout(searchTimeout);
			searchTimeout = setTimeout(() => {
				activeTimers.delete(searchTimeout);
				renderList();
			}, 150);
			activeTimers.add(searchTimeout);
		});

		updateAllCounters();
		renderList();

		/* ================== RULES TAB ================== */
		rulesTab.innerHTML = `
			<div id="tm-rules-editor" class="tm-panel">
				<div class="tm-header">
					<h3 class="tm-h3">Редактор правил</h3>
					<div class="tm-rule-buttons">
						<button class="tm-button primary" id="tm-rule-add">Добавить</button>
						<button class="tm-button primary" id="tm-rule-update" style="display:none;">Обновить</button>
						<button class="tm-button" id="tm-rule-cancel" style="display:none;">Отмена</button>
					</div>
				</div>

				<div class="tm-rule-row">
					<label class="tm-subtle">Тип:</label>
					<div id="tm-rule-type-dd" class="tm-flags-multiselect">
						<div class="tm-flags-display">
							<span class="tm-dd-current">Фильтр тредов</span><span class="tm-dd-caret">▾</span>
						</div>
						<div class="tm-flags-dropdown tm-rule-type-menu">
							<div class="tm-flag-option selected" data-value="thread">
								<div class="tm-flag-option-label"><div class="tm-flag-option-name">Фильтр тредов</div></div>
							</div>
							<div class="tm-flag-option" data-value="reply">
								<div class="tm-flag-option-label"><div class="tm-flag-option-name">Фильтр постов</div></div>
							</div>
						</div>
					</div>
				</div>

				<div class="tm-rule-row">
					<label for="tm-rule-pattern">Паттерн:</label>
					<textarea id="tm-rule-pattern" rows="3" placeholder="Regex без разделителей..." aria-describedby="pattern-help"></textarea>
					<details class="tm-pattern-help" id="pattern-help">
						<summary>Синтаксис</summary>
						<ul>
							<li><code>!&amp;</code> → <code>(?&lt;!\\p{L})</code></li>
							<li><code>&amp;!</code> → <code>(?!\\p{L})</code></li>
							<li><code>~</code> → <code>\\S*\\s*?</code></li>
							<li><code>\\s</code> → <code>\\W</code></li>
							<li><code>##паттерн</code>/<code>#N1,N2#паттерн</code> → <br><code>^(?:${softAnchorToken}){N1,N2}?{паттерн}</code> – (если N1,N2 пропущены, N1,N2=0,5)</li>
							<li><code>паттерн@@</code>/<code>паттерн@N1,N2@</code> → <br><code>{паттерн}(?:${softAnchorToken}){N1,N2}?$</code> – (если N1,N2 пропущены, N1,N2=0,5)</li>
							<li><code>##паттерн@@</code> (или с границами) → <br><code>(?:^(?:${softAnchorToken}){N1,N2}?{паттерн})|<wbr>(?:{паттерн}(?:${softAnchorToken}){N3,N4}?$)</code></li>
						</ul>
					</details>
				</div>

				<div class="tm-rule-row">
					<label class="tm-subtle">Флаги regex:</label>
					<div class="tm-flags-multiselect">
						<div class="tm-flags-display" id="tm-regex-flags-display"><span class="tm-flags-placeholder">Выберите флаги...</span></div>
						<div class="tm-flags-dropdown" id="tm-regex-flags-dropdown"></div>
					</div>
				</div>

				<div class="tm-rule-row">
					<label class="tm-subtle">Флаги фильтра:</label>
					<div class="tm-flags-multiselect">
						<div class="tm-flags-display" id="tm-flags-display"><span class="tm-flags-placeholder">Выберите флаги...</span></div>
						<div class="tm-flags-dropdown" id="tm-flags-dropdown"></div>
					</div>
					<small>Клик вкл, Shift/Ctrl+клик искл. Не выбрано = игнор.</small>
				</div>

				<div class="tm-rule-row">
					<label for="tm-rule-punct" class="tm-choice">
						<input type="checkbox" id="tm-rule-punct"><span>Сохранить пунктуацию</span>
					</label>
				</div>

				<div class="tm-rule-row">
					<label for="tm-rule-cyrillic" class="tm-choice">
						<input type="checkbox" id="tm-rule-cyrillic" checked><span>Раскрывать кириллицу (o -> [oо0] и т.п.) </span>
					</label>
				</div>

				<div class="tm-rule-row">
					<label for="tm-rule-desc">Описание/категория:</label>
					<input type="text" id="tm-rule-desc" class="tm-input" placeholder="напр., спам, политика">
				</div>
			</div>

			<div class="tm-panel">
				<div class="tm-header">
					<h3 class="tm-h3">Тестер паттернов</h3>
					<div class="tm-rule-buttons">
						<button class="tm-button primary" id="tm-test-run">Тест</button>
						<button class="tm-button" id="tm-test-clear">Очистить</button>
					</div>
				</div>
				<div class="tm-rule-form">
					<div class="tm-rule-row">
						<label class="tm-subtle">Тестировать против:</label>
						<div id="tm-test-mode-dd" class="tm-flags-multiselect">
							<div class="tm-flags-display">
								<span class="tm-dd-current">Текущего редактора</span><span class="tm-dd-caret">▾</span>
							</div>
							<div class="tm-flags-dropdown"></div>
						</div>
					</div>
					<div class="tm-rule-row">
						<label for="tm-test-input">Тестовый текст:</label>
						<textarea id="tm-test-input" rows="6" placeholder="Текст для теста..."></textarea>
					</div>
					<div id="tm-test-result"></div>
				</div>
			</div>

			<div class="tm-panel">
				<div class="tm-header">
					<h3 class="tm-h3">Правила (<span id="tm-rules-count">0</span>)</h3>
					<div class="tm-rules-controls">
						<label class="tm-choice" id="tm-rules-scope-wrap" title="Вкл: борда. Выкл: глобальные">
							<input id="tm-rules-scope-toggle" type="checkbox">
							<span id="tm-rules-scope-label"></span>
						</label>
						<div id="tm-rules-filter-dd" class="tm-dd" aria-label="Фильтр по типу"></div>
						<button class="tm-button tm-danger" id="tm-rules-delete-selected" title="Удалить выбранные" disabled>Удалить</button>
					</div>
				</div>
				<div id="tm-rules-items"></div>
			</div>
		`;

		const regexFlagsDisplay = qs(rulesTab, '#tm-regex-flags-display');
		const regexFlagsDropdown = qs(rulesTab, '#tm-regex-flags-dropdown');
		regexFlagsDisplay.setAttribute('tabindex', '0');
		regexFlagsDisplay.setAttribute('role', 'button');
		regexFlagsDisplay.setAttribute('aria-haspopup', 'listbox');
		regexFlagsDisplay.setAttribute('aria-expanded', 'false');
		regexFlagsDropdown.setAttribute('role', 'listbox');
		regexFlagsDropdown.setAttribute('aria-expanded', 'false');

		const selectedRegexFlags = new Set();
		for (let i = 0; i < REGEX_FLAG_DEFINITIONS.length; i++) {
			if (REGEX_FLAG_DEFINITIONS[i].default) selectedRegexFlags.add(REGEX_FLAG_DEFINITIONS[i].key);
		}

		const flagsDisplay = qs(rulesTab, '#tm-flags-display');
		const flagsDropdown = qs(rulesTab, '#tm-flags-dropdown');
		flagsDisplay.setAttribute('tabindex', '0');
		flagsDisplay.setAttribute('role', 'button');
		flagsDisplay.setAttribute('aria-haspopup', 'listbox');
		flagsDisplay.setAttribute('aria-expanded', 'false');
		flagsDropdown.setAttribute('role', 'listbox');
		flagsDropdown.setAttribute('aria-expanded', 'false');

		const selectedFlags = new Map();

		let currentRuleType = 'thread';
		const ruleTypeWrap = qs(rulesTab, '#tm-rule-type-dd');

		let lastThreadFlags = new Map(), lastReplyFlags = new Map();

		const setRuleTypeUI = (val) => {
			if (currentRuleType === 'thread') lastThreadFlags = new Map(selectedFlags);
			else lastReplyFlags = new Map(selectedFlags);
			currentRuleType = val;
			selectedFlags.clear();
			sanitizeSelectedFlagsForType(val);
			const f = val === 'thread' ? lastThreadFlags : lastReplyFlags;
			const entries = Array.from(f.entries());
			for (let i = 0; i < entries.length; i++) {
				selectedFlags.set(entries[i][0], entries[i][1]);
			}
			buildFlagsDropdownOptions();
			flagsUI.updateDisplay();
		};

		const ruleTypeDD = createDropdown({
			container: ruleTypeWrap,
			options: [
				{ label: 'Фильтр тредов', value: 'thread' },
				{ label: 'Фильтр постов', value: 'reply' },
			],
			initialValue: 'thread',
			onChange: (val) => {
				if (editingRuleIndex !== null) return;
				setRuleTypeUI(val);
			},
		});

		const testModeWrap = qs(rulesTab, '#tm-test-mode-dd');
		const testModeDD = createDropdown({
			container: testModeWrap,
			options: [
				{ label: 'Текущего редактора', value: 'current' },
				{ label: 'Всех правил', value: 'all' },
				{ label: 'Правил тредов', value: 'thread' },
				{ label: 'Правил постов', value: 'reply' },
			],
			initialValue: 'current',
			onChange: () => {},
		});

		let pendingFocus = null;
		const queueFocus = (type, index, control) => { pendingFocus = { type, index, control }; };

		const focusAfterRender = () => {
			if (!pendingFocus) return;
			const { type, index, control } = pendingFocus;
			pendingFocus = null;

			if (control === 'edit-pattern') {
				opsManager.queueJsOp('modal:focus', () => qs(rulesTab, '#tm-rule-pattern')?.focus());
				return;
			}

			opsManager.queueJsOp('modal:focus', () => {
				const row = qs(rulesTab, `.tm-rule-item[data-type="${type}"][data-index="${index}"]`);
				if (!row) return;
				const sel = control === 'toggle' ? '.tm-rule-toggle' : control === 'move-up' ? '.tm-rule-move-up' : control === 'move-down' ? '.tm-rule-move-down' : null;
				if (sel) qs(row, sel)?.focus();
			});
		};

		const updateRegexFlagsDisplay = () => {
			regexFlagsDisplay.innerHTML = '';
			const flagsArray = Array.from(selectedRegexFlags);
			if (flagsArray.length === 0) {
				regexFlagsDisplay.innerHTML = '<span class="tm-flags-placeholder">Выберите флаги...</span>';
			} else {
				for (let i = 0; i < flagsArray.length; i++) {
					const key = flagsArray[i];
					const def = REGEX_FLAG_DEFINITIONS.find(x => x.key === key);
					const chip = document.createElement('div');
					chip.className = 'tm-flag-chip';
					chip.innerHTML = `<span>${escapeHtml(def?.name || key)} (${escapeHtml(key)})</span><span class="tm-flag-chip-remove" data-key="${escapeHtml(key)}">×</span>`;
					regexFlagsDisplay.appendChild(chip);
				}
			}
			regexFlagsDropdown.innerHTML = '';
			for (let i = 0; i < REGEX_FLAG_DEFINITIONS.length; i++) {
				const flag = REGEX_FLAG_DEFINITIONS[i];
				const n = document.createElement('div');
				n.className = 'tm-flag-option' + (selectedRegexFlags.has(flag.key) ? ' selected include' : '');
				n.dataset.key = flag.key;
				n.setAttribute('tabindex', '0');
				n.setAttribute('role', 'option');
				n.setAttribute('aria-selected', String(selectedRegexFlags.has(flag.key)));
				n.innerHTML = `
					<div class="tm-flag-option-check"></div>
					<div class="tm-flag-option-label">
						<div class="tm-flag-option-name">${escapeHtml(flag.name)} (${escapeHtml(flag.key)})</div>
						<div class="tm-flag-option-desc">${escapeHtml(flag.desc)}</div>
					</div>
				`;
				regexFlagsDropdown.appendChild(n);
			}
		};

		on(regexFlagsDisplay, 'click', (e) => {
			const rm = e.target.closest('.tm-flag-chip-remove');
			if (rm) { selectedRegexFlags.delete(rm.dataset.key); updateRegexFlagsDisplay(); return; }
			const wasOpen = regexFlagsDropdown.classList.contains('tm-open');
			closeAllDropdowns();
			if (!wasOpen) regexFlagsDropdown.classList.add('tm-open');
		});
		on(regexFlagsDropdown, 'click', (e) => {
			const opt = e.target.closest('.tm-flag-option');
			if (!opt) return;
			const key = opt.dataset.key;
			selectedRegexFlags.has(key) ? selectedRegexFlags.delete(key) : selectedRegexFlags.add(key);
			updateRegexFlagsDisplay();
		});
		on(regexFlagsDisplay, 'keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				closeAllDropdowns();
				regexFlagsDropdown.classList.toggle('tm-open');
				qs(regexFlagsDropdown, '.tm-flag-option')?.focus();
			}
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				closeAllDropdowns();
				regexFlagsDropdown.classList.add('tm-open');
				qs(regexFlagsDropdown, '.tm-flag-option')?.focus();
			}
		});
		on(regexFlagsDropdown, 'keydown', (e) => {
			const opts = qsa(regexFlagsDropdown, '.tm-flag-option');
			const idx = opts.indexOf(document.activeElement);
			if (e.key === 'Escape') { e.preventDefault(); regexFlagsDropdown.classList.remove('tm-open'); regexFlagsDisplay.focus(); }
			if (e.key === 'ArrowDown') { e.preventDefault(); opts[Math.min(idx + 1, opts.length - 1)]?.focus(); }
			if (e.key === 'ArrowUp') { e.preventDefault(); opts[Math.max(idx - 1, 0)]?.focus(); }
			if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.activeElement?.click(); }
		});

		const sanitizeSelectedFlagsForType = (type) => {
			const keysToCheck = Array.from(selectedFlags.keys());
			for (let i = 0; i < keysToCheck.length; i++) {
				const id = keysToCheck[i];
				const def = FLAG_BY_ID[id];
				if (!def || (type === 'thread' && def.replyOnly)) selectedFlags.delete(id);
			}
			if (type === 'reply' && CONFIG.PROPAGATE_TAINT_BY_DEFAULT && !selectedFlags.has('taint')) {
				selectedFlags.set('taint', 'include');
			}
		};

		const buildFlagsDropdownOptions = () => {
			flagsDropdown.innerHTML = '';
			for (let i = 0; i < FLAG_DEFINITIONS.length; i++) {
				const flag = FLAG_DEFINITIONS[i];
				if (currentRuleType === 'thread' && flag.replyOnly) continue;
				const n = document.createElement('div');
				n.className = 'tm-flag-option';
				n.dataset.key = flag.id;
				n.setAttribute('tabindex', '0');
				n.setAttribute('role', 'option');
				n.setAttribute('aria-selected', String(!!selectedFlags.get(flag.id)));
				n.innerHTML = `
					<div class="tm-flag-option-check"></div>
					<div class="tm-flag-option-label">
						<div class="tm-flag-option-name">${escapeHtml(flag.name)}</div>
						<div class="tm-flag-option-desc">${escapeHtml(flag.desc)}</div>
					</div>
				`;
				flagsDropdown.appendChild(n);
			}
		};

		const flagsUI = createFlagDisplay({
			display: flagsDisplay,
			dropdown: flagsDropdown,
			data: selectedFlags,
			onUpdate: () => {}
		});
		buildFlagsDropdownOptions();
		flagsUI.updateDisplay();

		let editingRuleIndex = null;
		let editingRuleType = null;

		let currentRulesScope = getPreferredRulesScope();
		let editingKey = currentRulesScope === 'board' ? BOARD_DATA_KEY : GLOBAL_FILTERS_KEY;

		const scopeToggle = qs(rulesTab, '#tm-rules-scope-toggle');
		const scopeLabel = qs(rulesTab, '#tm-rules-scope-label');
		scopeToggle.checked = currentRulesScope === 'board';
		scopeLabel.textContent = currentRulesScope === 'board' ? `Борда (/${BOARD_ID}/)` : 'Глобальные';

		scopeToggle.addEventListener('change', (e) => {
			currentRulesScope = e.target.checked ? 'board' : 'global';
			setPreferredRulesScope(currentRulesScope);
			editingKey = currentRulesScope === 'global' ? GLOBAL_FILTERS_KEY : BOARD_DATA_KEY;
			scopeLabel.textContent = currentRulesScope === 'board' ? `Борда (/${BOARD_ID}/)` : 'Глобальные';
			renderRulesList();
			reprocessAffectedPosts();
		});

		let currentRulesFilter = 'all';
		const filterDDDisplay = qs(rulesTab, '#tm-rules-filter-dd');
		filterDDDisplay.className = 'tm-flags-multiselect';
		filterDDDisplay.innerHTML = `
			<div class="tm-flags-display">
				<span class="tm-dd-current">Т+П</span><span class="tm-dd-caret">▾</span>
			</div>
			<div class="tm-flags-dropdown"></div>
		`;
		createDropdown({
			container: filterDDDisplay,
			options: [
				{ label: 'Т+П', value: 'all' },
				{ label: 'Т', value: 'thread' },
				{ label: 'П', value: 'reply' },
			],
			initialValue: 'all',
			onChange: (val) => { currentRulesFilter = val; renderRulesList(); },
		});

		const buildRuleObject = () => {
			const pattern = qs(rulesTab, '#tm-rule-pattern').value.trim();
			if (!pattern) return null;

			let propagateTaint = undefined;
			const flagEntries = Array.from(selectedFlags.entries());
			for (let i = 0; i < flagEntries.length; i++) {
				const [id, mode] = flagEntries[i];
				if (id === 'taint') {
					if (mode === 'include') propagateTaint = true;
					else if (mode === 'exclude') propagateTaint = false;
				}
			}

			return {
				pattern,
				flags: Array.from(selectedRegexFlags).join(''),
				flagMask: filterEngine.buildMaskFromSelections(selectedFlags),
				desc: qs(rulesTab, '#tm-rule-desc').value.trim(),
				preservePunct: !!qs(rulesTab, '#tm-rule-punct')?.checked,
				expandCyrillic: !!qs(rulesTab, '#tm-rule-cyrillic')?.checked,
				propagateTaint
			};
		};

		const loadRuleToForm = (ruleObj, ruleType) => {
			if (!ruleObj) return;
			setRuleTypeUI(ruleType === 'reply' ? 'reply' : 'thread');

			qs(rulesTab, '#tm-rule-pattern').value = ruleObj.pattern || '';
			selectedRegexFlags.clear();
			const flagsStr = ruleObj.flags || '';
			for (let i = 0; i < flagsStr.length; i++) {
				if (flagsStr[i]) selectedRegexFlags.add(flagsStr[i]);
			}
			updateRegexFlagsDisplay();

			selectedFlags.clear();
			const mask = ruleObj.flagMask >>> 0;
			for (let i = 0; i < FLAG_DEFINITIONS.length; i++) {
				const c = FLAG_DEFINITIONS[i];
				if (c.include && (mask & c.include)) selectedFlags.set(c.id, 'include');
				else if (c.exclude && (mask & c.exclude)) selectedFlags.set(c.id, 'exclude');
			}
			qs(rulesTab, '#tm-rule-punct').checked = !!ruleObj.preservePunct;
			qs(rulesTab, '#tm-rule-desc').value = ruleObj.desc || '';
			buildFlagsDropdownOptions();
			flagsUI.updateDisplay();
			qs(rulesTab, '#tm-rule-cyrillic').checked = ruleObj.expandCyrillic !== false;
		};

		const resetRuleForm = () => {
			qs(rulesTab, '#tm-rule-pattern').value = '';
			qs(rulesTab, '#tm-rule-desc').value = '';
			qs(rulesTab, '#tm-rule-punct').checked = false;
			qs(rulesTab, '#tm-rule-cyrillic').checked = true;
			selectedRegexFlags.clear();
			for (let i = 0; i < REGEX_FLAG_DEFINITIONS.length; i++) {
				const f = REGEX_FLAG_DEFINITIONS[i];
				if (f.default) selectedRegexFlags.add(f.key);
			}
			updateRegexFlagsDisplay();
			selectedFlags.clear();
			if (currentRuleType === 'reply' && CONFIG.PROPAGATE_TAINT_BY_DEFAULT) selectedFlags.set('taint', 'include');
			buildFlagsDropdownOptions();
			flagsUI.updateDisplay();
		};

		const testSingleRule = (testInput, ruleObj, resultDiv) => {
			try {
				let testPattern = ruleObj.pattern;
				if (ruleObj.expandCyrillic) testPattern = filterEngine.expandCyrillicInPattern(testPattern);
				new RegExp(testPattern, ruleObj.flags);
				const compiled = filterEngine.constructFilterObj(ruleObj);
				if (!compiled) {
					resultDiv.innerHTML = '<div class="tm-test-error"><strong>Ошибка:</strong> Не удалось скомпилировать</div>';
					return;
				}
				const preservePunct = !!compiled.preservePunct;
				const normalized = normalizeText(testInput, preservePunct, false);
				const match = normalized.match(compiled.pattern);
				if (match) {
					const { map } = normalizeText(testInput, preservePunct, true);
					const rawStart = map[match.index];
					const rawEnd = map[match.index + match[0].length - 1];
					if (typeof rawStart !== 'number' || typeof rawEnd !== 'number') {
						resultDiv.innerHTML = '<div class="tm-test-error"><strong>Ошибка:</strong> Не удалось сопоставить</div>';
						return;
					}
					resultDiv.innerHTML = `
						<div class="tm-test-success">
							<strong>✓ Совпадение!</strong>
							<div class="tm-test-preview">${escapeHtml(testInput.slice(0, rawStart))}<span class="tm-highlight">${escapeHtml(testInput.slice(rawStart, rawEnd + 1))}</span>${escapeHtml(testInput.slice(rawEnd + 1))}</div>
							<div class="tm-test-details">
								<div>Оригинальный: <code>${escapeHtml(ruleObj.pattern)}</code></div>
								${ruleObj.expandCyrillic ? `<div>Раскрытый: <code>${escapeHtml(testPattern)}</code></div>` : ''}
								<div>Скомпилированный: <code>${escapeHtml(compiled.pattern.source)}</code></div>
								<div>Флаги: <code>${escapeHtml(compiled.pattern.flags)}</code></div>
								${compiled.desc ? `<div>Категория: <strong>${escapeHtml(compiled.desc)}</strong></div>` : ''}
							</div>
						</div>
					`;
				} else {
					resultDiv.innerHTML = `
						<div class="tm-test-nomatch">
							<strong>✗ Нет совпадений</strong>
							<div class="tm-test-details">
								<div>Оригинальный: <code>${escapeHtml(ruleObj.pattern)}</code></div>
								${ruleObj.expandCyrillic ? `<div>Раскрытый: <code>${escapeHtml(testPattern.length > 100 ? testPattern.slice(0, 100) + '...' : testPattern)}</code></div>` : ''}
								<div>Скомпилированный: <code>${escapeHtml(compiled.pattern.source.length > 100 ? compiled.pattern.source.slice(0, 100) + '...' : compiled.pattern.source)}</code></div>
								<div>Флаги: <code>${escapeHtml(compiled.pattern.flags)}</code></div>
								<div>Нормализованный (200 символов): <code>${escapeHtml(normalized.slice(0, 200))}${normalized.length > 200 ? '...' : ''}</code></div>
							</div>
						</div>
					`;
				}
			} catch (e) {
				console.error('[abufilter] Regex compile failed:', { source: 'testSingleRule', error: e, stack: e?.stack });
				resultDiv.innerHTML = `<div class="tm-test-error"><strong>Ошибка:</strong> ${escapeHtml(e.message)}</div>`;
			}
		};

		const testMultipleRules = (testInput, rulesToTest, resultDiv) => {
			const matches = [], errors = [];

			for (let i = 0; i < rulesToTest.length; i++) {
				const rule = rulesToTest[i];
				if (rule.disabled) continue;

				try {
					let testPattern = rule.pattern;
					if (rule.expandCyrillic !== false) testPattern = filterEngine.expandCyrillicInPattern(testPattern);
					new RegExp(testPattern, rule.flags);
					const compiled = filterEngine.constructFilterObj(rule);
					if (!compiled) continue;

					const preservePunct = !!compiled.preservePunct;
					const normalized = normalizeText(testInput, preservePunct, false);
					const match = normalized.match(compiled.pattern);

					if (match) matches.push({ rule, index: i, match, normalized, preservePunct });
				} catch (e) {
					errors.push({ rule, index: i, error: e, stack: e?.stack });
				}
			}

			let html = '';

			if (matches.length > 0) {
				html += '<div class="tm-test-success"><strong>✓ Найдено совпадений: ' + matches.length + '</strong><div class="tm-test-multi-results">';
				for (let i = 0; i < matches.length; i++) {
					const { rule, match, preservePunct } = matches[i];
					const { map } = normalizeText(testInput, preservePunct, true);
					const rawStart = map[match.index];
					const rawEnd = map[match.index + match[0].length - 1];

					if (typeof rawStart === 'number' && typeof rawEnd === 'number') {
						const displayPattern = rule.pattern.length > 40 ? rule.pattern.slice(0, 40) + '...' : rule.pattern;
						html += `
							<div class="tm-test-multi-item">
								<div class="tm-test-multi-header">
									<span class="tm-rule-type-badge">${escapeHtml(rule.type === 'thread' ? 'Т' : 'П')}</span>
									<span class="tm-test-multi-pattern">${escapeHtml(displayPattern)}</span>
									${rule.desc ? `<span class="tm-rule-desc-badge">${escapeHtml(rule.desc)}</span>` : ''}
								</div>
								<div class="tm-test-preview">${escapeHtml(testInput.slice(0, rawStart))}<span class="tm-highlight">${escapeHtml(testInput.slice(rawStart, rawEnd + 1))}</span>${escapeHtml(testInput.slice(rawEnd + 1))}</div>
							</div>
						`;
					}
				}
				html += '</div></div>';
			}

			if (errors.length > 0) {
				html += '<div class="tm-test-error"><strong>Ошибки компиляции: ' + errors.length + '</strong><div class="tm-test-details">';
				for (let i = 0; i < errors.length; i++) {
					const { rule, error } = errors[i];
					const displayPattern = rule.pattern.length > 40 ? rule.pattern.slice(0, 40) + '...' : rule.pattern;
					html += `<div><code>${escapeHtml(displayPattern)}</code>: ${escapeHtml(error)}</div>`;
				}
				html += '</div></div>';
			}

			if (matches.length === 0 && errors.length === 0) {
				html = '<div class="tm-test-nomatch"><strong>✗ Нет совпадений</strong></div>';
			}

			resultDiv.innerHTML = html;
		};

		on(qs(rulesTab, '#tm-test-run'), 'click', () => {
			const testInput = qs(rulesTab, '#tm-test-input')?.value || '';
			const resultDiv = qs(rulesTab, '#tm-test-result');
			const testMode = testModeDD.getValue();

			if (!testInput.trim()) {
				if (resultDiv) resultDiv.innerHTML = '<div class="tm-test-error"><strong>Ошибка:</strong> Введите текст</div>';
				return;
			}

			if (testMode === 'current') {
				const ruleObj = buildRuleObject();
				if (!ruleObj) {
					if (resultDiv) resultDiv.innerHTML = '<div class="tm-test-error"><strong>Ошибка:</strong> Введите паттерн</div>';
					return;
				}
				testSingleRule(testInput, ruleObj, resultDiv);
			} else {
				const stored = safeGet(editingKey, {});
				let rulesToTest = [];

				if (testMode === 'all') {
					rulesToTest = [
						...((stored.threadRules || []).map(r => ({ ...r, type: 'thread' }))),
						...((stored.replyRules || []).map(r => ({ ...r, type: 'reply' })))
					];
				} else if (testMode === 'thread') {
					rulesToTest = (stored.threadRules || []).map(r => ({ ...r, type: 'thread' }));
				} else if (testMode === 'reply') {
					rulesToTest = (stored.replyRules || []).map(r => ({ ...r, type: 'reply' }));
				}

				if (!rulesToTest.length) {
					if (resultDiv) resultDiv.innerHTML = '<div class="tm-test-nomatch"><strong>Нет правил для теста</strong></div>';
					return;
				}

				testMultipleRules(testInput, rulesToTest, resultDiv);
			}
		});

		on(qs(rulesTab, '#tm-test-clear'), 'click', () => {
			const testInput = qs(rulesTab, '#tm-test-input');
			if (testInput) testInput.value = '';
			const resultDiv = qs(rulesTab, '#tm-test-result');
			if (resultDiv) resultDiv.innerHTML = '';
		});

		const formatMaskForBadges = (mask) => {
			const tags = [];
			for (let i = 0; i < FLAG_DEFINITIONS.length; i++) {
				const c = FLAG_DEFINITIONS[i];
				if (c.include && (mask & c.include)) tags.push(c.id);
				else if (c.exclude && (mask & c.exclude)) tags.push('!' + c.id);
			}
			return tags;
		};

		const renderRulesList = () => {
			const filter = currentRulesFilter;
			const itemsDiv = qs(rulesTab, '#tm-rules-items');
			const countSpan = qs(rulesTab, '#tm-rules-count');
			const stored = safeGet(editingKey, {});
			const threadRules = (stored.threadRules || []).map((r, i) => ({ rule: r, index: i, type: 'thread' }));
			const replyRules = (stored.replyRules || []).map((r, i) => ({ rule: r, index: i, type: 'reply' }));
			let all = [...threadRules, ...replyRules];
			if (filter !== 'all') all = all.filter(r => r.type === filter);

			setText(countSpan, all.length);
			if (!all.length) {
				if (itemsDiv) itemsDiv.innerHTML = '<div class="tm-rules-items-empty">Нет правил</div>';
				filterEngine.compileActiveFilters();
				return;
			}

			const frag = document.createDocumentFragment();
			for (let i = 0; i < all.length; i++) {
				const { rule, index, type } = all[i];
				const isDisabled = !!rule.disabled;
				const isLastOfType = (type === 'thread'
					? index === (stored.threadRules || []).length - 1
					: index === (stored.replyRules || []).length - 1);

				let hasError = false;
				let errorMsg = '';
				try {
					let testPattern = rule.pattern;
					if (rule.expandCyrillic !== false) testPattern = filterEngine.expandCyrillicInPattern(testPattern);
					new RegExp(testPattern, rule.flags || '');
				} catch (e) {
					hasError = true;
					errorMsg = e.message;
				}

				const row = document.createElement('div');
				row.className = 'tm-rule-item' + (isDisabled ? ' disabled' : '') + (hasError ? ' tm-rule-error' : '');
				row.dataset.type = type;
				row.dataset.index = String(index);
				row.tabIndex = 0;

				const displayPattern = rule.pattern.length > 60 ? rule.pattern.slice(0, 60) + '...' : rule.pattern;
				const activeFlags = formatMaskForBadges(rule.flagMask);
				const flagsInfo = activeFlags.length ? ` [${activeFlags.join(',')}]` : '';
				const regexFlagsInfo = rule.flags ? ` /${rule.flags}` : '';

				const descBadge = rule.desc ? `<span class="tm-rule-desc-badge">${escapeHtml(rule.desc)}</span>` : '';
				const disabledBadge = isDisabled ? `<span class="tm-rule-desc-badge tm-rule-disabled-badge">Выкл</span>` : '';
				const errorBadge = hasError ? `<span class="tm-rule-desc-badge tm-rule-error-badge" title="${escapeHtml(errorMsg)}">Ошибка</span>` : '';

				row.innerHTML = `
					<div class="tm-rule-header">
						<button class="tm-rule-btn tm-rule-toggle" style="color: var(--tm-${isDisabled ? 'ok' : 'warn'});"
							title="${isDisabled ? 'Включить' : 'Выключить'}"
							aria-label="${isDisabled ? 'Включить' : 'Выключить'}"
							aria-pressed="${!isDisabled}">
								${isDisabled ?
								`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
									<path d="M7 5v14l12-7L7 5Z" fill="currentColor"/>
								</svg>`
								:
								`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
							        <rect x="7" y="6" width="3" height="12" fill="currentColor"/>
							        <rect x="14" y="6" width="3" height="12" fill="currentColor"/>
							    </svg>`}
						</button>
						<span class="tm-rule-type-badge">${escapeHtml(type === 'thread' ? 'Т' : 'П')}</span>
						<span class="tm-rule-pattern" title="${escapeHtml(rule.pattern)}">${escapeHtml(displayPattern)}${escapeHtml(flagsInfo)}${escapeHtml(regexFlagsInfo)}</span>
						${descBadge}
						${rule.preservePunct ? `<span class="tm-rule-desc-badge">С пунктуацией</span>` : ''}
						${errorBadge}
						${disabledBadge}
					</div>
					<div class="tm-rule-actions">
						<button class="tm-rule-btn tm-rule-edit" title="Редактировать" aria-label="Редактировать">✎</button>
						<button class="tm-rule-btn tm-rule-move-up" title="Вверх" aria-label="Вверх" ${index === 0 ? 'disabled' : ''}>↑</button>
						<button class="tm-rule-btn tm-rule-move-down" title="Вниз" aria-label="Вниз" ${isLastOfType ? 'disabled' : ''}>↓</button>
					</div>
				`;
				frag.appendChild(row);
			}

			if (itemsDiv) {
				itemsDiv.innerHTML = '';
				itemsDiv.appendChild(frag);
			}
			filterEngine.compileActiveFilters();
			focusAfterRender();
		};

		const ruleActions = {
			edit: (type, index, list) => {
				if (!list[index]) {
					notify.error('Ошибка: правило не найдено');
				} else {
					editingRuleIndex = index;
					editingRuleType = type;
					ruleTypeDD.setValue(type);
					loadRuleToForm(list[index], type);
					const addBtn = qs(rulesTab, '#tm-rule-add');
					const updateBtn = qs(rulesTab, '#tm-rule-update');
					const cancelBtn = qs(rulesTab, '#tm-rule-cancel');
					if (addBtn) addBtn.style.display = 'none';
					if (updateBtn) updateBtn.style.display = '';
					if (cancelBtn) cancelBtn.style.display = '';
					qs(rulesTab, '#tm-rules-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
					if (ruleTypeWrap) {
						ruleTypeWrap.style.pointerEvents = 'none';
						ruleTypeWrap.style.opacity = '0.5';
					}
					opsManager.queueJsOp('modal:focus', () => qs(rulesTab, '#tm-rule-pattern')?.focus());
				}
			},

			move: (type, index, list, direction) => {
				const newIndex = index + direction;
				if (newIndex < 0 || newIndex >= list.length) return;
				[list[index], list[newIndex]] = [list[newIndex], list[index]];
				const stored = safeGet(editingKey, {});
				if (type === 'thread') stored.threadRules = list;
				else stored.replyRules = list;
				safeSet(editingKey, stored);
				queueFocus(type, newIndex, direction < 0 ? 'move-up' : 'move-down');
				renderRulesList();
			},

			toggle: (type, index, list) => {
				list[index].disabled = !list[index].disabled;
				const stored = safeGet(editingKey, {});
				if (type === 'thread') stored.threadRules = list;
				else stored.replyRules = list;
				safeSet(editingKey, stored);
				queueFocus(type, index, 'toggle');
				renderRulesList();
				reprocessAffectedPosts();
			}
		};

		on(qs(rulesTab, '#tm-rules-items'), 'click', (e) => {
			const row = e.target.closest('.tm-rule-item');
			if (!row) return;

			const type = row.dataset.type;
			const index = parseInt(row.dataset.index, 10);
			const stored = safeGet(editingKey, {});
			const list = (type === 'thread' ? stored.threadRules : stored.replyRules) || [];

			if (e.target.closest('.tm-rule-edit')) {
				ruleActions.edit(type, index, list);
			} else if (e.target.closest('.tm-rule-move-up')) {
				ruleActions.move(type, index, list, -1);
			} else if (e.target.closest('.tm-rule-move-down')) {
				ruleActions.move(type, index, list, 1);
			} else if (e.target.closest('.tm-rule-toggle')) {
				ruleActions.toggle(type, index, list);
				const btn = e.target.closest('.tm-rule-toggle');
				if (btn) btn.setAttribute('aria-pressed', String(btn.getAttribute('aria-pressed') !== 'true'));
			} else {
				row.classList.toggle('selected');
				const deleteBtn = qs(rulesTab, '#tm-rules-delete-selected');
				if (deleteBtn) deleteBtn.disabled = !qs(rulesTab, '.tm-rule-item.selected');
			}
		});

		on(qs(rulesTab, '#tm-rules-items'), 'keydown', e => {
			if (e.key !== ' ' && e.key !== 'Enter') return;

			const active = document.activeElement || e.target;
			const row = active.closest('.tm-rule-item') || e.target.closest('.tm-rule-item');
			if (!row) return;

			e.preventDefault();

			const type = row.dataset.type;
			const index = parseInt(row.dataset.index, 10);
			const stored = safeGet(editingKey, {});
			const list = (type === 'thread' ? (stored.threadRules || []) : (stored.replyRules || []));

			if (active.closest('.tm-rule-edit')) {
				ruleActions.edit(type, index, list);
				return;
			} else if (active.closest('.tm-rule-move-up')) {
				ruleActions.move(type, index, list, -1);
				return;
			} else if (active.closest('.tm-rule-move-down')) {
				ruleActions.move(type, index, list, 1);
				return;
			} else {
				const onToggle = active.closest('.tm-rule-toggle');
				if (onToggle) {
					ruleActions.toggle(type, index, list);
					onToggle.setAttribute('aria-pressed', String(onToggle.getAttribute('aria-pressed') !== 'true'));
					return;
				}
			}

			row.classList.toggle('selected');
			row.setAttribute('aria-selected', row.classList.contains('selected'));
			const deleteBtn = qs(rulesTab, '#tm-rules-delete-selected');
			if (deleteBtn) deleteBtn.disabled = !qs(rulesTab, '.tm-rule-item.selected');
		});

		const exitEditMode = () => {
			editingRuleIndex = null; editingRuleType = null;
			const addBtn = qs(rulesTab, '#tm-rule-add');
			const updateBtn = qs(rulesTab, '#tm-rule-update');
			const cancelBtn = qs(rulesTab, '#tm-rule-cancel');
			if (addBtn) addBtn.style.display = '';
			if (updateBtn) updateBtn.style.display = 'none';
			if (cancelBtn) cancelBtn.style.display = 'none';
			if (ruleTypeWrap) {
				ruleTypeWrap.style.pointerEvents = '';
				ruleTypeWrap.style.opacity = '';
			}
		};

		on(qs(rulesTab, '#tm-rule-add'), 'click', () => {
			const ruleObj = buildRuleObject();
			if (!ruleObj) {
				notify.error('Введите паттерн');
				return;
			}

			const type = currentRuleType;
			const stored = safeGet(editingKey, {});
			stored.threadRules = stored.threadRules || [];
			stored.replyRules = stored.replyRules || [];
			const list = (type === 'thread' ? stored.threadRules : stored.replyRules);

			try {
				new RegExp(filterEngine.expandCyrillicInPattern(ruleObj.pattern), ruleObj.flags);
				list.push(ruleObj);
				if (type === 'thread') stored.threadRules = list;
				else stored.replyRules = list;
				safeSet(editingKey, stored);
				renderRulesList();
				resetRuleForm();
				reprocessAffectedPosts();
			} catch (e) {
				console.error('[abufilter] Failed to compile regex:', { source: '#tm-rule-add click handler', error: e, stack: e?.stack });
				notify.error('Неверный паттерн: ' + e.message);
			}
		});

		on(qs(rulesTab, '#tm-rule-update'), 'click', () => {
			if (editingRuleIndex === null) return;
			const ruleObj = buildRuleObject();
			if (!ruleObj) {
				notify.error('Введите паттерн');
				return;
			}

			const stored = safeGet(editingKey, {});
			stored.threadRules = stored.threadRules || [];
			stored.replyRules = stored.replyRules || [];
			const list = (editingRuleType === 'thread' ? stored.threadRules : stored.replyRules);

			if (!list[editingRuleIndex]) {
				notify.error('Ошибка: правило не найдено');
				exitEditMode();
				return;
			}

			try {
				new RegExp(filterEngine.expandCyrillicInPattern(ruleObj.pattern), ruleObj.flags);
				list[editingRuleIndex] = ruleObj;
				if (editingRuleType === 'thread') stored.threadRules = list;
				else stored.replyRules = list;
				safeSet(editingKey, stored);
				renderRulesList();
				exitEditMode();
				resetRuleForm();
				reprocessAffectedPosts();
			} catch (e) {
				console.error('[abufilter] Failed to compile regex:', { source: '#tm-rule-update click handler', error: e, stack: e?.stack });
				notify.error('Неверный паттерн: ' + e.message);
			}
		});

		on(qs(rulesTab, '#tm-rule-cancel'), 'click', () => {
			exitEditMode();
			resetRuleForm();
		});

		on(qs(rulesTab, '#tm-rules-delete-selected'), 'click', () => {
			const selected = qsa(rulesTab, '.tm-rule-item.selected');
			if (!selected.length) {
				notify.warning('Не выбрано правил');
				return;
			}

			confirmDialog(
				`Удалить ${selected.length} правил(а)?`,
				() => {
					const stored = safeGet(editingKey, {});
					stored.threadRules = stored.threadRules || [];
					stored.replyRules = stored.replyRules || [];

					const toDelete = [];
					for (let i = 0; i < selected.length; i++) {
						const row = selected[i];
						toDelete.push({
							type: row.dataset.type,
							index: parseInt(row.dataset.index, 10)
						});
					}

					const byType = toDelete.reduce((m, r) => {
						(m[r.type] = m[r.type] || []).push(r.index);
						return m;
					}, {});

					const typeKeys = Object.keys(byType);
					for (let i = 0; i < typeKeys.length; i++) {
						const t = typeKeys[i];
						const list = (t === 'thread') ? stored.threadRules : stored.replyRules;
						const indices = byType[t].sort((a, b) => b - a);
						for (let j = 0; j < indices.length; j++) {
							const idx = indices[j];
							if (list[idx] != null) list.splice(idx, 1);
						}
						if (t === 'thread') stored.threadRules = list;
						else stored.replyRules = list;
					}

					safeSet(editingKey, stored);

					notify.success('Правила удалены');
					renderRulesList();
					reprocessAffectedPosts();
				}
			);
		});

		setRuleTypeUI('thread');
		updateRegexFlagsDisplay();
		renderRulesList();

		/* ================== CLEAR TAB ================== */
		const counts = computeCounts(currentThreadContainer);

		const clearHeaderHtml = `
			<div class="tm-panel" id="tm-clear-header">
				<div class="tm-header">
					<h3 class="tm-h3">
						${currentThreadId && currentThreadContainer
							? `Очистка для /${BOARD_ID}/res/${currentThreadId}/`
							: `Очистка для /${BOARD_ID}/`}
					</h3>
					<div class="tm-actions">
						<button type="button" class="tm-button primary" id="tm-clear-confirm" data-action="clear-selected">Очистить</button>
					</div>
				</div>
			</div>
		`;

		const threadSectionHtml = currentThreadId && currentThreadContainer ? `
			<section class="tm-section tm-panel" data-section="thread">
				<div class="tm-header">
					<h4 class="tm-h4">Этот тред</h4>
					<label class="tm-select-all tm-choice">
						<input type="checkbox" class="tm-select-all-chk" data-target="thread"> Выбрать всё
					</label>
				</div>
				<div class="tm-clear-grid">
					<div class="tm-choice"><input type="checkbox" id="tm-clear-manual-collapsed-thread" class="tm-thread-opt" checked><label for="tm-clear-manual-collapsed-thread">Свёрнутые (вручную) (${counts.manualCollapsed})</label></div>
					<div class="tm-choice"><input type="checkbox" id="tm-clear-media-thread" class="tm-thread-opt"><label for="tm-clear-media-thread">Медиа (вручную) (${counts.media})</label></div>
				</div>
			</section>
		` : '';

		const boardSectionHtml = `
			<section class="tm-section tm-panel" data-section="board">
				<div class="tm-header">
					<h4 class="tm-h4">Эта борда</h4>
					<label class="tm-select-all tm-choice">
						<input type="checkbox" class="tm-select-all-chk" data-target="board"> Выбрать всё
					</label>
				</div>
				<div class="tm-clear-grid">
					<div class="tm-choice"><input type="checkbox" id="tm-clear-hidden-board"    class="tm-board-opt" checked><label for="tm-clear-hidden-board">Скрытые (вручную) (${counts.manualHidden})</label></div>
					<div class="tm-choice"><input type="checkbox" id="tm-clear-collapsed-board" class="tm-board-opt" checked><label for="tm-clear-collapsed-board">Свёрнутые (вручную) (${counts.manualCollapsed})</label></div>
					<div class="tm-choice"><input type="checkbox" id="tm-clear-whitelist-board" class="tm-board-opt"><label for="tm-clear-whitelist-board">Белый список (${counts.whitelist})</label></div>
					<div class="tm-choice"><input type="checkbox" id="tm-clear-media-board" class="tm-board-opt"><label for="tm-clear-media-board">Медиа (вручную) (${counts.media})</label></div>
				</div>
			</section>
		`;

		clearTab.innerHTML = clearHeaderHtml + threadSectionHtml + boardSectionHtml;

		const bool = (sel) => !!qs(clearTab, sel)?.checked;

		const confirmBtn = qs(clearTab, '#tm-clear-confirm');
		const getClearSelections = () => ({
			manualCollapsedThread: bool('#tm-clear-manual-collapsed-thread'),
			mediaThread: bool('#tm-clear-media-thread'),
			hiddenBoard: bool('#tm-clear-hidden-board'),
			collapsedBoard: bool('#tm-clear-collapsed-board'),
			mediaBoard: bool('#tm-clear-media-board'),
			whitelistBoard: bool('#tm-clear-whitelist-board'),
		});

		const updateConfirmEnabled = () => {
			if (confirmBtn) confirmBtn.disabled = !Object.values(getClearSelections()).some(Boolean);
		};

		qsa(clearTab, '.tm-select-all-chk').forEach(chk => {
			on(chk, 'change', (e) => {
				const target = e.target.dataset.target;
				const selector = target === 'thread' ? '.tm-thread-opt' : '.tm-board-opt';
				qsa(clearTab, selector).forEach(cb => cb.checked = e.target.checked);
				updateConfirmEnabled();
			});
		});

		qsa(clearTab, 'input[type="checkbox"]').forEach(chk => on(chk, 'change', updateConfirmEnabled));
		updateConfirmEnabled();

		const removeFromState = (ids, opts = {}) => {
			const idsArray = Array.from(ids);
			for (let i = 0; i < idsArray.length; i++) {
				const id = idsArray[i];
				if (opts.manualHidden) {
					const st = stateManager.getHidden(id);
					if (st) st.reason = 'cleanup';
				}
				if (opts.manualCollapsed) {
					const st = stateManager.getCollapsed(id);
					if (st) st.reason = 'cleanup';
				}
				if (opts.media) stateManager.deleteMediaCollapsed(id);
				if (opts.whitelist) stateManager.deleteWhitelist(id);
			}
		};

		on(confirmBtn, 'click', () => {
			const { manualCollapsedThread, mediaThread, hiddenBoard, collapsedBoard, mediaBoard, whitelistBoard } = getClearSelections();

			const idsToReprocess = new Set();
			const idsToTouch = new Set();

			stateManager.forEach((id, st) => {
				const isCurrentThreadPost = currentThreadId && currentThreadContainer && inThread(currentThreadContainer, id);
				if (isCurrentThreadPost) {
					if (manualCollapsedThread && st.collapsed?.reason === 'manual') {
						idsToReprocess.add(id);
						idsToTouch.add(id);
					}
					if (mediaThread && st.mediaCollapsed) {
						postProcessor.toggleMedia(id, false);
						idsToTouch.add(id);
					}
				}

				if (hiddenBoard && st.hidden?.reason === 'manual') {
					idsToReprocess.add(id);
					idsToTouch.add(id);
				}
				if (collapsedBoard && st.collapsed?.reason === 'manual') {
					idsToReprocess.add(id);
					idsToTouch.add(id);
				}
				if (mediaBoard && st.mediaCollapsed) {
					postProcessor.toggleMedia(id, false);
					idsToTouch.add(id);
				}
				if (whitelistBoard && st.whitelist) {
					postProcessor.toggleWhitelist(id, false);
					idsToTouch.add(id);
				}
			});

			removeFromState(idsToTouch, {
				manualHidden: hiddenBoard,
				manualCollapsed: manualCollapsedThread || collapsedBoard,
				media: mediaThread || mediaBoard,
				whitelist: whitelistBoard
			});

			for (const id of Array.from(idsToReprocess)) postProcessor.processPost(Post.get(id));

			opsManager.scheduleSave();
			updateAllCounters();
			notify.success('Данные очищены');
		});

		/* ================== CONFIG TAB ================== */
		let currentConfigScope = getPreferredConfigScope();

		const renderConfigField = (def, value) => {
			if (def.type === 'checkbox') {
				return `
					<div class="tm-config-field" data-key="${escapeHtml(def.key)}">
						<label class="tm-choice tm-choice-card">
							<input type="checkbox" ${value ? 'checked' : ''} data-key="${escapeHtml(def.key)}">
							<div class="tm-config-label">
								<div class="tm-config-title">${escapeHtml(def.label)}${def.needsReload ? ' <span style="color:var(--tm-warn)">*</span>' : ''}</div>
								<div class="tm-config-desc tm-subtle">${escapeHtml(def.desc)}</div>
							</div>
						</label>
						<div class="tm-config-error"></div>
					</div>
				`;
			}
			if (def.type === 'number') {
				return `
					<div class="tm-config-field" data-key="${escapeHtml(def.key)}">
						<label>
							<div class="tm-config-title">${escapeHtml(def.label)}${def.needsReload ? ' <span style="color:var(--tm-warn)">*</span>' : ''}</div>
							<input class="tm-nosnap" type="number" value="${escapeHtml(String(value))}" min="${def.min}" max="${def.max}" data-key="${escapeHtml(def.key)}" inputmode="numeric" step="1">
							<div class="tm-config-desc tm-subtle">${escapeHtml(def.desc)} (${def.min}–${def.max})</div>
							<div class="tm-config-error"></div>
						</label>
					</div>
				`;
			}
			return '';
		};

		const renderConfig = () => {
			currentConfigScope = getPreferredConfigScope();
			const cfg = loadConfigFromStorage(currentConfigScope);

			const pos = cfg.MANAGER_BUTTON_POSITION || 'bottom-left';
			const posOptions = [
				{ v: 'top-right', t: 'Вверху справа' },
				{ v: 'top-left', t: 'Вверху слева' },
				{ v: 'bottom-right', t: 'Внизу справа' },
				{ v: 'bottom-left', t: 'Внизу слева' },
			];

			const posField = `
				<div class="tm-config-field">
					<label>
						<div class="tm-config-title">Позиция кнопки</div>
						<div class="tm-config-desc tm-subtle">Расположение кнопки менеджера</div>
						<div class="tm-flags-multiselect" id="tm-manager-pos-dd">
							<div class="tm-flags-display">
								<span class="tm-dd-current">${escapeHtml(posOptions.find(p => p.v === pos)?.t || 'Вверху слева')}</span>
								<span class="tm-dd-caret">▾</span>
							</div>
							<div class="tm-flags-dropdown"></div>
						</div>
					</label>
				</div>
			`;

			const basicFields = [posField];
			for (let i = 0; i < CONFIG_DEFINITIONS.basic.length; i++) {
				basicFields.push(renderConfigField(CONFIG_DEFINITIONS.basic[i], cfg[CONFIG_DEFINITIONS.basic[i].key]));
			}
			const basic = basicFields.join('');

			const advFields = [];
			for (let i = 0; i < CONFIG_DEFINITIONS.advanced.length; i++) {
				advFields.push(renderConfigField(CONFIG_DEFINITIONS.advanced[i], cfg[CONFIG_DEFINITIONS.advanced[i].key]));
			}
			const adv = advFields.join('');
			const isBoardScope = currentConfigScope === 'board';

			configTab.innerHTML = `
				<div class="tm-panel">
					<div class="tm-header">
						<h3 class="tm-h3">Настройки</h3>
						<div class="tm-rules-controls">
							<label class="tm-choice" title="Настройки для борды">
								<input id="tm-config-scope-toggle" type="checkbox" ${isBoardScope ? 'checked' : ''}>
								<span>Борда (/${BOARD_ID}/)</span>
							</label>
						</div>
						<button class="tm-button primary" id="tm-config-save">Сохранить</button>
					</div>
				</div>
				<div id="tm-config-body">
					<div class="tm-panel tm-config-section">
						<h4 class="tm-h4">Основные</h4>
						<div class="tm-config-grid">${basic}</div>
					</div>

					<div class="tm-panel tm-config-section">
						<h4 class="tm-h4">Расширенные</h4>
						<div class="tm-config-grid">${adv}</div>
					</div>
					<div class="tm-panel" style="padding:12px;color:var(--tm-muted);font-size:0.9em;">
						<span style="color:var(--tm-warn)">*</span> — требуется перезагрузка страницы
					</div>
				</div>
			`;

			const scopeToggleEl = qs(configTab, '#tm-config-scope-toggle');
			if (scopeToggleEl) {
				scopeToggleEl.addEventListener('change', (e) => {
					currentConfigScope = e.target.checked ? 'board' : 'global';
					setPreferredConfigScope(currentConfigScope);
					renderConfig();
				});
			}

			const posWrap = qs(configTab, '#tm-manager-pos-dd');
			const posDropdownEl = qs(posWrap, '.tm-flags-dropdown');
			if (posDropdownEl) {
				posDropdownEl.innerHTML = posOptions.map(p =>
					`<div class="tm-flag-option ${p.v === pos ? 'selected' : ''}" data-value="${escapeHtml(p.v)}">
						<div class="tm-flag-option-label"><div class="tm-flag-option-name">${escapeHtml(p.t)}</div></div>
					</div>`
				).join('');
			}

			const posDD = createDropdown({
				container: posWrap,
				options: posOptions.map(p => ({ label: p.t, value: p.v })),
				initialValue: pos,
				onChange: applyManagerButtonPosition
			});

			const defs = [...CONFIG_DEFINITIONS.basic, ...CONFIG_DEFINITIONS.advanced];
			const defMap = Object.fromEntries(defs.map(d => [d.key, d]));

			qsa(configTab, 'input[type="number"]').forEach(input => {
				const key = input.dataset.key;
				const def = defMap[key];
				const field = input.closest('.tm-config-field');
				const err = qs(field, '.tm-config-error');

				const showErr = (msg) => { if (err) err.textContent = msg; input.classList.add('tm-invalid'); };
				const clearErr = () => { if (err) err.textContent = ''; input.classList.remove('tm-invalid'); };

				const validate = () => {
					const r = sanitizeNumber(input.value, def);
					if (typeof r !== 'number') { showErr(r.error); return false; }
					clearErr(); return true;
				};

				on(input, 'input', validate);
				on(input, 'blur', () => {
					const r = sanitizeNumber(input.value, def);
					if (typeof r === 'number') { input.value = String(r); clearErr(); }
					else { showErr(r.error); }
				});
			});

			on(qs(configTab, '#tm-config-save'), 'click', () => {
				const newConfig = {};
				let hasErrors = false;

				for (let i = 0; i < defs.length; i++) {
					const def = defs[i];
					const input = qs(configTab, `input[data-key="${def.key}"]`);
					if (!input) continue;

					if (def.type === 'checkbox') {
						newConfig[def.key] = input.checked;
					} else {
						const r = sanitizeNumber(input.value, def);
						if (typeof r !== 'number') {
							hasErrors = true;
							const field = input.closest('.tm-config-field');
							const err = qs(field, '.tm-config-error');
							if (err) err.textContent = r.error;
							input.classList.add('tm-invalid');
						} else {
							newConfig[def.key] = r;
						}
					}
				}

				if (hasErrors) {
					notify.error('Исправьте ошибки');
					return;
				}

				newConfig.MANAGER_BUTTON_POSITION = posDD.getValue() || 'bottom-left';

				const key = getConfigStorageKey(currentConfigScope);
				const prevCfg = safeGet(key, {}) || {};
				const needsReload = defs.some(d => d.needsReload && prevCfg[d.key] !== newConfig[d.key]);

				safeSet(key, { ...prevCfg, ...newConfig });
				Object.assign(CONFIG, newConfig);
				setPreferredConfigScope(currentConfigScope);
				reprocessAffectedPosts();

				if (needsReload) notify.warning('Сохранено. Перезагрузите страницу');
				else notify.success('Сохранено');
			});
		};

		renderConfig();
	};
})();


// ---------- MAIN INITIALIZATION ----------
let mPosts, sample, proto;
const main = () => {
    const hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    const narrowScreen = globalThis.innerWidth <= 768;
    const mobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    const container = document.createElement('div');
    container.id = 'tm-helper-button';
    container.className = `tm-helper-pos-${loadConfigFromStorage(getPreferredConfigScope()).MANAGER_BUTTON_POSITION}`;
    container.innerHTML = `<button class="${((hasTouch && narrowScreen) || mobileUA) ? 'button_mob' : 'tm-button'}" id="tm-management-btn" type="button">☰</button>`;

    let el = document.getElementById(TM_STYLE_ID);
	if (!el) {
		el = document.createElement('style');
		el.id = TM_STYLE_ID;
		el.type = 'text/css';
		el.textContent = TM_STYLE;
		for (let i = 0; i < KELLY_LEN; i++) el.textContent += `.kelly-${i}{color:${KELLY_COLORS[i]}}`;
		document.head.appendChild(el);
	}

    document.documentElement.classList.toggle('tm-fade-collapsed-on', CONFIG.FADE_COLLAPSED_POSTS);
    document.documentElement.classList.toggle('tm-details-on', CONFIG.DETAILS_REFORMAT);
    document.documentElement.classList.toggle('tm-trunc-on', CONFIG.TRUNCATE_REPLY_LINKS);

    document.body.appendChild(container);
    document.getElementById('tm-management-btn').addEventListener('click', () => openModal('threads'));

    stateManager.loadState();
    filterEngine.compileActiveFilters();
    postProcessor.initialize();
    crossTabSync.initialize();

    globalThis.addEventListener('beforeunload', () => opsManager.scheduleSave.flush());
    globalThis.addEventListener('pagehide', () => opsManager.scheduleSave.flush());

    // makaba
    const origFetchPosts = proto.fetchPosts;
    proto.fetchPosts = function(param, callback, attempt = 1) {
        const cb = (typeof callback === 'function') ? callback : () => {};
        const wrappedCb = (result) => {
            const ret = cb(result);
            try {
                if (!result) return ret;
                if (CONFIG.KEEP_REMOVED_POSTS && Array.isArray(result.deleted)) {
                    for (const p of result.deleted) {
                        const el = Post.get(p.num)?.el;
                        if (el) opsManager.queueWrite(el, { classAdd: 'tm-post_type_mocha_sosat' });
                    }
                    delete result.deleted;
                }
                if (Array.isArray(result.data)) {
                    for (const p of result.data) postProcessor.registerNewPost(p);
                    return;
                }
                if (Array.isArray(result)) {
                    for (const t of result) {
                        if (!t || !Array.isArray(t.posts)) continue;
                        for (const p of t.posts) postProcessor.registerNewPost(p);
                    }
                }
            } catch (e) {
                console.error('[abufilter] Failed to fetch posts:', { source: 'proto.fetchPosts', error: e, stack: e?.stack });
            }
            return ret;
        };
        return origFetchPosts.call(this, param, wrappedCb, attempt);
    };

    const origHighlightMyPosts = proto.highlight_myposts_replies;
    proto.highlight_myposts_replies = function(p) {
        const post = Post.get(this.num);
        if (post?.el) {
            opsManager.queueWrite(post.el, { classRemove: 'post_type_replied', classAdd: 'post_type_replied' });
            return;
        }
        return origHighlightMyPosts.call(this, p);
    };

    const origHide = proto.hide;
    proto.hide = function(store, reason) {
		const post = Post.get(this.num);
		if (!post) return origHide.call(this, store, reason);

        if (post.isHeader) {
            postProcessor.toggleHidden(post, true, {
                reason: 'manual',
                fullText: post.allP,
                time: Date.now()
            });
        } else {
			stateManager.deletePassthrough(post.num);
            if (postProcessor.processPost(post)) {
                postProcessor.toggleCollapsed(post, true, {
                    reason: 'manual',
                    time: Date.now(),
                    propagateTaint: CONFIG.PROPAGATE_TAINT_BY_DEFAULT
                });
            }
        }
        return false;
    };

    const origUnhide = proto.unhide;
    proto.unhide = function() {
		const post = Post.get(this.num);
		if (!post) return origUnhide.call(this);

        if (post.isHeader) postProcessor.toggleHidden(post, false);
        else postProcessor.toggleCollapsed(post, false);

        return origUnhide.call(this);
    };

    const origFavAdd = unsafeWindow.Favorites.add;
    unsafeWindow.Favorites.add = function(num) {
        if (stateManager.isWhitelisted(String(num))) postProcessor.toggleWhitelist(num, false);
		else postProcessor.toggleWhitelist(Post.get(num) || num, true);
        return origFavAdd.call(this, num);
    };

    const origFavRemove = unsafeWindow.Favorites.remove;
    unsafeWindow.Favorites.remove = function(num) {
        if (stateManager.isWhitelisted(String(num))) postProcessor.toggleWhitelist(num, false);
        return origFavRemove.call(this, num);
    };

    const hk = () => {
        const originalStage = unsafeWindow.Stage;
        unsafeWindow.Stage = function(name, id, type, cb) {
            if (id === 'postpreview' && typeof cb === 'function') {
                const m = cb.toString().match(/^[^{]*\{([\s\S]*)\}$/);
                if (m) {
                    return originalStage.call(this, name, id, type, () => {
                        new Function(m[1].replace(/var\s+funcPostPreview\s*=\s*function/, 'globalThis.funcPostPreview = function')).call(this);
                        const timers = new Map();
                        const origFuncPostPreview = unsafeWindow.funcPostPreview;
                        unsafeWindow.funcPostPreview = function(htm) {
                            const num = htm.match(/id="(\d+)"/)?.[1];
                            if (!num) return origFuncPostPreview.call(this, htm);
                            opsManager.queueJsOp('preview:init', () => {
                                const post = Post.getPreview(num);
                                if (!post) return;
                                if (greyscale) {
                                    const key = num + 'p';
                                    const prev = timers.get(key);
                                    if (prev) { clearTimeout(prev); timers.delete(key); }
                                    timers.set(num + 'p', setTimeout(() => {
                                        timers.delete(key);
                                        const id = post.num;
                                        if (post.el?.isConnected) {
                                            if (!stateManager.isSeen(id)) postProcessor.toggleSeen(id, true);
                                            const links = document.querySelectorAll('.post_preview .post-reply-link, .post_preview a.js-post-reply-btn.post__reflink') || [];
                                            for (let i = 0; i < links.length; ++i) {
                                                const l = links[i];
                                                if (stateManager.isSeen(String(l.dataset.num || ''))) opsManager.queueWrite(l, { classAdd: 'tm-clicked' });
                                            }
                                        }
                                    }, CONFIG.PREVIEW_GREYSCALE_DELAY));
                                }
                                postProcessor.processNewPost(post);
                            });
                            return origFuncPostPreview.call(this, htm);
                        };
                        if (greyscale) {
                            document.getElementById('js-posts').addEventListener('mouseover', (e) => {
                                const link = e.target.closest('.post-reply-link');
                                if (!link) return;
                                const id = String(link.dataset.num || '');
                                if (id) {
                                    const key = id + 'l';
                                    const prev = timers.get(key);
                                    if (prev) { clearTimeout(prev); timers.delete(key); }
                                    timers.set(id + 'l', setTimeout(() => {
                                        timers.delete(key);
                                        const post = Post.getPreview(id);
                                        if (post && post.el?.isConnected) {
                                            const pid = String(link.closest('.post[data-num]')?.dataset.num || '');
                                            if (pid && !stateManager.isSeen(pid)) postProcessor.toggleSeen(pid, true);
                                        }
                                    }, CONFIG.PREVIEW_GREYSCALE_DELAY));
                                }
                            });
                        }
                    });
                }
            }
            return originalStage.call(this, name, id, type, cb);
        };
    };

    if (typeof unsafeWindow.Stage !== 'undefined') {
        hk();
    } else {
        let postValue;
        Object.defineProperty(unsafeWindow, 'Stage', {
            configurable: true,
            enumerable: true,
            set(value) {
                postValue = value;
                Object.defineProperty(unsafeWindow, 'Stage', {
                    value: postValue,
                    writable: true,
                    configurable: true,
                    enumerable: true
                });
                hk();
            },
            get() {
                return postValue;
            }
        });
    }

    if (trunc || colorize) {
        proto._generateReplyLink = function(id) {
            const n = trunc ? String((document.getElementById('post-details-' + id)?.querySelector('.post__number')?.textContent || id)).slice(-keep) : String(id)
            const threadId = mPosts[id].thread;

            let cls = 'post-reply-link ';
            if (colorize) {
                if (greyscale && stateManager.isSeen(n)) cls += 'tm-clicked';
                else cls += KELLY[n % KELLY_LEN];
            } else if (greyscale && stateManager.isSeen(n)) {
                cls += 'tm-clicked';
            }

            return '<a ' +
                'class="' + cls + '" ' +
                'data-num="' + id + '" ' +
                'data-thread="' + threadId + '" ' +
                'href="/' + BOARD_ID + '/res/' + threadId + '.html#' + id + '">' +
                '&gt;&gt;' + n +
                '</a> ';
        };
    }
};

if (typeof unsafeWindow.Post !== 'undefined') {
    sample = unsafeWindow.Post(1);
    if (!sample) { console.warn('[abufilter] Makaba Post() factory returned nothing'); return; }
    proto = Object.getPrototypeOf(sample);
    try { mPosts = sample.getPostsObj(); }
    catch (e) { console.error('[abufilter] Failed to grab posts obj:', { source: 'unsafeWindow.Post', error: e, stack: e?.stack }); return; }
    main();
} else {
	let postValue;
	Object.defineProperty(unsafeWindow, 'Post', {
		configurable: true,
		enumerable: true,
		set(value) {
			postValue = value;
			Object.defineProperty(unsafeWindow, 'Post', {
				value: postValue,
				writable: true,
				configurable: true,
				enumerable: true
			});
            sample = unsafeWindow.Post(1);
            if (!sample) { console.warn('[abufilter] Makaba Post() factory returned nothing'); return; }
            proto = Object.getPrototypeOf(sample);
            try { mPosts = sample.getPostsObj(); }
            catch (e) { console.error('[abufilter] Failed to grab posts obj:', { source: 'unsafeWindow.Post', error: e, stack: e?.stack }); return; }
            main();
		},
		get() {
			return postValue;
		}
	});
}


})();
