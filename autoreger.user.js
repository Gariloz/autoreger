// ==UserScript==
// @name         autoreger
// @namespace    http://tampermonkey.net/
// @version      5.2
// @description  Универсальный автозаполнитель регистрации: инкремент логина, пароль в оба поля, клик по кнопке, отдача только подтверждённых аккаунтов, без дублей
// @match        *://*/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================================
       CONFIG — меняется под свой сайт
       ============================================================ */
    const CONFIG = {
        loginSelectors: [
            'input[type="email"]',
            'input[name="email"]',
            'input[autocomplete="username"]',
            'input[name*="login"]',
            'input[id*="login"]',
        ],
        passwordSelector: 'input[type="password"]',
        submitSelector: 'button[type="submit"], input[type="submit"]',
        submitText: /create\s*account|sign\s*up|register|join|зарегистрир|создать\s*аккаунт|регистрац/i,
        signupLinkSelectors: ['a[href*="signup"]', 'a[href*="register"]', 'a[href*="registration"]'],
        signupLinkText: /create\s*an?\s*account|sign\s*up|register|регистрац/i,
        signupPagePattern: /sign[-_]?up|register|registration/i,
        signupUrl: '',
        submitDelay: 300,

        // Сколько ждать подтверждения успеха после клика (мс).
        successWaitMs: 8000,
        // Если сайт НЕ редиректит и не показывает сообщение об успехе —
        // поставь true, чтобы считать успехом по истечении ожидания.
        // По умолчанию false = безопаснее (неудачные не попадают в отдачу).
        commitOnTimeout: false,

        // Фразы-ОШИБКИ → аккаунт не создан, в отдачу НЕ писать, счётчик НЕ увеличивать.
        errorText: /already\s*(exists|registered|in\s*use|taken)|уже\s*(существует|зарегистрирован|занят)|\bexists\b|\btaken\b|duplicate|дубликат|invalid|неверн|некоррект|ошибк|\berror\b|failed|failure|не\s*удалось|unable|невозможн|rejected|отклонен|denied|too\s*many|слишком\s*много|try\s*again|rate[\s-]*limit|лимит|превышен|попробуйте\s*(позже|завтра)|повторите\s*попытку|captcha|каптч|blocked|заблокирован|suspended|ограничен/i,
        // Фразы-УСПЕХА → подтверждение создания.
        successText: /success|created|welcome|успеш|создан|добро\s*пожаловать|готово|account\s*created|registration\s*complete/i,
    };
    /* ============================================================ */

    const hostKey = location.host;

    let template = GM_getValue('template', '');
    let current  = GM_getValue('current', template);
    let password = GM_getValue('password', '');
    let log      = GM_getValue('log', '');
    let autoNav  = GM_getValue('autoNav_' + hostKey, false);
    let hidden   = GM_getValue('hidden_' + hostKey, false);
    let lastAutoNav = 0;
    let flashTimer = null;
    let registering = false;
    let pending = null; // { login, pass, time, startUrl }

    function nextValue(str) {
        const at = str.indexOf('@');
        const local  = at === -1 ? str : str.slice(0, at);
        const domain = at === -1 ? ''  : str.slice(at);
        const m = local.match(/^(.*?)(\d+)(\D*)$/);
        if (m) {
            const next = String(Number(m[2]) + 1).padStart(m[2].length, '0');
            return m[1] + next + m[3] + domain;
        }
        return local + '1' + domain;
    }

    function setNativeValue(input, value) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function findLoginInput() {
        for (const sel of CONFIG.loginSelectors) {
            const el = [...document.querySelectorAll(sel)].find(i => !panel.contains(i));
            if (el) return el;
        }
        return null;
    }

    function findPasswordInputs() {
        return [...document.querySelectorAll(CONFIG.passwordSelector)].filter(i => !panel.contains(i));
    }

    function findSubmitButton() {
        const candidates = [...document.querySelectorAll(CONFIG.submitSelector)].filter(b => !panel.contains(b));
        return candidates.find(b => CONFIG.submitText.test(b.textContent || b.value || '')) || candidates[0] || null;
    }

    function findSignupLink() {
        for (const sel of CONFIG.signupLinkSelectors) {
            const el = document.querySelector(sel);
            if (el && !panel.contains(el)) return el;
        }
        return [...document.querySelectorAll('a')].find(a => !panel.contains(a) && CONFIG.signupLinkText.test(a.textContent)) || null;
    }

    function onSignupPage() {
        return CONFIG.signupPagePattern.test(location.href);
    }

    // ===== панель =====
    const style = document.createElement('style');
    style.textContent = `
        #gm-panel button, #gm-badge { transition: transform .1s ease, filter .15s ease; }
        #gm-panel button:hover, #gm-badge:hover { filter: brightness(1.15); }
        #gm-panel button:active, #gm-badge:active { transform: scale(.96); }
        #gm-panel textarea:focus { border-color: #4f46e5 !important; }
        #gm-panel::-webkit-scrollbar, #gm-panel textarea::-webkit-scrollbar { width: 8px; }
        #gm-panel::-webkit-scrollbar-track, #gm-panel textarea::-webkit-scrollbar-track { background: #111; }
        #gm-panel::-webkit-scrollbar-thumb, #gm-panel textarea::-webkit-scrollbar-thumb { background: #3a3a44; border-radius: 4px; }
        #gm-panel::-webkit-scrollbar-thumb:hover, #gm-panel textarea::-webkit-scrollbar-thumb:hover { background: #4f46e5; }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'gm-panel';
    panel.style.cssText = 'position:fixed;top:120px;right:20px;z-index:999999;background:#1c1c22;border:1px solid #3a3a44;border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;width:250px;max-height:calc(100vh - 140px);overflow-y:auto;box-shadow:0 4px 16px rgba(0,0,0,.5);font-family:sans-serif;';
    panel.innerHTML = `
        <div style="height:3px;border-radius:2px;background:linear-gradient(90deg,#4f46e5,#22d3ee,#16a34a);"></div>
        <div style="display:flex;align-items:center;justify-content:space-between;">
            <div style="color:#e4e4ec;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">autoreger</div>
            <div style="display:flex;align-items:center;gap:6px;">
                <div style="color:#6b6b76;font-size:10px;">v5.2</div>
                <button id="gm-hide" type="button" title="Скрыть панель на этом сайте"
                        style="padding:2px 8px;background:#333;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:13px;line-height:1;">–</button>
            </div>
        </div>

        <div style="color:#9a9aa5;font-size:11px;text-transform:uppercase;">Логин + пароль (2 строки)</div>
        <textarea id="gm-creds" rows="2" spellcheck="false" placeholder="login320@mail.ru&#10;пароль"
                  style="background:#111;border:1px solid #3a3a44;border-radius:6px;color:#fff;padding:8px;font-size:13px;line-height:1.45;outline:none;resize:none;font-family:inherit;"></textarea>
        <div style="display:flex;gap:6px;">
            <button id="gm-ins-login" type="button"
                    style="flex:1;padding:8px;background:#4f46e5;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:13px;">Вставить логин</button>
            <button id="gm-rst" type="button" title="Вернуть запомненное значение"
                    style="padding:8px 10px;background:#333;color:#fff;border:0;border-radius:6px;cursor:pointer;">↺</button>
        </div>
        <div id="gm-next" style="color:#9a9aa5;font-size:12px;word-break:break-all;"></div>
        <div id="gm-mem"  style="color:#6b6b76;font-size:12px;word-break:break-all;"></div>

        <button id="gm-ins-pass" type="button"
                style="padding:8px;background:#4f46e5;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:13px;">Вставить пароль (в оба поля)</button>

        <div style="border-top:1px solid #3a3a44;margin:4px 0;"></div>

        <button id="gm-ins-all" type="button"
                style="padding:9px;background:#16a34a;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:bold;">Вставить всё</button>

        <div style="border-top:1px solid #3a3a44;margin:4px 0;"></div>

        <div style="color:#9a9aa5;font-size:11px;text-transform:uppercase;">Регистрация</div>
        <button id="gm-register" type="button" title="Логин + пароль + клик по кнопке регистрации"
                style="padding:9px;background:#d97706;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:bold;">Создать аккаунт →</button>
        <label style="display:flex;align-items:center;gap:6px;color:#9a9aa5;font-size:12px;cursor:pointer;">
            <input id="gm-auto" type="checkbox" style="accent-color:#4f46e5;cursor:pointer;">
            авто-возврат на регистрацию
        </label>

        <div style="border-top:1px solid #3a3a44;margin:4px 0;"></div>

        <div id="gm-log-label" style="color:#9a9aa5;font-size:11px;text-transform:uppercase;">Отдача · 0</div>
        <textarea id="gm-log" rows="6" readonly spellcheck="false" placeholder="здесь появятся созданные аккаунты"
                  style="background:#0d0d11;border:1px solid #3a3a44;border-radius:6px;color:#d4d4dc;padding:8px;font-size:12px;line-height:1.45;outline:none;resize:vertical;font-family:monospace;"></textarea>
        <div style="display:flex;gap:6px;">
            <button id="gm-copy" type="button"
                    style="flex:1;padding:8px;background:#0ea5e9;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:13px;">Копировать</button>
            <button id="gm-clear" type="button" title="Очистить отдачу"
                    style="padding:8px 10px;background:#333;color:#fff;border:0;border-radius:6px;cursor:pointer;">✕</button>
        </div>

        <div id="gm-status" style="font-size:12px;min-height:15px;word-break:break-all;"></div>
    `;
    document.body.appendChild(panel);

    const badge = document.createElement('button');
    badge.id = 'gm-badge';
    badge.type = 'button';
    badge.textContent = '⚡ autoreger';
    badge.title = 'Показать панель';
    badge.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999999;padding:8px 14px;background:#1c1c22;color:#e4e4ec;border:1px solid #4f46e5;border-radius:20px;cursor:pointer;font-size:12px;font-family:sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.5);display:none;';
    document.body.appendChild(badge);

    const ta        = panel.querySelector('#gm-creds');
    const nextLabel = panel.querySelector('#gm-next');
    const memLabel  = panel.querySelector('#gm-mem');
    const statusEl  = panel.querySelector('#gm-status');
    const autoChk   = panel.querySelector('#gm-auto');
    const logTa     = panel.querySelector('#gm-log');
    const logLabel  = panel.querySelector('#gm-log-label');
    const regBtn    = panel.querySelector('#gm-register');
    const regBtnLabel = 'Создать аккаунт →';
    autoChk.checked = autoNav;
    logTa.value = log;
    logTa.scrollTop = logTa.scrollHeight;

    function setHidden(v) {
        hidden = v;
        GM_setValue('hidden_' + hostKey, v);
        panel.style.display = v ? 'none' : 'flex';
        badge.style.display = v ? 'flex' : 'none';
    }
    setHidden(hidden);

    function syncTextarea() {
        ta.value = (current || password) ? current + '\n' + password : '';
    }
    syncTextarea();

    function flash(msg, ok = true) {
        statusEl.textContent = msg;
        statusEl.style.color = ok ? '#4ade80' : '#f87171';
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => { statusEl.textContent = ''; }, 4000);
    }

    function updateLabels() {
        nextLabel.textContent = current  ? '→ вставится: ' + current : '→ введи логин в 1-й строке';
        memLabel.textContent  = template ? '↺ сброс: ' + template    : '↺ сброс: —';
    }
    updateLabels();

    function updateLogLabel() {
        const n = log ? log.split(/\n\s*\n/).filter(s => s.trim()).length : 0;
        logLabel.textContent = 'Отдача · ' + n;
    }
    updateLogLabel();

    function setRegBusy(v) {
        regBtn.disabled = v;
        regBtn.textContent = v ? 'Жду ответ…' : regBtnLabel;
        regBtn.style.opacity = v ? '0.6' : '1';
        regBtn.style.cursor = v ? 'wait' : 'pointer';
    }

    // Запись в отдачу с защитой от дублей (один логин — одна запись).
    function appendLog(login, pass) {
        const blocks = log ? log.split(/\n{2,}/).filter(b => b.trim()) : [];
        const exists = blocks.some(b => b.split('\n')[0].trim() === login);
        if (!exists) {
            blocks.push(login + '\n' + pass);
            log = blocks.join('\n\n');
            GM_setValue('log', log);
        }
        logTa.value = log;
        logTa.scrollTop = logTa.scrollHeight;
        updateLogLabel();
    }

    // ===== подтверждение / отклонение регистрации =====
    function commitPending() {
        if (!pending) return;
        const { login, pass } = pending;
        pending = null;
        setRegBusy(false);
        current = nextValue(login);
        GM_setValue('current', current);
        syncTextarea();
        updateLabels();
        appendLog(login, pass);
        flash('Создан ✓ ' + login);
    }

    function failPending(text) {
        if (!pending) return;
        pending = null;
        setRegBusy(false);
        const short = String(text).replace(/\s+/g, ' ').trim().slice(0, 90);
        flash('Не создано: ' + short + ' — счётчик не увеличен, в отдачу не записано', false);
    }

    function watchPending() {
        if (!pending) return;
        // Уход со страницы регистрации (редирект) = успех.
        if (location.href !== pending.startUrl) { commitPending(); return; }
        if (Date.now() - pending.time >= CONFIG.successWaitMs) {
            if (CONFIG.commitOnTimeout) {
                commitPending();
            } else {
                const login = pending.login;
                pending = null;
                setRegBusy(false);
                flash('Не подтверждено: ' + login + ' — проверь вручную, в отдачу не записано', false);
            }
        }
    }

    function scanDomMessages() {
        if (!pending) return;
        const sels = '[role="alert"],[role="status"],[class*="error"],[class*="alert"],[class*="toast"],[class*="notification"],[class*="message"],[class*="success"],[data-error]';
        for (const el of document.querySelectorAll(sels)) {
            if (panel.contains(el) || badge.contains(el)) continue;
            if (!el.getClientRects().length) continue;
            const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!txt || txt.length > 300) continue;
            if (CONFIG.errorText.test(txt) && !CONFIG.successText.test(txt)) { failPending(txt); return; }
            if (CONFIG.successText.test(txt)) { commitPending(); return; }
        }
    }

    function onSiteAlert(text) {
        if (!pending) return;
        if (CONFIG.errorText.test(text) && !CONFIG.successText.test(text)) failPending(text);
        else if (CONFIG.successText.test(text)) commitPending();
    }

    // Перехват alert() сайта — работает и в песочнице, и в контексте страницы.
    (function installAlertHook() {
        const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        const evt = '__autoreger_alert';
        try {
            const s = document.createElement('script');
            s.textContent = '(' + function () {
                if (window.__autoregerAlertHooked) return;
                window.__autoregerAlertHooked = true;
                const orig = window.alert;
                window.alert = function (msg) {
                    try { window.dispatchEvent(new CustomEvent('__autoreger_alert', { detail: String(msg == null ? '' : msg) })); } catch (e) {}
                    return orig.apply(this, arguments);
                };
            } + ')();';
            (document.head || document.documentElement).appendChild(s);
            s.remove();
        } catch (e) {}
        try {
            if (!w.__autoregerAlertHooked) {
                const orig = w.alert;
                w.alert = function (msg) {
                    try { w.dispatchEvent(new CustomEvent('__autoreger_alert', { detail: String(msg == null ? '' : msg) })); } catch (e) {}
                    return orig.apply(this, arguments);
                };
                w.__autoregerAlertHooked = true;
            }
        } catch (e) {}
        w.addEventListener(evt, (e) => onSiteAlert(String((e && e.detail) || '')));
    })();

    // ===== обработчики панели =====
    ta.addEventListener('input', () => {
        const lines = ta.value.split(/\r?\n/);
        const loginLine = (lines[0] || '').trim();
        password = lines.length > 1 ? lines[1] : '';
        GM_setValue('password', password);
        if (loginLine !== current) {
            template = loginLine;
            current = loginLine;
            GM_setValue('template', template);
            GM_setValue('current', current);
        }
        updateLabels();
    });

    autoChk.addEventListener('change', () => {
        autoNav = autoChk.checked;
        GM_setValue('autoNav_' + hostKey, autoNav);
        flash(autoNav ? 'Авто-возврат включён' : 'Авто-возврат выключен');
    });

    function insertLogin(silent) {
        if (!current) { flash('Введи логин в 1-й строке', false); ta.focus(); return false; }
        const input = findLoginInput();
        if (!input) { flash('Поле логина не найдено — проверь CONFIG.loginSelectors', false); return false; }
        const value = current;
        input.focus();
        setNativeValue(input, value);
        current = nextValue(current);
        GM_setValue('current', current);
        syncTextarea();
        updateLabels();
        if (!silent) flash('Вставлено: ' + value);
        return value;
    }

    function insertPassword(silent) {
        if (!password) { flash('Введи пароль во 2-й строке', false); ta.focus(); return false; }
        const inputs = findPasswordInputs();
        if (!inputs.length) { flash('Поля пароля не найдены — проверь CONFIG.passwordSelector', false); return false; }
        inputs.forEach(i => setNativeValue(i, password));
        if (!silent) flash('Пароль вставлен в оба поля');
        return true;
    }

    // Регистрация: заполнить → клик → ждать подтверждения. В отдачу — только успех.
    function registerAccount() {
        if (registering || pending) return;
        if (!current) { flash('Введи логин в 1-й строке', false); ta.focus(); return; }
        if (!password) { flash('Введи пароль во 2-й строке', false); ta.focus(); return; }
        const loginInput = findLoginInput();
        if (!loginInput) { flash('Поле логина не найдено — проверь CONFIG.loginSelectors', false); return; }
        const passInputs = findPasswordInputs();
        if (!passInputs.length) { flash('Поля пароля не найдены — проверь CONFIG.passwordSelector', false); return; }

        const usedLogin = current;
        const usedPass = password;
        loginInput.focus();
        setNativeValue(loginInput, usedLogin);
        passInputs.forEach(i => setNativeValue(i, usedPass));

        registering = true;
        flash('Поля заполнены, отправляю…');
        setTimeout(() => {
            registering = false;
            const btn = findSubmitButton();
            if (!btn) { flash('Кнопка не найдена — проверь CONFIG.submitSelector', false); return; }
            if (btn.disabled) { flash('Кнопка неактивна — проверь поля', false); return; }
            pending = { login: usedLogin, pass: usedPass, time: Date.now(), startUrl: location.href };
            setRegBusy(true);
            flash('Отправлено, жду ответ сайта…');
            btn.click();
        }, CONFIG.submitDelay);
    }

    function goToSignup(auto) {
        const link = findSignupLink();
        if (link) {
            link.click();
            flash(auto ? 'Авто-возврат на регистрацию…' : 'Переход к регистрации…');
            return true;
        }
        if (CONFIG.signupUrl && !onSignupPage()) {
            location.href = CONFIG.signupUrl;
            return true;
        }
        if (!auto) flash('Ссылка на регистрацию не найдена', false);
        return false;
    }

    panel.querySelector('#gm-hide').addEventListener('click', () => setHidden(true));
    badge.addEventListener('click', () => setHidden(false));
    panel.querySelector('#gm-ins-login').addEventListener('click', () => insertLogin(false));
    panel.querySelector('#gm-ins-pass').addEventListener('click', () => insertPassword(false));
    panel.querySelector('#gm-ins-all').addEventListener('click', () => {
        const okL = insertLogin(true);
        const okP = insertPassword(true);
        if (okL && okP) flash('Логин и пароль вставлены ✓');
    });
    panel.querySelector('#gm-rst').addEventListener('click', () => {
        current = template;
        GM_setValue('current', current);
        syncTextarea();
        updateLabels();
        flash('Сброшено к: ' + (template || '—'));
    });
    regBtn.addEventListener('click', registerAccount);

    panel.querySelector('#gm-copy').addEventListener('click', () => {
        if (!log) { flash('Отдача пока пустая', false); return; }
        GM_setClipboard(log, 'text');
        flash('Скопировано в буфер ✓');
    });
    panel.querySelector('#gm-clear').addEventListener('click', () => {
        if (!log) return;
        if (!confirm('Очистить отдачу?')) return;
        log = '';
        GM_setValue('log', log);
        logTa.value = '';
        updateLogLabel();
        flash('Отдача очищена');
    });

    setInterval(() => {
        if (!document.body.contains(panel)) document.body.appendChild(panel);
        if (!document.body.contains(badge)) document.body.appendChild(badge);
        watchPending();
        scanDomMessages();
        if (autoNav && Date.now() - lastAutoNav > 3000 && !onSignupPage() && findSignupLink()) {
            lastAutoNav = Date.now();
            goToSignup(true);
        }
    }, 500);
})();
